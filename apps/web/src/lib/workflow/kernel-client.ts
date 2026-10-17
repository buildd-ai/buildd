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
import { AsyncLocalStorage } from 'node:async_hooks';
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

/**
 * The command ran on the control plane and threw (`command_failed`, a 500 with the error). Deterministic
 * as far as the client can tell: reported as the real error, never retried by the door.
 */
export class KernelCommandFailedError extends Error {
  constructor(readonly detail: string, readonly idempotencyKey: string | null) {
    super(`The command failed on the control plane: ${detail}`);
    this.name = 'KernelCommandFailedError';
  }
}

/** Errors a door turns into an answer of its own rather than a 500. */
export type DoorError = ControlPlaneUnavailableError | KernelCommandRefusedError | KernelCommandFailedError;
export const isDoorError = (err: unknown): err is DoorError =>
  err instanceof ControlPlaneUnavailableError || err instanceof KernelCommandRefusedError || err instanceof KernelCommandFailedError;

/**
 * Every door's answer for a door error, one shape (status + JSON body):
 *  - unavailable (AC-12): 503, retryable, naming the control plane, with the outcome and the key;
 *  - refused (auth, principal, shape): 403, not retryable;
 *  - failed (the command threw there): 500 with its error and the key.
 */
export function doorErrorAnswer(err: DoorError): { status: number; body: Record<string, unknown>; headers: Record<string, string> } {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (err instanceof ControlPlaneUnavailableError) {
    return {
      status: 503,
      headers: { ...headers, 'Retry-After': '5' },
      body: {
        error: err.message, code: err.code, retryable: true, controlPlane: true, outcome: err.outcome,
        // Send it back as the Idempotency-Key header and the retry gets the control plane's answer.
        ...(err.idempotencyKey ? { idempotencyKey: err.idempotencyKey } : {}),
      },
    };
  }
  if (err instanceof KernelCommandFailedError) {
    return { status: 500, headers, body: { error: err.message, code: 'command_failed', retryable: false, controlPlane: true, ...(err.idempotencyKey ? { idempotencyKey: err.idempotencyKey } : {}) } };
  }
  return { status: 403, headers, body: { error: err.message, code: 'control_plane_refused', retryable: false, controlPlane: true, refusal: err.body.code ?? null } };
}

export function doorErrorResponse(err: DoorError): Response {
  const a = doorErrorAnswer(err);
  return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json', ...a.headers } });
}

