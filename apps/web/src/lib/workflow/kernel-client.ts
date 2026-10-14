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
 * Routing switches on only when `KERNEL_COMMAND_SECRET` is set on the web host:
 * without it the web host runs the package itself, exactly as before, whatever
 * either host's mode. With it, the mode is one setting, the control plane's
 * `EXECUTION_MODE`: the web host follows what the Worker's health reports
 * (cached briefly), so flipping the Worker to `shadow` is the whole rollback.
 * `EXECUTION_MODE` set on the web host overrides that (tests, a local e2e); off
 * Vercel with nothing set the web host runs the package itself, since there is
 * no control plane to follow.
 */
import { signRequest, signingKey } from '@buildd/dispatch-contract';
import { kernelHost, type KernelHost } from './kernel-host';
import {
  COMMAND_API_VERSION, COMMAND_PATH, commandKeyRing, commandsConfigured, deliveryAfter, executionModeOf, runKernelOp,
  type CommandAnswer, type CommandRequest, type DeliveryVersion, type KernelOp, type KernelOps, type KernelPrincipal,
} from './command-api';

export type { KernelOp, KernelOps, KernelPrincipal, DeliveryVersion } from './command-api';

export const CONTROL_PLANE_URL = 'https://control-plane.buildd.dev';

/**
 * The control plane did not give an answer. Retryable either way; `outcome` says what is known:
 *  - `not_applied`: nothing reached it that could apply (unreachable, refused before running);
 *  - `unknown`: a request may have reached it (a timeout, an in-progress reply, a gateway error),
 *    so the command may have been applied. Retry with the SAME `idempotencyKey`: the control plane
 *    then answers with what it did, and never applies it twice.
 */
