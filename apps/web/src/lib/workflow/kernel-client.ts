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
import { createHash } from 'node:crypto';
import { signRequest, signingKey } from '@buildd/dispatch-contract';
import { kernelHost, type KernelHost } from './kernel-host';
import {
  COMMAND_API_VERSION, COMMAND_PATH, commandKeyRing, commandsConfigured, deliveryAfter, executionModeOf, personOpRefusal, runKernelOp,
  type CommandAnswer, type CommandRequest, type DeliveryVersion, type KernelOp, type KernelOps, type KernelPrincipal,
} from './command-api';
import { postgresCommandOutbox, shouldPark, type CommandOutbox } from './command-outbox';
import { noteWorkChanged, workChangeOfKernelInput } from '@/lib/work-changed';
import { KernelObservationFailed } from './kernel-observation';
import {
  KERNEL_SPAN, breakerSpanAttributes, currentKernelRoute, doorSpanAttributes, emitKernelSpan, inferDoorCaller, passSpanAttributes, webCommandSpanAttributes,
  type DoorCaller, type DoorOutcome, type WebCommandReason,
} from './kernel-telemetry';

export { KernelObservationFailed } from './kernel-observation';

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
  /** Set by a door that kept the command for the floor to re-submit (command-outbox.ts): it is not lost. */
  parked = false;
  /** Set when a breaker skipped the request (the door's span reads `breaker_open`). */
  breakerOpen = false;
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
        ...(err.parked ? { parked: true } : {}),
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
  /** Keeps an unanswered door command for the floor (command-outbox.ts). */
  park?: CommandOutbox['park'];
  /** The kernel delivery of a PR, read on this host (an unanswered observation's ownership). */
  kernelDeliveryOf?: (p: { workspaceId: string; repoFullName: string; prNumber: number }) => Promise<string | null>;
  /** Records a close the control plane did not answer, unapplied, and schedules its heal. */
  recordUnapplied?: (deliveryId: string, p: KernelOps['observe_pr_state']['input']) => Promise<void>;
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
  /** A webhook request's scope (`withWebhookBudget`): each door is capped short and keyed by the delivery. */
  webhook?: { deliveryId: string };
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
export async function withControlPlaneBudget<T>(label: string, budgetMs: number, fn: () => Promise<T>, o: { now?: () => number; quiet?: boolean; webhook?: { deliveryId: string } } = {}): Promise<{ value: T; budget: ControlPlaneBudgetReport }> {
  const now = o.now ?? Date.now;
  const startedAt = Date.now();
  const outer = budgetScope.getStore();
  const own = now() + budgetMs;
  const scope: BudgetScope = {
    label, now, submitted: 0, refused: 0, drainsSkipped: 0, waitedMs: 0, webhook: o.webhook,
    deadline: outer ? Math.min(own, outer.deadline - outer.now() + now()) : own,
  };
  const value = await budgetScope.run(scope, fn);
  // A pass that ran out of budget is what a monitor wants to see; one that did not is noise.
  if (!o.quiet && (scope.refused > 0 || scope.drainsSkipped > 0)) {
    emitKernelSpan({ name: KERNEL_SPAN.pass, startMs: startedAt, durationMs: Date.now() - startedAt, attributes: passSpanAttributes({ label, budgetMs, submitted: scope.submitted, refused: scope.refused, drainsSkipped: scope.drainsSkipped, waitedMs: scope.waitedMs, host: kernelHost() }) });
  }
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
  // Checked on this host too, so running here never skips what the control plane would refuse.
  const notPerson = personOpRefusal(op, input, opts.principal);
  if (notPerson) throw new KernelCommandRefusedError(403, { code: 'person_only', error: notPerson });
  if (await hostsKernelHere(deps)) {
    // After an unknown outcome the control plane may have applied it: the web host never runs it as well.
    if (opts.priorUnknown && (deps.host ?? kernelHost)() === 'web') {
      throw new ControlPlaneUnavailableError('the web host now runs the kernel, but an earlier attempt may have reached the control plane', 'unknown', idempotencyKey);
    }
    return noted(input, await runHere(op, input, idempotencyKey, deps, opts.withDelivery !== false, commandsConfigured(deps.env ?? process.env) ? 'shadow' : 'no_command_key'));
  }
  return noted(input, await submitRemote(op, input, { ...opts, idempotencyKey }, deps));
}

/**
 * A command that ran changed the delivery, review or task it names: its
 * mission's summary is refreshed after the response (lib/work-changed.ts).
 * Here, not in the kernel, so it holds wherever the kernel is hosted.
 */
function noted<T>(input: unknown, answer: T): T {
  noteWorkChanged(workChangeOfKernelInput(input));
  return answer;
}