/** A door's answer when the control plane is unreachable (AC-12): retryable, naming the control plane. */
export function controlPlaneUnavailableResponse(err: ControlPlaneUnavailableError): Response {
  return doorErrorResponse(err);
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

/**
 * A failed read is not repeated sooner than this. Within it the answer is the failed read's (a recent
 * reading, else `own`), so a sweep's many calls do not each wait out the health timeout again.
 */
export const MODE_RETRY_MS = 5_000;

let cached: { mode: KernelMode; at: number } | null = null;
let failedAt: number | null = null;
/** The read in flight: concurrent callers share it rather than each fetching the health. */
let reading: Promise<string | null> | null = null;

/** Tests. */
export function resetKernelModeCache(): void { cached = null; failedAt = null; reading = null; }

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
  const recentlyFailed = failedAt !== null && now - failedAt < MODE_RETRY_MS;
  let read: string | null = null;
  if (!recentlyFailed) {
    const mine = reading ?? (reading = (deps.readMode ?? (() => readWorkerMode(env)))().catch(() => null));
    try { read = await mine; } finally { if (reading === mine) reading = null; }
  }
  if (read !== null) {
    cached = { mode: executionModeOf(read), at: now };
    failedAt = null;
    return cached.mode;
  }
  if (!recentlyFailed) failedAt = now;
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

// ── A pass's control-plane budget ───────────────────────────────────────────
//
// A sweep (the hourly merge-state pass, the landing and red-PR ticks) may call many doors and
// inline drains, each with a budget of its own (20 s a door, 10 s a drain). Summed one after
// another they outlast the route's function limit, which is how the first passes after the
// kernel moved to the control plane timed out. Inside `withControlPlaneBudget` every submission
// is cut to what is left of the pass's budget, a drain waits only briefly for its answer (the
// control plane finishes it either way), and once the budget is spent nothing more is sent: a
// door gets `ControlPlaneUnavailableError` at once (retryable; nothing was applied, the next
// tick does it) and a drain is left to the control plane's floor.

interface BudgetScope {
  label: string;
  deadline: number;
  now: () => number;
  submitted: number;
  refused: number;
  drainsSkipped: number;
  waitedMs: number;
}

const budgetScope = new AsyncLocalStorage<BudgetScope>();

export interface ControlPlaneBudgetReport {
  label: string;
  budgetMs: number;
  /** Requests sent to the control plane inside the pass. */
  submitted: number;
  /** Door calls refused unsent because the budget was spent. */
  refused: number;
  /** Inline drains left to the floor because the budget was spent. */
  drainsSkipped: number;
  /** Time spent waiting on the control plane, summed over every call (concurrent calls overlap). */
  waitedMs: number;
}

/**
 * Run `fn` (a sweep) with at most `budgetMs` of control-plane time from now. Nested scopes keep the
 * earlier deadline. On the web host in shadow, and on the control plane, nothing is submitted and the
 * budget never binds.
 */
export async function withControlPlaneBudget<T>(label: string, budgetMs: number, fn: () => Promise<T>, o: { now?: () => number } = {}): Promise<{ value: T; budget: ControlPlaneBudgetReport }> {
  const now = o.now ?? Date.now;
  const outer = budgetScope.getStore();
  const own = now() + budgetMs;
  const scope: BudgetScope = {
    label, now, submitted: 0, refused: 0, drainsSkipped: 0, waitedMs: 0,
    deadline: outer ? Math.min(own, outer.deadline - outer.now() + now()) : own,
  };
  const value = await budgetScope.run(scope, fn);
  return { value, budget: { label, budgetMs, submitted: scope.submitted, refused: scope.refused, drainsSkipped: scope.drainsSkipped, waitedMs: scope.waitedMs } };
}

/** What is left of the current pass's control-plane budget, in ms; null outside a pass. */
export function controlPlaneBudgetLeft(): number | null {
  const s = budgetScope.getStore();
  return s ? Math.max(0, s.deadline - s.now()) : null;
}

// ── Submitting ──────────────────────────────────────────────────────────────

export interface SubmitOptions {
  /** Null: no principal was named. The command may run on this host, but is never sent to the control plane. */
  principal: KernelPrincipal | null;
  /** The caller's key; the same key on a retry gets the same answer. Absent: one is made for this call. */
  idempotencyKey?: string;
  /** Overall budget for reaching the control plane, retries included. */
  budgetMs?: number;
  /** An earlier submission of this door call came back `unknown`: never fall back to running it here. */
  priorUnknown?: boolean;
  /** Read the delivery's version after a local run (the answer's `delivery`). Doors do not use it. Default true. */
  withDelivery?: boolean;
  deps?: ClientDeps;
}

/** Connection errors that prove nothing was sent: refused, or the name did not resolve. */
const PRE_CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

export function failedBeforeConnecting(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === 'string' && PRE_CONNECT_CODES.has(code);
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
  if (await hostsKernelHere(deps)) {
    // After an unknown outcome the control plane may have applied it: the web host never runs it as well.
    if (opts.priorUnknown && (deps.host ?? kernelHost)() === 'web') {
      throw new ControlPlaneUnavailableError('the web host now runs the kernel, but an earlier attempt may have reached the control plane', 'unknown', idempotencyKey);
    }
    return runHere(op, input, idempotencyKey, deps, opts.withDelivery !== false);
  }
  return submitRemote(op, input, { ...opts, idempotencyKey }, deps);
}

async function runHere<K extends KernelOp>(op: K, input: KernelOps[K]['input'], idempotencyKey: string, deps: ClientDeps, withDelivery = true): Promise<KernelAnswer<K>> {
  const result = await (deps.run ?? runKernelOp)(op, input);
  const delivery = withDelivery ? await (deps.deliveryAfter ?? deliveryAfter)(op, input, result).catch(() => null) : null;
  return { result, delivery, host: (deps.host ?? kernelHost)(), replayed: false, idempotencyKey };
}

async function submitRemote<K extends KernelOp>(op: K, input: KernelOps[K]['input'], opts: SubmitOptions & { idempotencyKey: string }, deps: ClientDeps): Promise<KernelAnswer<K>> {
  // Fail closed: a command the control plane cannot re-check for someone is not sent as the system.
  if (!opts.principal) throw new KernelCommandRefusedError(403, { code: 'no_principal', error: 'the door named no principal for this command' });
  const env = deps.env ?? process.env;
  const key = signingKey(commandKeyRing(env));
  if (!key) throw new ControlPlaneUnavailableError('no command key is configured on the web host', 'not_applied', opts.idempotencyKey);
  const base = (env.CONTROL_PLANE_URL || CONTROL_PLANE_URL).replace(/\/+$/, '');
  const url = new URL(COMMAND_PATH, base);
  const body = JSON.stringify({ v: COMMAND_API_VERSION, op, input, principal: opts.principal, idempotencyKey: opts.idempotencyKey } satisfies CommandRequest<K>);
  const now = deps.now ?? Date.now;
  let deadline = now() + (opts.budgetMs ?? (Number(env.KERNEL_COMMAND_BUDGET_MS) || 45_000));
  let why = 'no attempt';
  // Once any request may have reached the control plane, a failure's outcome is unknown.
  let mayHaveApplied = opts.priorUnknown === true;
  // Inside a pass, never past what is left of its budget; once it is spent, nothing is sent.
  const scope = budgetScope.getStore();
  if (scope) {
    const left = scope.deadline - scope.now();
    if (left <= 0) {
      scope.refused++;
      throw new ControlPlaneUnavailableError(`the ${scope.label} pass spent its control-plane budget`, mayHaveApplied ? 'unknown' : 'not_applied', opts.idempotencyKey);
    }
    deadline = Math.min(deadline, now() + left);
    scope.submitted++;
  }
  const started = now();
  try {
    return await submitUntil(op, input, opts, deps, { url, body, key, deadline, why, mayHaveApplied });
  } finally {
    if (scope) scope.waitedMs += now() - started;
  }
}

async function submitUntil<K extends KernelOp>(
  op: K, input: KernelOps[K]['input'], opts: SubmitOptions & { idempotencyKey: string }, deps: ClientDeps,
  s: { url: URL; body: string; key: { keyId: string; secret: string }; deadline: number; why: string; mayHaveApplied: boolean },
): Promise<KernelAnswer<K>> {
  const { url, body, key, deadline } = s;
  let { why, mayHaveApplied } = s;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

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
      // Only a failure to connect at all proves the request never reached the control plane. Everything
      // else (a timeout, a reset after the body was sent, which Node also reports as `fetch failed`)
      // may have reached it.
      const preConnect = failedBeforeConnecting(err);
      if (!preConnect) mayHaveApplied = true;
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      why = timedOut ? 'timed out' : `${preConnect ? 'unreachable' : 'connection lost'}: ${err instanceof Error ? err.message : String(err)}`;
      await sleep(Math.min(250 * 2 ** attempt, 2_000));
      continue;
    }
    const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && answer && answer.v === COMMAND_API_VERSION) {
      const a = answer as unknown as CommandAnswer<K>;
      return { result: a.result, delivery: a.delivery, host: a.host, replayed: a.replayed, idempotencyKey: opts.idempotencyKey };
    }
    if ((res.status === 409 && answer?.code === 'not_host') || (res.status === 503 && answer?.code === 'unconfigured')) {
      // An earlier attempt of this door call may have run there: running it here too could apply it twice.
      if (mayHaveApplied) {
        throw new ControlPlaneUnavailableError(`answered ${res.status} ${String(answer.code)} after an earlier attempt may have reached it`, 'unknown', opts.idempotencyKey);
      }
      // The control plane is in shadow, or holds no command key yet (half switched over): the web host is
      // the host after all. It refused before running anything, so nothing was applied there.
      cached = { mode: 'shadow', at: now() };
      return runHere(op, input, opts.idempotencyKey, deps, opts.withDelivery !== false);
    }
    if (res.status === 500 && answer?.code === 'command_failed') {
      // The command itself threw there (the key was released): the real error, not an outage. Not retried.
      throw new KernelCommandFailedError(String(answer.error ?? 'unknown error'), opts.idempotencyKey);
    }
    if (res.status === 503 && (answer?.code === 'ledger_unavailable' || answer?.code === 'reach_unavailable')) {
      // Refused before the claim: this request ran nothing (earlier ones may have; mayHaveApplied keeps that).
      // One more try, then the answer: a database that is down now is not back within a door's budget.
      why = `answered 503 ${String(answer.code)}`;
      if (attempt >= 1) throw new ControlPlaneUnavailableError(why, mayHaveApplied ? 'unknown' : 'not_applied', opts.idempotencyKey);
      await sleep(Math.min(250 * 2 ** attempt, 2_000));
      continue;
    }
    if (RETRYABLE_STATUS.has(res.status) || (res.status === 409 && answer?.code === 'in_progress')) {
      why = `answered ${res.status}${answer?.code ? ` ${String(answer.code)}` : ''}`;
      // in_progress: it is running there. Any other 5xx: it may have run. Only a 429 refused before running.
      if (res.status !== 429) mayHaveApplied = true;
      await sleep(Math.min(250 * 2 ** attempt, 2_000));
      continue;
    }
    throw new KernelCommandRefusedError(res.status, answer ?? {});
  }
}

