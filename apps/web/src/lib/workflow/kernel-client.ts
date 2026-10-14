/**
 * The one client every door uses to run a kernel command
 * (docs/specs/workflow-kernel-library.md §3). A door never calls the seam's
 * command functions itself: it calls `submitKernelCommand(op, input, ...)`.
 *
 * Where the command runs:
 *  - on the control plane (the Worker's own handlers, the command endpoint):
 *    here, locally, it is the host;
 *  - on the web host in `shadow`: here, locally, through the same package, as
 *    before the control plane hosted the kernel;
 *  - on the web host in `own`: submitted to the control plane's command
 *    endpoint (command-api.ts), signed, with an idempotency key that every
 *    retry reuses, and its answer returned. If the control plane does not
 *    answer, the door gets `ControlPlaneUnavailableError` (retryable) and
 *    nothing is applied here (AC-12). Lockstep is not consulted: a door that
 *    sees the two hosts on different commits still submits, because the
 *    control plane is the authority.
 *
 * The mode is one setting, the control plane's `EXECUTION_MODE`: the web host
 * follows what the Worker's health reports (cached briefly), so flipping the
 * Worker to `shadow` is the whole rollback. `EXECUTION_MODE` set on the web
 * host overrides that (tests, a local e2e); off Vercel with nothing set the
 * web host runs the package itself, since there is no control plane to follow.
 */
import { signRequest, signingKey } from '@buildd/dispatch-contract';
import { getControlPlaneIdentity } from '@/lib/deploy-identity';
import { kernelHost, type KernelHost } from './kernel-host';
import {
  COMMAND_API_VERSION, COMMAND_PATH, commandKeyRing, deliveryAfter, executionModeOf, runKernelOp,
  type CommandAnswer, type CommandRequest, type DeliveryVersion, type KernelOp, type KernelOps, type KernelPrincipal,
} from './command-api';

export type { KernelOp, KernelOps, KernelPrincipal, DeliveryVersion } from './command-api';

export const CONTROL_PLANE_URL = 'https://control-plane.buildd.dev';

/** The control plane did not answer: nothing was applied. Retry later; the door says so. */
export class ControlPlaneUnavailableError extends Error {
  readonly code = 'control_plane_unavailable';
  readonly retryable = true;
  constructor(readonly why: string) {
    super(`The control plane did not answer (${why}), so nothing was applied. Try again in a moment.`);
    this.name = 'ControlPlaneUnavailableError';
  }
}

/** The control plane refused the command itself (auth, shape): a bug, not an outage. Nothing was applied. */
export class KernelCommandRefusedError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(`The control plane refused the command (${status} ${String(body.code ?? '')}): ${String(body.error ?? '')}`);
    this.name = 'KernelCommandRefusedError';
  }
}

/** A door's answer when the control plane is unreachable (AC-12): retryable, naming the control plane. */
export function controlPlaneUnavailableResponse(err: ControlPlaneUnavailableError): Response {
  return new Response(JSON.stringify({ error: err.message, code: err.code, retryable: true, controlPlane: true }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'Retry-After': '5', 'Cache-Control': 'no-store' },
  });
}

export type KernelMode = 'own' | 'shadow';

export interface ClientDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  host?: () => KernelHost;
  /** The control plane's mode as its health reports it; null = no answer. */
  readMode?: () => Promise<string | null>;
  run?: typeof runKernelOp;
  deliveryAfter?: typeof deliveryAfter;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newKey?: () => string;
}

// ── The mode ────────────────────────────────────────────────────────────────

/** A fresh reading is trusted this long; after that it is re-read. */
export const MODE_FRESH_MS = 30_000;
/** A reading may stand in for a failed re-read this long. Past it, no answer reads as `own`. */
export const MODE_STALE_MS = 5 * 60_000;

let cached: { mode: KernelMode; at: number } | null = null;

/** Tests. */
export function resetKernelModeCache(): void { cached = null; }

const readWorkerMode = async (): Promise<string | null> => (await getControlPlaneIdentity())?.mode ?? null;

/**
 * Where kernel commands run, as seen from this process. On the control plane:
 * its own `EXECUTION_MODE`. On the web host: an explicit `EXECUTION_MODE`, else
 * `shadow` off Vercel, else the Worker's reported mode; an unreachable Worker
 * with no recent reading is `own`, so a door fails retryably rather than
 * applying a command the control plane may also be applying.
 */
export async function kernelMode(deps: ClientDeps = {}): Promise<KernelMode> {
  const env = deps.env ?? process.env;
  if ((deps.host ?? kernelHost)() === 'control-plane') return executionModeOf(env.EXECUTION_MODE);
  if (env.EXECUTION_MODE === 'own' || env.EXECUTION_MODE === 'shadow') return env.EXECUTION_MODE;
  if (!env.VERCEL) return 'shadow';
  const now = (deps.now ?? Date.now)();
  if (cached && now - cached.at < MODE_FRESH_MS) return cached.mode;
  const read = await (deps.readMode ?? readWorkerMode)().catch(() => null);
  if (read !== null) {
    cached = { mode: executionModeOf(read), at: now };
    return cached.mode;
  }
  if (cached && now - cached.at < MODE_STALE_MS) return cached.mode;
  return 'own';
}

