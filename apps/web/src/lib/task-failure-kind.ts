/**
 * What kind of failure a failed task is: the worker's own work died
 * (`execution`: retry it, or switch backend), the work landed and the
 * follow-on surface audit rejected it (`verification`: retry the audit, never
 * the build), or it never ran because a task it depends on failed
 * (`dependency`: nothing of its own to retry; the way on is that task, spec
 * 072de598 I-14). The one classifier every failure surface reads, so none
 * offers "Retry on Claude" for work that shipped or never started, or "Retry
 * the audit" for a worker that crashed.
 */
import { isSurfaceAuditTask } from '@buildd/core/surface-audit';
import { dependencyFailureOf, RECOVERED_DEPENDENCY_STATUSES } from '@buildd/core/dependency-failure';

export type TaskFailureKind = 'execution' | 'verification' | 'dependency';

interface WorkerLike {
  status: string;
  prUrl?: string | null;
  mergedAt?: Date | string | number | null;
  prLifecycleStatus?: string | null;
}

export interface FailureTaskLike {
  id: string;
  title: string;
  status: string;
  /** `tasks.result` (or its digest: `errorType`, `error`), read for a dependency failure. */
  result?: unknown;
  /** Newest first. */
  workers?: readonly WorkerLike[] | null;
}

/** The newest worker produced a PR that merged (or finished clean with one): the implementation landed. */
function implementationLanded(t: FailureTaskLike): boolean {
  const w = t.workers?.[0];
  if (!w) return false;
  if (w.mergedAt || w.prLifecycleStatus === 'merged') return true;
  return w.status === 'completed' && !!w.prUrl;
}

/** Statuses after which the dependency no longer holds anything (the claim gate's satisfied set). */
const RECOVERED: ReadonlySet<string> = new Set(RECOVERED_DEPENDENCY_STATUSES);

/**
 * The failed task a never-run task still waits on, or null. An audit always
 * waits (the system re-queues it when that task completes). Any other task
 * waits only while that task is still failed: once it recovered, running this
 * one again is a real choice, and it is an `execution` retry again.
 */
export function failedDependencyOf(task: FailureTaskLike, siblings: readonly FailureTaskLike[]): { taskId: string; title: string | null } | null {
  if (task.status !== 'failed' || (task.workers?.length ?? 0) > 0) return null;
  const dep = dependencyFailureOf(task.result);
  if (!dep) return null;
  if (isSurfaceAuditTask(task.title)) return dep;
  const sibling = siblings.find(s => s.id === dep.taskId);
  return sibling && !RECOVERED.has(sibling.status) ? dep : null;
}

/**
 * `null` when the task has not failed. `siblings` are the mission's other
 * tasks (the task itself is ignored if present).
 */
export function classifyTaskFailure(task: FailureTaskLike, siblings: readonly FailureTaskLike[]): TaskFailureKind | null {
  if (task.status !== 'failed') return null;
  if (failedDependencyOf(task, siblings)) return 'dependency';
  const others = siblings.filter(s => s.id !== task.id);
  if (isSurfaceAuditTask(task.title)) {
    // The audit's own worker must have finished and reported; one that died or never ran is an execution failure.
    if (task.workers?.[0]?.status !== 'completed') return 'execution';
    return others.some(s => !isSurfaceAuditTask(s.title) && implementationLanded(s)) ? 'verification' : 'execution';
  }
  if (!implementationLanded(task)) return 'execution';
  // The mission has one audit; a failed one rejects every landed task it covers. One that never ran rejects nothing.
  return others.some(s => isSurfaceAuditTask(s.title) && s.status === 'failed' && !dependencyFailureOf(s.result)) ? 'verification' : 'execution';
}

/** The copy for a verification failure: the state, then its cause. Nothing restated. */
export function verificationFailedCopy(): { state: string; cause: string } {
  return { state: 'Implementation complete, verification failed', cause: 'The visual audit found issues.' };
}


// ── Who acts next (Living Spec d25d923d R-20) ───────────────────────────────

/**
 * What a task in trouble is waiting for, and so whether a person must act:
 * - `waiting`: another task holds it and it starts again by itself (no Retry,
 *   no red dot; the person acts, if at all, on that task). A task that never
 *   ran because its dependency failed (`dependency`) reads this way too: the
 *   failed task carries the red dot.
 * - `retrying`: buildd retries it by itself (infra backoff, a provider pause,
 *   a loop waiting on CI, a queued fix attempt); `resumesAt` when known.
 *   `Retry now` only speeds it up.
 * - `needs_person`: only a person moves it, and `cause` says what to change.
 *   A waiting task whose blocker was cancelled or failed is one (the safety
 *   net): nothing will merge for it to wake on.
 */
export type TaskTrouble =
  | { kind: 'waiting'; on: { taskId: string; title: string | null } }
  | { kind: 'retrying'; cause: RetryingCause; resumesAt: string | null }
  | { kind: 'needs_person'; cause: NeedsPersonCause; on?: { taskId: string; title: string | null } };

export type RetryingCause = 'infra' | 'budget' | 'loop' | 'attempt';
export type NeedsPersonCause =
  | 'attempts_exhausted' | 'auth' | 'contract' | 'policy'
  | 'blocker_failed' | 'blocker_cancelled' | 'verification' | 'execution';

export interface TroubleTaskLike extends FailureTaskLike {
  startAt?: Date | string | null;
  context?: Record<string, unknown> | null;
  dependsOn?: readonly string[] | null;
  loopState?: string | null;
  taskClass?: string | null;
}