async function runHere<K extends KernelOp>(op: K, input: KernelOps[K]['input'], idempotencyKey: string, deps: ClientDeps, withDelivery: boolean, reason: WebCommandReason): Promise<KernelAnswer<K>> {
  const result = await runReported(op, input, deps, reason);
  const delivery = withDelivery ? await (deps.deliveryAfter ?? deliveryAfter)(op, input, result).catch(() => null) : null;
  return { result, delivery, host: (deps.host ?? kernelHost)(), replayed: false, idempotencyKey };
}

/** Runs the command on this host; on the web host it is also reported (`kernel.web_command`), with why. */
async function runReported<K extends KernelOp>(op: K, input: KernelOps[K]['input'], deps: ClientDeps, reason: WebCommandReason): Promise<KernelOps[K]['result']> {
  if ((deps.host ?? kernelHost)() !== 'web') return (deps.run ?? runKernelOp)(op, input);
  const startedAt = Date.now();
  let failed = false;
  try {
    return await (deps.run ?? runKernelOp)(op, input);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    emitKernelSpan({ name: KERNEL_SPAN.webCommand, startMs: startedAt, durationMs: Date.now() - startedAt, attributes: webCommandSpanAttributes({ op, reason, latencyMs: Date.now() - startedAt }), error: failed });
  }
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

  // A retry never sleeps past the deadline: a short budget (a claim's start) is not overrun by the backoff.
  const backoff = (attempt: number) => Math.max(0, Math.min(250 * 2 ** attempt, 2_000, deadline - now()));

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
      await sleep(backoff(attempt));
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
      return runHere(op, input, opts.idempotencyKey, deps, opts.withDelivery !== false, answer.code === 'not_host' ? 'not_host' : 'unconfigured');
    }
    if (res.status === 500 && answer?.code === 'command_failed') {
      // The command itself threw there (the key was released): the real error, not an outage. Not retried.
      throw new KernelCommandFailedError(String(answer.error ?? 'unknown error'), opts.idempotencyKey);
    }
    if (res.status === 503 && (answer?.code === 'ledger_unavailable' || answer?.code === 'reach_unavailable' || answer?.code === 'installation_unavailable')) {
      // Refused before the claim: this request ran nothing (earlier ones may have; mayHaveApplied keeps that).
      // One more try, then the answer: a database that is down now is not back within a door's budget.
      why = `answered 503 ${String(answer.code)}`;
      if (attempt >= 1) throw new ControlPlaneUnavailableError(why, mayHaveApplied ? 'unknown' : 'not_applied', opts.idempotencyKey);
      await sleep(backoff(attempt));
      continue;
    }
    if (RETRYABLE_STATUS.has(res.status) || (res.status === 409 && answer?.code === 'in_progress')) {
      why = `answered ${res.status}${answer?.code ? ` ${String(answer.code)}` : ''}`;
      // in_progress: it is running there. Any other 5xx: it may have run. Only a 429 refused before running.
      if (res.status !== 429) mayHaveApplied = true;
      await sleep(backoff(attempt));
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

/**
 * The web host's fast heal in own mode (kernel-heal.ts): one `heal` command, so the delivery's floor
 * pass (and any T17 to T19 it applies) runs on the control plane. Null when it was not confirmed in
 * `budgetMs`; the heal tick then re-marks the delivery while it is still owed, and the floor backs it.
 */
export async function healOnControlPlane(deliveryId: string, budgetMs: number, deps: ClientDeps = {}): Promise<KernelOps['heal']['result'] | null> {
  try {
    const answer = await submitKernelCommand('heal', { deliveryId }, { principal: { kind: 'system', id: 'kernel-heal' }, budgetMs, withDelivery: false, deps });
    return answer.result;
  } catch (err) {
    console.warn(`[workflow] control-plane heal for delivery ${deliveryId} not confirmed; it is re-marked while still owed and the floor backs it:`, err instanceof Error ? err.message : err);
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
  /** Who is calling, for the door's span; absent, it is inferred (kernel-telemetry.ts `inferDoorCaller`). */
  caller?: DoorCaller;
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

/** A webhook request's whole control-plane budget: GitHub marks a delivery failed at about 10 s (KERNEL_WEBHOOK_BUDGET_MS overrides). */
export const WEBHOOK_BUDGET_MS = 6_000;
/** One door call's budget inside a webhook request (KERNEL_WEBHOOK_DOOR_BUDGET_MS overrides). */
export const WEBHOOK_DOOR_BUDGET_MS = 2_500;
/** After a webhook door went unanswered, how long every webhook door skips the control plane and takes its durable fallback at once. */
export const WEBHOOK_SKIP_MS = 45_000;
let webhookSkipUntil = 0;
/** When the open webhook breaker opened (0: closed), for the span that reports it closing. */
let webhookOpenedAt = 0;
/** Close the webhook breaker (tests). */
export function resetWebhookBreaker(): void {
  webhookSkipUntil = 0;
  webhookOpenedAt = 0;
}

/**
 * Run a webhook request's handlers with a short control-plane budget, so the response is back well
 * inside GitHub's delivery timeout even when the control plane is slow or down. Inside it, each door
 * call waits at most `WEBHOOK_DOOR_BUDGET_MS`, the whole request at most `WEBHOOK_BUDGET_MS`, and a
 * door left unanswered opens a breaker (`WEBHOOK_SKIP_MS`) so the rest of the request, and the next
 * deliveries, skip the wait. A door that gives up takes the durable path it always had: a parked
 * command (`PARK_ON_UNAVAILABLE`) or a close recorded unapplied and healed (`observePrState`), so
 * nothing is lost. Each door's command key derives from the delivery id, so GitHub's redelivery of a
 * request that did apply, slowly, is the same command to the ledger and answers with what was done.
 */
export function withWebhookBudget<T>(deliveryId: string, fn: () => Promise<T>, o: { now?: () => number; env?: Record<string, string | undefined> } = {}): Promise<T> {
  const env = o.env ?? process.env;
  return withControlPlaneBudget('webhook', Number(env.KERNEL_WEBHOOK_BUDGET_MS) || WEBHOOK_BUDGET_MS, fn, { now: o.now, webhook: { deliveryId } }).then((r) => r.value);
}

/** The command key of a door call made while handling one webhook delivery: stable across GitHub's redeliveries. */
export function webhookCommandKey(deliveryId: string, op: KernelOp, input: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(input) ?? '').digest('hex').slice(0, 16);
  return `webhook:${deliveryId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60)}:${op}:${hash}`;
}

/**
 * The doors a webhook request caps (AC-65): the ones that have a durable fallback when the control
 * plane does not answer. Parked ops (`PARK_ON_UNAVAILABLE`) are kept for the floor; `observe_pr_state`
 * is recorded unapplied and healed; `observe_ci_failure` and `observe_conflict` are not parked but the
 * red-PR and conflict sweeps re-send them. Every other door (`open_delivery`, whose failure hands a
 * PR to legacy review while the control plane may still finish it; `land`; the rest) keeps its own
 * budget and is outside the webhook's scope, as before.
 */
export const WEBHOOK_CAPPED_OPS: ReadonlySet<KernelOp> = new Set<KernelOp>([
  'observe_ci_green', 'observe_head', 'observe_base', 'observe_pr_state', 'observe_ci_failure', 'observe_conflict',
]);

async function door<K extends KernelOp>(op: K, input: KernelOps[K]['input'], c: DoorCall, o: { skew?: boolean } = {}): Promise<KernelOps[K]['result']> {
  // The door's span (kernel-telemetry.ts): op, outcome, latency, budget, caller.
  const startedAt = Date.now();
  const budgetMs = doorBudgetMs(op, c.deps?.env ?? process.env);
  try {
    const result = await doorUnreported(op, input, c);
    reportDoor(op, c, { startedAt, budgetMs, outcome: 'applied' });
    return result;
  } catch (err) {
    reportDoor(op, c, { startedAt, budgetMs, outcome: doorOutcomeOf(err, op, o.skew === true), err });
    throw err;
  }
}

/**
 * The budget a door call runs under, as `submitDoor` computes it: the door's own, cut to what is left of
 * its pass and, inside a webhook request, to the webhook door cap. A webhook door with no durable
 * fallback leaves the webhook's scope (`doorUnreported`), so only its own budget applies.
 */
function doorBudgetMs(op: KernelOp, env: Record<string, string | undefined>): number {
  const own = Number(env.KERNEL_DOOR_BUDGET_MS) || DOOR_BUDGET_MS;
  const wh = budgetScope.getStore()?.webhook;
  if (wh && !WEBHOOK_CAPPED_OPS.has(op)) return own;
  const webhookCap = wh ? (Number(env.KERNEL_WEBHOOK_DOOR_BUDGET_MS) || WEBHOOK_DOOR_BUDGET_MS) : Infinity;
  return Math.min(own, controlPlaneBudgetLeft() ?? Infinity, webhookCap);
}

/** How a door call that threw ended, for its span. */
function doorOutcomeOf(err: unknown, op: KernelOp, skew: boolean): DoorOutcome {
  if (err instanceof ControlPlaneUnavailableError) return err.breakerOpen ? 'breaker_open' : err.parked ? 'parked' : 'unavailable';
  if (skew && refusedAsUnknownOp(err, op)) return 'skew_fallback';
  if (err instanceof KernelCommandRefusedError) return 'refused';
  return 'failed';
}

function reportDoor(op: KernelOp, c: DoorCall, p: { startedAt: number; budgetMs: number; outcome: DoorOutcome; err?: unknown; pass?: string }): void {
  const scope = budgetScope.getStore();
  const pass = p.pass ?? (scope?.webhook && !WEBHOOK_CAPPED_OPS.has(op) ? null : scope?.label ?? null);
  const errorCode = p.err instanceof KernelCommandRefusedError ? String(p.err.body.code ?? p.err.status)
    // A webhook door its breaker skipped is still parked for the floor: the code says so.
    : p.err instanceof ControlPlaneUnavailableError ? (p.err.breakerOpen && p.err.parked ? 'parked' : p.err.outcome)
      : p.err instanceof KernelCommandFailedError ? 'command_failed' : null;
  const latencyMs = Date.now() - p.startedAt;
  emitKernelSpan({
    name: KERNEL_SPAN.door, startMs: p.startedAt, durationMs: latencyMs,
    error: p.outcome !== 'applied' && p.outcome !== 'skew_fallback',
    attributes: doorSpanAttributes({
      op, outcome: p.outcome, latencyMs, budgetMs: Number.isFinite(p.budgetMs) ? p.budgetMs : 0,
      caller: inferDoorCaller({ explicit: c.caller, route: currentKernelRoute(), pass, principal: c.principal }),
      host: (c.deps?.host ?? kernelHost)(), pass, errorCode,
    }),
  });
}

async function doorUnreported<K extends KernelOp>(op: K, input: KernelOps[K]['input'], c: DoorCall): Promise<KernelOps[K]['result']> {
  // A door without a durable fallback runs as it always did: no cap, no breaker, and no share of the webhook's budget.
  if (budgetScope.getStore()?.webhook && !WEBHOOK_CAPPED_OPS.has(op)) return budgetScope.exit(() => doorUnreported(op, input, c));
  const wh = budgetScope.getStore()?.webhook;
  const whNow = c.deps?.now ?? Date.now;
  // One key for the whole door call: every retry below asks the control plane the same question.
  const idempotencyKey = c.idempotencyKey ?? (wh && wh.deliveryId ? webhookCommandKey(wh.deliveryId, op, input) : undefined) ?? (c.deps?.newKey ?? (() => newIdempotencyKey(op)))();
  try {
    if (wh && whNow() < webhookSkipUntil) {
      const skipped = new ControlPlaneUnavailableError(`a webhook door went unanswered within the last ${WEBHOOK_SKIP_MS / 1000}s; the door is skipped until then`, 'not_applied', idempotencyKey);
      skipped.breakerOpen = true;
      throw skipped;
    }
    try {
      const result = await submitDoor(op, input, c, idempotencyKey);
      if (wh && webhookOpenedAt) {
        emitKernelSpan({ name: KERNEL_SPAN.breaker, startMs: Date.now(), durationMs: 0, attributes: breakerSpanAttributes({ state: 'closed', breaker: 'webhook', op, skipMs: WEBHOOK_SKIP_MS, openMs: whNow() - webhookOpenedAt, host: (c.deps?.host ?? kernelHost)() }) });
        webhookOpenedAt = 0;
      }
      return result;
    } catch (err) {
      if (wh && err instanceof ControlPlaneUnavailableError && !err.why.includes('spent its control-plane budget')) {
        webhookSkipUntil = whNow() + WEBHOOK_SKIP_MS;
        if (!webhookOpenedAt) {
          webhookOpenedAt = whNow();
          emitKernelSpan({ name: KERNEL_SPAN.breaker, startMs: Date.now(), durationMs: 0, error: true, attributes: breakerSpanAttributes({ state: 'open', breaker: 'webhook', op, skipMs: WEBHOOK_SKIP_MS, host: (c.deps?.host ?? kernelHost)() }) });
        }
      }
      throw err;
    }
  } catch (err) {
    // Unanswered for the whole budget: an op nothing else re-sends is kept, under this same key, for the
    // floor to re-submit until it is answered (command-outbox.ts). The door still answers unavailable.
    if (err instanceof ControlPlaneUnavailableError && c.principal && shouldPark(op)) {
      err.parked = await (c.deps?.park ?? ((p) => postgresCommandOutbox().park(p)))({
        key: idempotencyKey, op, input, principal: c.principal, priorUnknown: err.outcome === 'unknown', why: err.why,
      }).catch((parkErr: unknown) => {
        console.error(`[workflow] ${op} ${idempotencyKey}: the control plane did not answer and the command could not be parked; it is lost until re-sent:`, parkErr);
        return false;
      });
      if (err.parked) console.warn(`[workflow] ${op} ${idempotencyKey}: the control plane did not answer (${err.why}); parked, the kernel floor re-submits it.`);
    }
    throw err;
  }
}

async function submitDoor<K extends KernelOp>(op: K, input: KernelOps[K]['input'], c: DoorCall, idempotencyKey: string): Promise<KernelOps[K]['result']> {
  // Never read off the input's actor: null (no caller) stays null and is refused before sending.
  const principal = c.principal;
  const now = c.deps?.now ?? Date.now;
  const env = c.deps?.env ?? process.env;
  // Inside a pass, the door's budget is also cut to what is left of the pass's (submitRemote refuses once it is spent).
  const passLeft = controlPlaneBudgetLeft();
  const webhookCap = budgetScope.getStore()?.webhook ? (Number(env.KERNEL_WEBHOOK_DOOR_BUDGET_MS) || WEBHOOK_DOOR_BUDGET_MS) : Infinity;
  const deadline = now() + Math.min(Number(env.KERNEL_DOOR_BUDGET_MS) || DOOR_BUDGET_MS, passLeft ?? Infinity, webhookCap);
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
export const disposeFinding = (p: KernelOps['dispose_finding']['input'], c: DoorCall) => door('dispose_finding', p, c);
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
 * A door for an op newer than the control plane may be (release skew). Vercel and the control-plane
 * Worker deploy separately, so for a few minutes the web host can submit an op to a control plane that
 * predates it. That control plane refuses it as unknown and applies nothing, and the op has no other
 * backstop. Only then the web host applies it itself, as it does in shadow, and says so loudly. Every
 * other refusal stays a refusal.
 */
async function doorOrHereOnSkew<K extends KernelOp>(op: K, input: KernelOps[K]['input'], c: DoorCall, what: string): Promise<KernelOps[K]['result']> {
  try {
    return await door(op, input, c, { skew: true });
  } catch (err) {
    if (!refusedAsUnknownOp(err, op)) throw err;
    console.error(`[workflow] SKEW: the control plane does not know ${op} (an older build); applying ${what} on the ${(c.deps?.host ?? kernelHost)()} host instead. This should stop once the control plane is on this release.`);
    return runReported(op, input, c.deps ?? {}, 'skew');
  }
}

/**
 * T4 from the web host: the attempt's end, applied where the kernel is hosted (AC-9). A repair's or a
 * review's end has no other backstop, so during release skew it is applied here (`doorOrHereOnSkew`).
 */
export async function attemptEnded(p: Omit<KernelOps['attempt_ended']['input'], 'workspaceId'>, c: DoorCall): Promise<KernelOps['attempt_ended']['result']> {
  return doorOrHereOnSkew('attempt_ended', { ...p, workspaceId: p.task.workspaceId }, c, `task ${p.task.id}'s attempt end`);
}

/**
 * AttemptRequeued from the web host (AC-1 slice 6): an attempt's task goes back to the queue,
 * applied where the kernel is hosted. The caller also projects the requeue on its own host
 * (`projectRequeue`) for a control plane that is down or too old; during release skew it is
 * applied here (`doorOrHereOnSkew`).
 */
export async function attemptRequeued(p: Omit<KernelOps['attempt_requeued']['input'], 'workspaceId'>, c: DoorCall): Promise<KernelOps['attempt_requeued']['result']> {
  return doorOrHereOnSkew('attempt_requeued', { ...p, workspaceId: p.task.workspaceId }, c, `task ${p.task.id}'s requeue`);
}

/** AttemptStarted's own control-plane budget: a claim waits at most this long on the door (KERNEL_START_BUDGET_MS overrides). */
export const ATTEMPT_START_BUDGET_MS = 750;
/** After a start the control plane left unanswered, how long every start skips the door and the claim projects it at once. */
export const ATTEMPT_START_SKIP_MS = 45_000;
/** Process-level: until when starts skip the door (0: the door is tried). */
let attemptStartSkipUntil = 0;
/** When the open breaker opened (0: closed), for the span that reports it closing. */
let attemptStartOpenedAt = 0;
/** Close the start breaker (tests). */
export function resetAttemptStartBreaker(): void {
  attemptStartSkipUntil = 0;
  attemptStartOpenedAt = 0;
}

/**
 * AttemptStarted from the claim route (AC-1 slice 7): a claim of a kernel owner task starts its
 * attempt, applied where the kernel is hosted. Never run on the web host in own mode, not even
 * during release skew: the claim projects the start on its own host (`projectAttemptStart`) on any
 * door error, so an older control plane's refusal is just one more error. The door gets its own
 * small budget (`ATTEMPT_START_BUDGET_MS`, apart from the fix claims'), and a start left
 * unanswered opens a short breaker (`ATTEMPT_START_SKIP_MS`): the starts after it fail at once
 * without a request, so an outage costs one claim the budget, not every claim.
 */
export async function attemptStarted(p: Omit<KernelOps['attempt_started']['input'], 'workspaceId'>, c: DoorCall): Promise<KernelOps['attempt_started']['result']> {
  return shortDoor('attempt_started', { ...p, workspaceId: p.task.workspaceId }, c, 'claim_start');
}

/**
 * A door on the start's small budget and breaker: for an op whose caller projects the same move on
 * its own host on any door error (a claim's start, a withdrawal, a reopen), so waiting longer buys
 * nothing and one outage costs the budget once per breaker window, not once per call.
 */
async function shortDoor<K extends KernelOp>(op: K, input: KernelOps[K]['input'], c: DoorCall, label: string): Promise<KernelOps[K]['result']> {
  const now = c.deps?.now ?? Date.now;
  const host = (c.deps?.host ?? kernelHost)();
  const env = c.deps?.env ?? process.env;
  const budgetMs = Number(env.KERNEL_START_BUDGET_MS) || ATTEMPT_START_BUDGET_MS;
  if (now() < attemptStartSkipUntil) {
    const err = new ControlPlaneUnavailableError(`a start went unanswered within the last ${ATTEMPT_START_SKIP_MS / 1000}s; the door is skipped until then`);
    reportDoor(op, c, { startedAt: Date.now(), budgetMs, outcome: 'breaker_open', err, pass: label });
    throw err;
  }
  try {
    const { value } = await withControlPlaneBudget(label, budgetMs, () => door(op, input, c), { now, quiet: true });
    if (attemptStartOpenedAt) {
      emitKernelSpan({ name: KERNEL_SPAN.breaker, startMs: Date.now(), durationMs: 0, attributes: breakerSpanAttributes({ state: 'closed', breaker: 'attempt_start', op, skipMs: ATTEMPT_START_SKIP_MS, openMs: now() - attemptStartOpenedAt, host }) });
      attemptStartOpenedAt = 0;
    }
    return value;
  } catch (err) {
    if (err instanceof ControlPlaneUnavailableError) {
      attemptStartSkipUntil = now() + ATTEMPT_START_SKIP_MS;
      if (!attemptStartOpenedAt) {
        attemptStartOpenedAt = now();
        emitKernelSpan({ name: KERNEL_SPAN.breaker, startMs: Date.now(), durationMs: 0, error: true, attributes: breakerSpanAttributes({ state: 'open', breaker: 'attempt_start', op, skipMs: ATTEMPT_START_SKIP_MS, host }) });
      }
    }
    throw err;
  }
}

/**
 * AttemptReopened from the web host (AC-1 slice 9): a settled owner task opens again, applied where
 * the kernel is hosted. Never run on the web host in own mode, not even during release skew, and
 * never parked: the caller projects the reopen on its own host (`projectReopen`) on any door error,
 * under the same guard. On the start's small budget and breaker, so a recovery reopening many tasks
 * through an outage pays the budget once, not once per task.
 */
export async function attemptReopened(p: Omit<KernelOps['attempt_reopened']['input'], 'workspaceId'>, c: DoorCall): Promise<KernelOps['attempt_reopened']['result']> {
  return shortDoor('attempt_reopened', { ...p, workspaceId: p.task.workspaceId }, c, 'reopen');
}

/**
 * AttemptWithdrawn from the web host (AC-1 slice 9): a claim that runs no attempt gives its start
 * back, or a queued task is refused. As AttemptStarted (a claim waits on it): the start's small
 * budget and breaker, never run on the web host in own mode, never parked; the caller projects it
 * on its own host (`projectWithdraw`) on any door error.
 */
export async function attemptWithdrawn(p: Omit<KernelOps['attempt_withdrawn']['input'], 'workspaceId'>, c: DoorCall): Promise<KernelOps['attempt_withdrawn']['result']> {
  return shortDoor('attempt_withdrawn', { ...p, workspaceId: p.task.workspaceId }, c, 'claim_withdraw');
}

/**
 * The command key of a claim's start: one per claim, so the door's submission and a later replay from
 * the outbox are the same command to the ledger. (The transition's own key, `start:<task>:<claimedAt>`,
 * is the kernel's second guard; this one only has to be a valid command key.)
 */
export const attemptStartKey = (taskId: string, claimedAt: string): string =>
  `attempt_started:${taskId}:${claimedAt.replace(/[^A-Za-z0-9._-]/g, '_')}`.slice(0, 200);

/**
 * A start projected on the web host without a kernel answer (an interactive claim, the breaker open, an
 * outage) is parked once for the floor to replay on the control plane, so the kernel's log is complete.
 * Never on the claim's critical path: the caller runs it after the response. The replay records the
 * transition (or a duplicate) and the guarded projection is a no-op, because the task is already assigned.
 */
export async function parkAttemptStart(
  p: { input: Omit<KernelOps['attempt_started']['input'], 'workspaceId'>; principal: KernelPrincipal | null; priorUnknown?: boolean; why: string },
  deps: { park?: NonNullable<ClientDeps['park']> } = {},
): Promise<boolean> {
  if (!p.principal) return false;
  const key = attemptStartKey(p.input.task.id, p.input.claimedAt);
  return (deps.park ?? ((x) => postgresCommandOutbox().park(x)))({
    key, op: 'attempt_started', input: { ...p.input, workspaceId: p.input.task.workspaceId }, principal: p.principal, priorUnknown: p.priorUnknown === true, why: p.why,
  }).catch((err: unknown) => {
    console.error(`[workflow] attempt_started ${key}: could not be parked; the kernel's log misses this start:`, err);
    return false;
  });
}

/**
 * T10 from buildd's own CI doors (the red-PR sweep, the landing path, the check_suite subscriber):
 * a red head on a kernel-owned PR, applied where the kernel is hosted (AC-9). During release skew it
 * is applied here, so a red PR is never left without its repair (`doorOrHereOnSkew`).
 */
export async function observeCiFailure(p: KernelOps['observe_ci_failure']['input'], c: DoorCall): Promise<KernelOps['observe_ci_failure']['result']> {
  return doorOrHereOnSkew('observe_ci_failure', p, c, `the CI failure on ${p.repoFullName}#${p.prNumber} @ ${p.headSha}`);
}

/**
 * A green head from the check_suite success webhook: CiGreenObserved ends a CI repair bound to it, and
 * outside a repair it is recorded as a CiObserved reading; applied where the kernel is hosted (AC-9).
 * GitHub sends the green once, so during release skew it is applied here (`doorOrHereOnSkew`) rather
 * than leave a repair waiting on a green nobody records.
 */
export async function observeCiGreen(p: KernelOps['observe_ci_green']['input'], c: DoorCall): Promise<KernelOps['observe_ci_green']['result']> {
  return doorOrHereOnSkew('observe_ci_green', p, c, `the green CI on ${p.repoFullName}#${p.prNumber} @ ${p.headSha}`);
}

/**
 * T12 from the conflict door (landing, the merge routes, auto-merge, the dead-zone sweep, the
 * migration-collision dispatch): a conflict on a kernel-owned PR, applied where the kernel is hosted
 * (AC-9). The live PR is read again on every sweep, so during release skew it is applied here
 * (`doorOrHereOnSkew`) rather than leaving a conflicted PR without its repair.
 */
export async function observeConflict(p: KernelOps['observe_conflict']['input'], c: DoorCall): Promise<KernelOps['observe_conflict']['result']> {
  return doorOrHereOnSkew('observe_conflict', p, c, `the conflict on ${p.repoFullName}#${p.prNumber}`);
}

/**
 * T6 from the worker PATCH: a kernel review round's verdict, applied where the kernel is hosted (AC-9).
 * The runner reports a verdict once, so during release skew it is applied here (`doorOrHereOnSkew`).
 */
export async function recordReviewVerdict(p: KernelOps['record_review_verdict']['input'], c: DoorCall): Promise<KernelOps['record_review_verdict']['result']> {
  return doorOrHereOnSkew('record_review_verdict', p, c, `reviewer ${p.reviewerTask.id}'s verdict`);
}

/** 00d288fd from the worker PATCH: a verdict from outside the kernel's rounds, adopted where the kernel is hosted (AC-9). */
export async function adoptReviewVerdict(p: KernelOps['adopt_review_verdict']['input'], c: DoorCall): Promise<KernelOps['adopt_review_verdict']['result']> {
  return doorOrHereOnSkew('adopt_review_verdict', p, c, `reviewer ${p.reviewerTaskId}'s verdict on delivery ${p.deliveryId}`);
}

/**
 * T9 from the claim route: a fix claim, revalidated and applied where the kernel is hosted (AC-9). On the
 * claim's hot path it is one request in place of the seam's own reads, never one more. During release
 * skew it is applied here, so a claim is never held up by an older control plane.
 */
export async function claimFix(task: KernelOps['claim_fix']['input']['task'], c: DoorCall): Promise<KernelOps['claim_fix']['result']> {
  return doorOrHereOnSkew('claim_fix', { task, workspaceId: task.workspaceId }, c, `fix task ${task.id}'s claim`);
}

/** GitHub's pull object cut to what the kernel's reading of it uses (github-facts.ts `toLivePr`). */
function pullForKernel(pull: unknown): unknown {
  if (!pull || typeof pull !== 'object') return pull;
  const p = pull as Record<string, any>;
  return {
    state: p.state, merged: p.merged, merged_at: p.merged_at ?? null, merge_commit_sha: p.merge_commit_sha ?? null,
    updated_at: p.updated_at ?? null, mergeable_state: p.mergeable_state ?? null, draft: p.draft,
    ...(p.merged_by?.login ? { merged_by: { login: p.merged_by.login } } : {}),
    head: { sha: p.head?.sha, ref: p.head?.ref, repo: p.head?.repo ? { full_name: p.head.repo.full_name } : null },
    base: { ref: p.base?.ref },
  };
}

type PrRef = { workspaceId: string; repoFullName: string; prNumber: number };

/** The kernel delivery of a PR by a plain read on this host: ownership, when the control plane did not answer. */
async function kernelDeliveryHere(p: PrRef, deps?: ClientDeps): Promise<string | null> {
  if (deps?.kernelDeliveryOf) return deps.kernelDeliveryOf(p);
  return (await import('./kernel-heal')).kernelDeliveryIdOfPr(p);
}

/**
 * T17 to T19 from the GitHub webhook, the reconcile and refresh sweeps and the dependency gate: a PR
 * closed, merged or reopened, applied where the kernel is hosted (AC-9). The seam's contract, unchanged:
 * false = the kernel does not own the PR; throws `KernelObservationFailed` when it does but its live read
 * failed, the caller's `pull` recorded unapplied and the fast heal scheduled.
 *
 * A control plane that does not answer is that same failed read: this host records the caller's
 * observation unapplied (a fact, as a render does: AC-3) and schedules the heal, which applies it where
 * the kernel is hosted. So a close GitHub sends once is never lost, and legacy never acts on a kernel PR.
 * During release skew it is applied here (`doorOrHereOnSkew`).
 */
export async function observePrState(p: KernelOps['observe_pr_state']['input'], c: DoorCall): Promise<boolean> {
  const input = p.pull === undefined ? p : { ...p, pull: pullForKernel(p.pull) };
  let seen: KernelOps['observe_pr_state']['result'];
  try {
    seen = await doorOrHereOnSkew('observe_pr_state', input, c, `the close or reopen of ${p.repoFullName}#${p.prNumber}`);
  } catch (err) {
    if (err instanceof KernelObservationFailed) throw err;
    // Unanswered, refused (an installation that did not resolve) or failed (500): nothing was applied,
    // and that says nothing about who owns the PR. Ownership is read here, so a kernel PR is never
    // handed to the legacy close: its observation is recorded unapplied and healed where the kernel is hosted.
    const deliveryId = await kernelDeliveryHere(p, c.deps);
    if (!deliveryId) return false;
    await (c.deps?.recordUnapplied ?? recordCloseUnapplied)(deliveryId, input);
    throw new KernelObservationFailed(deliveryId, `the control plane did not apply it (${doorErrorWhy(err)})`);
  }
  if (seen.observationFailed) throw new KernelObservationFailed(seen.observationFailed.deliveryId, seen.observationFailed.reason);
  return seen.owned;
}

function doorErrorWhy(err: unknown): string {
  if (err instanceof ControlPlaneUnavailableError) return `the control plane did not answer: ${err.why}`;
  return err instanceof Error ? err.message : String(err);
}

async function recordCloseUnapplied(deliveryId: string, p: KernelOps['observe_pr_state']['input']): Promise<void> {
  if (p.pull) {
    // Records the fact and schedules the heal (render-observation.ts); an open PR records nothing.
    const { recordPrStateObserved } = await import('./render-observation');
    const recorded = await recordPrStateObserved({ workspaceId: p.workspaceId, repoFullName: p.repoFullName, prNumber: p.prNumber, pull: p.pull, source: p.source })
      .catch((err) => { console.error(`[workflow] could not record the observed close of ${p.repoFullName}#${p.prNumber}:`, err); return false; });
    if (recorded) return;
  }
  // No observation of its own (a sweep): the heal and the floor read the PR again.
  await (await import('./kernel-heal')).scheduleKernelHeal(deliveryId);
}

/**
 * T3 from the `synchronize` webhook: the PR head moved, applied where the kernel is hosted (AC-9).
 * True = the kernel owns the PR and the legacy re-review must not run. A control plane that does not
 * answer has the push parked for the floor (GitHub sends it once), and ownership is read here.
 */
export async function observeHead(p: KernelOps['observe_head']['input'], c: DoorCall): Promise<boolean> {
  try {
    return await doorOrHereOnSkew('observe_head', p, c, `the push to ${p.repoFullName}#${p.prNumber}`);
  } catch (err) {
    // Unanswered (parked for the floor), refused or failed: ownership is read here either way, so
    // legacy never acts beside the kernel on its PR.
    const owned = (await kernelDeliveryHere(p, c.deps)) !== null;
    if (owned && !(err instanceof ControlPlaneUnavailableError)) console.error(`[workflow] observe_head for ${p.repoFullName}#${p.prNumber} was not applied (${doorErrorWhy(err)}); the kernel owns the PR, so legacy stays out and the floor reads it again`);
    return owned;
  }
}

/** T29 from the `edited` webhook (a retarget), applied where the kernel is hosted (AC-9). As `observeHead`. */
export async function observeBase(p: KernelOps['observe_base']['input'], c: DoorCall): Promise<boolean> {
  try {
    return await doorOrHereOnSkew('observe_base', p, c, `the retarget of ${p.repoFullName}#${p.prNumber}`);
  } catch (err) {
    // Unanswered (parked for the floor), refused or failed: ownership is read here either way, so
    // legacy never acts beside the kernel on its PR.
    const owned = (await kernelDeliveryHere(p, c.deps)) !== null;
    if (owned && !(err instanceof ControlPlaneUnavailableError)) console.error(`[workflow] observe_base for ${p.repoFullName}#${p.prNumber} was not applied (${doorErrorWhy(err)}); the kernel owns the PR, so legacy stays out and the floor reads it again`);
    return owned;
  }
}

/** A door's caller-supplied idempotency key, when the request carries one. */
export function idempotencyKeyOf(req: { headers: { get(name: string): string | null } }): string | undefined {
  const k = req.headers.get('idempotency-key')?.trim();
  return k && /^[A-Za-z0-9:._\-]{8,200}$/.test(k) ? k : undefined;
}