// ── The inline drain ────────────────────────────────────────────────────────

/** How long a web-host request waits for the control plane's answer to an inline drain. */
export const INLINE_DRAIN_BUDGET_MS = 10_000;
/**
 * Inside a pass (a sweep), how long an inline drain waits for that answer. Not answering in time is
 * not a failure: the control plane runs the drain to its end even after this caller stops waiting
 * (command-api.ts hands it to the Worker's waitUntil), and its floor drains whatever is left.
 */
export const PASS_DRAIN_WAIT_MS = 2_500;

/**
 * The web host's inline drain in own mode: one `drain` command, best effort (the effect rows are
 * durable). Null when it was not confirmed: not answered in time, or skipped because the pass it
 * runs in spent its control-plane budget.
 */
export async function drainOnControlPlane(deliveryId: string, deps: ClientDeps = {}): Promise<KernelOps['drain']['result']> {
  const scope = budgetScope.getStore();
  const passLeft = controlPlaneBudgetLeft();
  if (scope && passLeft !== null && passLeft <= 0) {
    scope.drainsSkipped++;
    return null;
  }
  const budgetMs = passLeft === null ? INLINE_DRAIN_BUDGET_MS : Math.min(PASS_DRAIN_WAIT_MS, passLeft);
  try {
    const answer = await submitKernelCommand('drain', { deliveryId }, { principal: { kind: 'system', id: 'inline-drain' }, budgetMs, withDelivery: false, deps });
    return answer.result;
  } catch (err) {
    console.warn(`[workflow] control-plane drain for delivery ${deliveryId} not confirmed; the control plane finishes it or its floor drains it:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ── The doors' functions ────────────────────────────────────────────────────
//
// The seam's door functions, same names and inputs, run where the kernel is
// hosted. A door imports these, never the seam's own (the S3a block of
// packages/core/__tests__/workflow-write-sites.test.ts fails on a door that does). Every door
// names who the command is for (`principal`, required, so leaving it out fails the type check):
// a door a person, an agent or an API caller reaches passes `kernelPrincipalOf` its authenticated
// caller; buildd's own sweeps and rules pass `systemPrincipal(...)`. Null (no caller) is never sent.

export interface DoorCall {
  principal: KernelPrincipal | null;
  /** The caller's key (an `Idempotency-Key` header); absent, one is made for this call. */
  idempotencyKey?: string;
  deps?: ClientDeps;
}

export { doorPrincipal, principalOfActor, kernelPrincipalOf, systemPrincipal, type KernelCaller } from './kernel-principal';

/** How many more times a door submits after an `unknown` outcome, always with the same key. */
export const DOOR_UNKNOWN_RETRIES = 2;
/**
 * One door call's whole budget, every submission and retry included. It fits well inside the
 * routes' function limit (the project default); a merge door holds its
 * surface's merge slot (withMergeSlot) for all of it.
 */
export const DOOR_BUDGET_MS = 20_000;

async function door<K extends KernelOp>(op: K, input: KernelOps[K]['input'], c: DoorCall): Promise<KernelOps[K]['result']> {
  // One key for the whole door call: every retry below asks the control plane the same question.
  const idempotencyKey = c.idempotencyKey ?? (c.deps?.newKey ?? (() => newIdempotencyKey(op)))();
  // Never read off the input's actor: null (no caller) stays null and is refused before sending.
  const principal = c.principal;
  const now = c.deps?.now ?? Date.now;
  const env = c.deps?.env ?? process.env;
  // Inside a pass, the door's budget is also cut to what is left of the pass's (submitRemote refuses once it is spent).
  const passLeft = controlPlaneBudgetLeft();
  const deadline = now() + Math.min(Number(env.KERNEL_DOOR_BUDGET_MS) || DOOR_BUDGET_MS, passLeft ?? Infinity);
  let priorUnknown = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return (await submitKernelCommand(op, input, { principal, idempotencyKey, priorUnknown, withDelivery: false, budgetMs: Math.max(1, Math.min(deadline - now(), Number(env.KERNEL_COMMAND_BUDGET_MS) || Infinity)), deps: c.deps })).result;
    } catch (err) {
      // The outcome is unknown (it may have run): ask again with the same key, which answers with what
      // was done and never applies it twice, while the door's budget lasts. Anything else (not applied,
      // a refusal, the command's own failure, a local throw) is the door's answer as it is.
      if (!(err instanceof ControlPlaneUnavailableError) || err.outcome !== 'unknown') throw err;
      priorUnknown = true;
      if (attempt >= DOOR_UNKNOWN_RETRIES || now() >= deadline) throw err;
    }
  }
}

export const landThroughKernel = (p: KernelOps['land']['input'], c: DoorCall) => door('land', p, c);
export const applyRecommendationThroughKernel = (p: KernelOps['apply_recommendation']['input'], c: DoorCall) => door('apply_recommendation', p, c);
export const policyMergeThroughKernel = (p: KernelOps['policy_merge']['input'], c: DoorCall) => door('policy_merge', p, c);
export const requestReview = (p: KernelOps['request_review']['input'], c: DoorCall) => door('request_review', p, c);
export const requestCiRetry = (p: KernelOps['request_ci_retry']['input'], c: DoorCall) => door('request_ci_retry', p, c);
export const recordSupersession = (p: KernelOps['record_supersession']['input'], c: DoorCall) => door('record_supersession', p, c);
export const abandonDelivery = (p: KernelOps['abandon']['input'], c: DoorCall) => door('abandon', p, c);
export const openKernelDelivery = (p: KernelOps['open_delivery']['input'], c: DoorCall) => door('open_delivery', p, c);
/**
 * Whether the control plane refused `op` because it does not know it: a 400 from `commandProblem`
 * (`unknown op "<op>"`), which a control plane on an older build answers before it reads anything.
 * Nothing was applied there. Any other refusal (auth, reach, a malformed input) is not this.
 */
export function refusedAsUnknownOp(err: unknown, op: KernelOp): boolean {
  if (!(err instanceof KernelCommandRefusedError) || err.status !== 400) return false;
  const { code, error } = err.body;
  return code === 'bad_request' && typeof error === 'string' && error.startsWith(`unknown op ${JSON.stringify(op)}`);
}

/**
 * T4 from the web host: the attempt's end, applied where the kernel is hosted (AC-9).
 *
 * Release skew: Vercel and the control-plane Worker deploy separately, so for a few minutes the web
 * host can run this against a control plane that predates `attempt_ended`. That control plane refuses
 * the op as unknown and applies nothing, and a repair's or a review's end has no other backstop. Only
 * then the web host applies it itself, as it does in shadow, and says so loudly. Every other refusal
 * stays a refusal.
 */
export async function attemptEnded(p: Omit<KernelOps['attempt_ended']['input'], 'workspaceId'>, c: DoorCall): Promise<KernelOps['attempt_ended']['result']> {
  const input = { ...p, workspaceId: p.task.workspaceId };
  try {
    return await door('attempt_ended', input, c);
  } catch (err) {
    if (!refusedAsUnknownOp(err, 'attempt_ended')) throw err;
    console.error(`[workflow] SKEW: the control plane does not know attempt_ended (an older build); applying task ${p.task.id}'s attempt end on the ${(c.deps?.host ?? kernelHost)()} host instead. This should stop once the control plane is on this release.`);
    return (c.deps?.run ?? runKernelOp)('attempt_ended', input);
  }
}

/** A door's caller-supplied idempotency key, when the request carries one. */
export function idempotencyKeyOf(req: { headers: { get(name: string): string | null } }): string | undefined {
  const k = req.headers.get('idempotency-key')?.trim();
  return k && /^[A-Za-z0-9:._\-]{8,200}$/.test(k) ? k : undefined;
}
