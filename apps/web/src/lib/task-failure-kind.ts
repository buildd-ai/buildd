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
import { dependencyFailureOf } from '@buildd/core/dependency-failure';

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
const RECOVERED = new Set(['completed', 'cancelled']);

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

export { waitingOnFailedCopy } from '@buildd/core/dependency-failure';