export class ControlPlaneUnavailableError extends Error {
  readonly code = 'control_plane_unavailable';
  readonly retryable = true;
  constructor(readonly why: string, readonly outcome: 'not_applied' | 'unknown' = 'not_applied', readonly idempotencyKey: string | null = null) {
    super(outcome === 'unknown'
      ? `The control plane did not confirm the outcome (${why}); it may have been applied. Retry with the same idempotency key${idempotencyKey ? ` (${idempotencyKey})` : ''} to get its answer.`
      : `The control plane did not answer (${why}), so nothing was applied. Try again in a moment.`);
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
  return new Response(JSON.stringify({
    error: err.message, code: err.code, retryable: true, controlPlane: true, outcome: err.outcome,
    // Send it back as the Idempotency-Key header and the retry gets the control plane's answer.
    ...(err.outcome === 'unknown' && err.idempotencyKey ? { idempotencyKey: err.idempotencyKey } : {}),
  }), {
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

/**
 * The Worker's mode from its public shallow health, the same read `/api/deploy-identity`
 * makes (lib/deploy-identity.ts, which the kernel does not import): short timeout, never a throw.
 */
export async function readWorkerMode(env: Record<string, string | undefined> = process.env): Promise<string | null> {
  try {
    const res = await fetch(env.CONTROL_PLANE_HEALTH_URL || `${CONTROL_PLANE_URL}/__control-plane/health`, { signal: AbortSignal.timeout(1500), cache: 'no-store' });
    if (!res.ok) return null;
    // `kernel`, not `mode`: whether the Worker applies kernel commands (own mode AND a command key).
    // A Worker that predates the field is not switched over.
    const kernel = ((await res.json()) as { kernel?: unknown }).kernel;
    return typeof kernel === 'string' ? kernel : 'shadow';
  } catch {
    return null;
  }
}

/**
 * Where kernel commands run, as seen from this process. On the control plane:
 * its own `EXECUTION_MODE`. On the web host: an explicit `EXECUTION_MODE`, else
 * `shadow` off Vercel, else the Worker's reported mode; an unreachable Worker
 * with no recent reading is `own`, so a door fails retryably rather than
 * applying a command the control plane may also be applying.
 */
export async function kernelMode(deps: ClientDeps = {}): Promise<KernelMode> {
  const env = deps.env ?? process.env;
  // No command key on this host: nothing is routed, and this host runs the package (the switch is unset).
  if ((deps.host ?? kernelHost)() === 'control-plane') return commandsConfigured(env) ? executionModeOf(env.EXECUTION_MODE) : 'shadow';
  if (!commandsConfigured(env)) return 'shadow';
  if (env.EXECUTION_MODE === 'own' || env.EXECUTION_MODE === 'shadow') return env.EXECUTION_MODE;
  if (!env.VERCEL) return 'shadow';
  const now = (deps.now ?? Date.now)();
  if (cached && now - cached.at < MODE_FRESH_MS) return cached.mode;
  const read = await (deps.readMode ?? (() => readWorkerMode(env)))().catch(() => null);
  if (read !== null) {
    cached = { mode: executionModeOf(read), at: now };
    return cached.mode;
  }
  if (cached && now - cached.at < MODE_STALE_MS) return cached.mode;
  return 'own';
}

/**
 * True when this process applies the kernel commands it is asked for, and drains
 * inline, itself. The control plane always does (its webhook and execution
 * handlers ran the kernel before it was the only host); the web host only in shadow.
 */
export async function hostsKernelHere(deps: ClientDeps = {}): Promise<boolean> {
  if ((deps.host ?? kernelHost)() === 'control-plane') return true;
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
  if (!key) throw new ControlPlaneUnavailableError('no command key is configured on the web host', 'not_applied', opts.idempotencyKey);
  const base = (env.CONTROL_PLANE_URL || CONTROL_PLANE_URL).replace(/\/+$/, '');
  const url = new URL(COMMAND_PATH, base);
  const body = JSON.stringify({ v: COMMAND_API_VERSION, op, input, principal: opts.principal, idempotencyKey: opts.idempotencyKey } satisfies CommandRequest<K>);
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (opts.budgetMs ?? (Number(env.KERNEL_COMMAND_BUDGET_MS) || 45_000));
  let why = 'no attempt';
  // Once any request may have reached the control plane, a failure's outcome is unknown.
  let mayHaveApplied = false;

  for (let attempt = 0; ; attempt++) {
    const left = deadline - now();
    if (left <= 0) throw new ControlPlaneUnavailableError(why, mayHaveApplied ? 'unknown' : 'not_applied', opts.idempotencyKey);
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
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      // A timeout means the request was sent and nothing came back; a connection failure, that it never got there.
      if (timedOut) mayHaveApplied = true;
      why = timedOut ? 'timed out' : `unreachable: ${err instanceof Error ? err.message : String(err)}`;
      await sleep(Math.min(250 * 2 ** attempt, 2_000));
      continue;
    }
    const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && answer && answer.v === COMMAND_API_VERSION) {
      const a = answer as unknown as CommandAnswer<K>;
      return { result: a.result, delivery: a.delivery, host: a.host, replayed: a.replayed, idempotencyKey: opts.idempotencyKey };
    }
    if ((res.status === 409 && answer?.code === 'not_host') || (res.status === 503 && answer?.code === 'unconfigured')) {
      // The control plane is in shadow, or holds no command key yet (half switched over): the web host is
      // the host after all. It refused before running anything, so nothing was applied there.
      cached = { mode: 'shadow', at: now() };
      return runHere(op, input, opts.idempotencyKey, deps);
    }
    if (RETRYABLE_STATUS.has(res.status) || (res.status === 409 && answer?.code === 'in_progress')) {
      why = `answered ${res.status}${answer?.code ? ` ${String(answer.code)}` : ''}`;
      // in_progress: it is running there. A 5xx, command_failed included (a command that threw may have
      // applied part of its work before it did): it may have run. Only a 429 refused before running.
      if (res.status !== 429) mayHaveApplied = true;
      await sleep(Math.min(250 * 2 ** attempt, 2_000));
      continue;
    }
    throw new KernelCommandRefusedError(res.status, answer ?? {});
  }
}

// ── The doors' functions ────────────────────────────────────────────────────
//
// The seam's door functions, same names and inputs, run where the kernel is
// hosted. A door imports these, never the seam's own (kernel-client-doors.test.ts
// fails on a door that does). `door` names who the command is for; absent, the
// principal is read off the input's actor: `human:<user id>` is that person,
// anything else (`agent:…`, `system:…`, `rule:…`) a system principal named by it.

export interface DoorCall {
  principal?: KernelPrincipal;
  /** The caller's key (an `Idempotency-Key` header); absent, one is made for this call. */
  idempotencyKey?: string;
  deps?: ClientDeps;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The principal an actor string names. */
export function principalOfActor(actor: string | null | undefined): KernelPrincipal {
  const a = actor ?? 'system:door';
  const human = /^human:(.+)$/.exec(a);
  if (human && UUID.test(human[1])) return { kind: 'user', id: human[1] };
  return { kind: 'system', id: a.slice(0, 200) };
}

/** How many more times a door submits after an `unknown` outcome, always with the same key. */
export const DOOR_UNKNOWN_RETRIES = 2;

async function door<K extends KernelOp>(op: K, input: KernelOps[K]['input'], actor: string | null | undefined, c: DoorCall = {}): Promise<KernelOps[K]['result']> {
  // One key for the whole door call: every retry below asks the control plane the same question.
  const idempotencyKey = c.idempotencyKey ?? (c.deps?.newKey ?? (() => newIdempotencyKey(op)))();
  const principal = c.principal ?? principalOfActor(actor);
  for (let attempt = 0; ; attempt++) {
    try {
      return (await submitKernelCommand(op, input, { principal, idempotencyKey, deps: c.deps })).result;
    } catch (err) {
      // The outcome is unknown (it may have run): ask again with the same key, which answers with what
      // was done and never applies it twice. Not applied: the door reports it; nothing to recover.
      if (err instanceof ControlPlaneUnavailableError && err.outcome === 'unknown' && attempt < DOOR_UNKNOWN_RETRIES) continue;
      throw err;
    }
  }
}

export const landThroughKernel = (p: KernelOps['land']['input'], c?: DoorCall) => door('land', p, p.actor, c);
export const applyRecommendationThroughKernel = (p: KernelOps['apply_recommendation']['input'], c?: DoorCall) => door('apply_recommendation', p, p.actor, c);
export const policyMergeThroughKernel = (p: KernelOps['policy_merge']['input'], c?: DoorCall) => door('policy_merge', p, `rule:${p.rule ?? 'escalation_gate'}`, c);
export const requestReview = (p: KernelOps['request_review']['input'], c?: DoorCall) => door('request_review', p, p.actor, c);
export const requestCiRetry = (p: KernelOps['request_ci_retry']['input'], c?: DoorCall) => door('request_ci_retry', p, p.actor, c);
export const recordSupersession = (p: KernelOps['record_supersession']['input'], c?: DoorCall) => door('record_supersession', p, p.actor, c);
export const abandonDelivery = (p: KernelOps['abandon']['input'], c?: DoorCall) => door('abandon', p, p.actor, c);
export const openKernelDelivery = (p: KernelOps['open_delivery']['input'], c?: DoorCall) => door('open_delivery', p, `system:${p.source}`, c);

/** A door's caller-supplied idempotency key, when the request carries one. */
export function idempotencyKeyOf(req: { headers: { get(name: string): string | null } }): string | undefined {
  const k = req.headers.get('idempotency-key')?.trim();
  return k && /^[A-Za-z0-9:._\-]{8,200}$/.test(k) ? k : undefined;
}
