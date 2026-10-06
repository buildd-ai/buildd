/**
 * What kind of failure a failed task is: the worker's own work died
 * (`execution`: retry it, or switch backend) or the work landed and the
 * follow-on surface audit rejected it (`verification`: retry the audit, never
 * the build). The one classifier every failure surface reads, so none offers
 * "Retry on Claude" for work that shipped, or "Retry the audit" for a worker
 * that crashed.
 */
import { isSurfaceAuditTask } from '@buildd/core/surface-audit';

export type TaskFailureKind = 'execution' | 'verification';

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

/**
 * `null` when the task has not failed. `siblings` are the mission's other
 * tasks (the task itself is ignored if present).
 */
export function classifyTaskFailure(task: FailureTaskLike, siblings: readonly FailureTaskLike[]): TaskFailureKind | null {
  if (task.status !== 'failed') return null;
  const others = siblings.filter(s => s.id !== task.id);
  if (isSurfaceAuditTask(task.title)) {
    // The audit's own worker must have finished and reported; one that died or never ran is an execution failure.
    if (task.workers?.[0]?.status !== 'completed') return 'execution';
    return others.some(s => !isSurfaceAuditTask(s.title) && implementationLanded(s)) ? 'verification' : 'execution';
  }
  if (!implementationLanded(task)) return 'execution';
  // The mission has one audit; a failed one rejects every landed task it covers.
  return others.some(s => isSurfaceAuditTask(s.title) && s.status === 'failed') ? 'verification' : 'execution';
}

/** The copy for a verification failure: the state, then its cause. Nothing restated. */
export function verificationFailedCopy(): { state: string; cause: string } {
  return { state: 'Implementation complete, verification failed', cause: 'The visual audit found issues.' };
}