function futureIso(at: Date | string | null | undefined, now: Date): string | null {
  if (!at) return null;
  const d = new Date(at);
  return Number.isFinite(d.getTime()) && d > now ? d.toISOString() : null;
}

/** A dependency that completed but whose newest PR has not merged still holds its dependents. */
function stillHolds(dep: FailureTaskLike): boolean {
  if (dep.status !== 'completed') return !RECOVERED.has(dep.status);
  const w = dep.workers?.[0];
  return !!w?.prUrl && !w.mergedAt && w.prLifecycleStatus !== 'merged';
}

const AUTH_RE = /not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|\b401\b|credential/i;
const EXHAUSTED_RE = /after \d+ (?:worker )?attempts|consecutive attempts|retries? exhausted|retry cap/i;

/** What a person must change for a failed task's own work to run again. */
function personCauseOf(result: unknown): NeedsPersonCause {
  const r = (result && typeof result === 'object' ? result : {}) as { errorType?: unknown; error?: unknown };
  const type = typeof r.errorType === 'string' ? r.errorType : '';
  const error = typeof r.error === 'string' ? r.error : '';
  if (type === 'auth_failure' || AUTH_RE.test(error)) return 'auth';
  if (type === 'infra_stalled' || EXHAUSTED_RE.test(error)) return 'attempts_exhausted';
  if (type.endsWith('_contract_violation')) return 'contract';
  if (type === 'session_budget_capped' || /policy|gate/.test(type)) return 'policy';
  return 'execution';
}

/**
 * `null` for a task in no trouble (running, merged, queued with nothing
 * holding it). `siblings` are the tasks it may depend on (its mission's).
 */
export function classifyTaskTrouble(task: TroubleTaskLike, siblings: readonly FailureTaskLike[], now: Date = new Date()): TaskTrouble | null {
  if (task.status === 'failed') {
    const kind = classifyTaskFailure(task, siblings);
    if (kind === 'dependency') return { kind: 'waiting', on: failedDependencyOf(task, siblings)! };
    if (kind === 'verification') return { kind: 'needs_person', cause: 'verification' };
    return { kind: 'needs_person', cause: personCauseOf(task.result) };
  }
  if (task.status !== 'pending') return null;

  const deps = (task.dependsOn ?? [])
    .map(id => siblings.find(s => s.id === id))
    .filter((d): d is FailureTaskLike => !!d);
  const ref = (d: FailureTaskLike) => ({ taskId: d.id, title: d.title });
  const dead = deps.find(d => d.status === 'cancelled') ?? deps.find(d => d.status === 'failed');
  if (dead) return { kind: 'needs_person', cause: dead.status === 'cancelled' ? 'blocker_cancelled' : 'blocker_failed', on: ref(dead) };
  const holding = deps.find(stillHolds);
  if (holding) return { kind: 'waiting', on: ref(holding) };

  const ctx = task.context ?? {};
  const resumesAt = futureIso(task.startAt, now);
  if (ctx.budgetExhausted === true && resumesAt) return { kind: 'retrying', cause: 'budget', resumesAt };
  if (typeof ctx.infraRetryCount === 'number' && ctx.infraRetryCount > 0 && resumesAt) return { kind: 'retrying', cause: 'infra', resumesAt };
  if (task.loopState === 'condition_unmet') return { kind: 'retrying', cause: 'loop', resumesAt };
  if (task.taskClass === 'attempt') return { kind: 'retrying', cause: 'attempt', resumesAt };
  return null;
}

/**
 * The task page's trouble. A failed task was already classified against its
 * mission (`loadTaskFailure`), so that reading is reused: a `dependency`
 * failure waits on the failed task. A pending one is read against its own
 * `dependsOn` rows (`deps`, newest worker first), which may sit outside its
 * mission.
 */
export function taskPageTrouble(
  task: TroubleTaskLike,
  deps: readonly FailureTaskLike[],
  failure: { kind: TaskFailureKind | null; waitingOn: { taskId: string; title: string | null } | null } | null,
  now: Date = new Date(),
): TaskTrouble | null {
  if (task.status === 'failed') {
    if (failure?.kind === 'dependency' && failure.waitingOn) return { kind: 'waiting', on: { taskId: failure.waitingOn.taskId, title: failure.waitingOn.title } };
    if (failure?.kind === 'verification') return { kind: 'needs_person', cause: 'verification' };
    return { kind: 'needs_person', cause: personCauseOf(task.result) };
  }
  return classifyTaskTrouble(task, deps, now);
}

/**
 * The one line the action zone says about a held task: what it waits on and,
 * for a buildd retry, when it resumes (`resumesAt`, rendered as a time).
 * `null` when the zone's own notices already say it (a failed task's cards).
 */
export function troubleLine(t: TaskTrouble | null): { text: string; on: { taskId: string; title: string | null } | null; resumesAt: string | null } | null {
  if (!t) return null;
  const name = (on: { title: string | null }) => (on.title?.trim() ? `“${on.title.trim()}”` : 'the task it depends on');
  if (t.kind === 'waiting') return { text: `Waiting on ${name(t.on)}. It starts by itself when that task merges.`, on: t.on, resumesAt: null };
  if (t.kind === 'retrying') {
    return { text: t.resumesAt ? 'buildd retries this by itself. Resumes at' : 'buildd retries this by itself.', on: null, resumesAt: t.resumesAt };
  }
  if (t.on) {
    const how = t.cause === 'blocker_cancelled' ? 'was cancelled' : 'failed';
    return { text: `${name(t.on)} ${how}, so nothing will start this. Start it anyway or cancel it.`, on: t.on, resumesAt: null };
  }
  return null;
}

export { waitingOnFailedCopy } from '@buildd/core/dependency-failure';