/** True when this process applies kernel commands and drains effects itself. */
export async function hostsKernelHere(deps: ClientDeps = {}): Promise<boolean> {
  if ((deps.host ?? kernelHost)() === 'control-plane') return (await kernelMode(deps)) === 'own';
  return (await kernelMode(deps)) === 'shadow';
}

// ── Submitting ──────────────────────────────────────────────────────────────

export interface SubmitOptions {
  principal: KernelPrincipal;
  /** The caller's key; the same key on a retry gets the same answer. Absent: one is made for this call. */
  idempotencyKey?: string;
  /** Overall budget for reaching the control plane, retries included. */
  budgetMs?: number;
  deps?: ClientDeps;
}

export interface KernelAnswer<K extends KernelOp> {
  result: KernelOps[K]['result'];
  delivery: DeliveryVersion | null;
  host: KernelHost;
  replayed: boolean;
  idempotencyKey: string;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** A door's idempotency key: the caller's (`Idempotency-Key` header), else a fresh one for this call. */
export function newIdempotencyKey(op: KernelOp): string {
  return `${op}:${crypto.randomUUID()}`;
}

/** Run one kernel command where the kernel is hosted, and return its answer. */
export async function submitKernelCommand<K extends KernelOp>(op: K, input: KernelOps[K]['input'], opts: SubmitOptions): Promise<KernelAnswer<K>> {
  const deps = opts.deps ?? {};
  const idempotencyKey = opts.idempotencyKey ?? (deps.newKey ?? (() => newIdempotencyKey(op)))();
  if (await hostsKernelHere(deps)) return runHere(op, input, idempotencyKey, deps);
  if ((deps.host ?? kernelHost)() === 'control-plane') {
    // The control plane in shadow: the web host is the kernel's host, and this process is not it.
    throw new ControlPlaneUnavailableError('the control plane is in shadow mode and does not apply commands');
  }
  return submitRemote(op, input, { ...opts, idempotencyKey }, deps);
}

async function runHere<K extends KernelOp>(op: K, input: KernelOps[K]['input'], idempotencyKey: string, deps: ClientDeps): Promise<KernelAnswer<K>> {
  const result = await (deps.run ?? runKernelOp)(op, input);
  const delivery = await (deps.deliveryAfter ?? deliveryAfter)(op, input, result).catch(() => null);
  return { result, delivery, host: (deps.host ?? kernelHost)(), replayed: false, idempotencyKey };
}

async function submitRemote<K extends KernelOp>(op: K, input: KernelOps[K]['input'], opts: SubmitOptions & { idempotencyKey: string }, deps: ClientDeps): Promise<KernelAnswer<K>> {
  const env = deps.env ?? process.env;
  const key = signingKey(commandKeyRing(env));
  if (!key) throw new ControlPlaneUnavailableError('no command key is configured on the web host');
  const base = (env.CONTROL_PLANE_URL || CONTROL_PLANE_URL).replace(/\/+$/, '');
  const url = new URL(COMMAND_PATH, base);
  const body = JSON.stringify({ v: COMMAND_API_VERSION, op, input, principal: opts.principal, idempotencyKey: opts.idempotencyKey } satisfies CommandRequest<K>);
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (opts.budgetMs ?? 45_000);
  let why = 'no attempt';

  for (let attempt = 0; ; attempt++) {
    const left = deadline - now();
    if (left <= 0) throw new ControlPlaneUnavailableError(why);
    let res: Response;
    try {
      const headers = await signRequest({ keyId: key.keyId, secret: key.secret, method: 'POST', path: url.pathname + url.search, body });
      res = await doFetch(url.toString(), {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(Math.min(left, 25_000)),
      });
    } catch (err) {
      why = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : `unreachable: ${err instanceof Error ? err.message : String(err)}`;
      await sleep(Math.min(250 * 2 ** attempt, 2_000));
      continue;
    }
    const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && answer && answer.v === COMMAND_API_VERSION) {
      const a = answer as unknown as CommandAnswer<K>;
      return { result: a.result, delivery: a.delivery, host: a.host, replayed: a.replayed, idempotencyKey: opts.idempotencyKey };
    }
    if (res.status === 409 && answer?.code === 'not_host') {
      // The control plane is in shadow: the web host is the host after all. Nothing was applied there.
      cached = { mode: 'shadow', at: now() };
      return runHere(op, input, opts.idempotencyKey, deps);
    }
    if (RETRYABLE_STATUS.has(res.status) || (res.status === 409 && answer?.code === 'in_progress')) {
      why = `answered ${res.status}${answer?.code ? ` ${String(answer.code)}` : ''}`;
      await sleep(Math.min(250 * 2 ** attempt, 2_000));
      continue;
    }
    throw new KernelCommandRefusedError(res.status, answer ?? {});
  }
}
