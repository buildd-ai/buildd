/**
 * A task failed only because a task it depends on failed
 * (`cascadeDependencyFailure` in apps/web/src/lib/task-dependencies.ts).
 *
 * Such a task never ran: no worker claimed it, so it has no attempt to retry
 * and nothing of its own went wrong. Every surface reads it through
 * `dependencyFailureOf`, so none presents it as a worker failure or as a check
 * that broke (spec 072de598 I-14): it waits on the failed task, which is where
 * the recovery is. Pure; safe on the client.
 */

import { TERMINAL_TASK_STATUSES, type TerminalTaskStatus } from '@buildd/shared';

/** `tasks.result.errorType` the cascade writes. */
export const DEPENDENCY_FAILED_ERROR_TYPE = 'dependency_failed';

export interface DependencyFailure {
  /** The dependency whose failure failed this task. */
  taskId: string;
  title: string | null;
}

/** A dependency in one of these no longer holds back a task that failed on it: it finished, or was dropped. */
export const RECOVERED_DEPENDENCY_STATUSES: readonly TerminalTaskStatus[] = TERMINAL_TASK_STATUSES.filter(s => s !== 'failed');

/** The text rows written before `errorType` existed still carry. */
const LEGACY_ERROR_RE = /^Blocked: dependency "([\s\S]*)" \(([0-9a-f-]{36})\) failed$/i;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The error a cross-workspace dependency's failure leaves: names no task (spec e28018c2 R-13). */
export const CROSS_WORKSPACE_DEPENDENCY_FAILED_ERROR = 'Blocked: a task this one depends on, in another workspace, failed';

/**
 * The `result` the cascade writes for a task whose dependency `dep` failed.
 * A dependency in another workspace is stored by id only: the dependent's
 * readers may not see that workspace, so its title is resolved per viewer
 * when a surface renders it, never copied here.
 */
export function dependencyFailedResult(dep: { id: string; title: string | null }, opts: { crossWorkspace?: boolean } = {}): {
  error: string;
  errorType: typeof DEPENDENCY_FAILED_ERROR_TYPE;
  blockedBy: DependencyFailure;
} {
  if (opts.crossWorkspace) {
    return {
      error: CROSS_WORKSPACE_DEPENDENCY_FAILED_ERROR,
      errorType: DEPENDENCY_FAILED_ERROR_TYPE,
      blockedBy: { taskId: dep.id, title: null },
    };
  }
  return {
    error: `Blocked: dependency "${dep.title || dep.id}" (${dep.id}) failed`,
    errorType: DEPENDENCY_FAILED_ERROR_TYPE,
    blockedBy: { taskId: dep.id, title: dep.title },
  };
}

/**
 * The dependency a failed task is waiting on, read from its `result`; null for
 * any other failure. Rows from before `errorType` are recognised by their text.
 */
export function dependencyFailureOf(result: unknown): DependencyFailure | null {
  if (!isObject(result)) return null;
  const by = result.blockedBy;
  if (result.errorType === DEPENDENCY_FAILED_ERROR_TYPE && isObject(by) && typeof by.taskId === 'string') {
    return { taskId: by.taskId, title: typeof by.title === 'string' ? by.title : null };
  }
  const m = typeof result.error === 'string' ? LEGACY_ERROR_RE.exec(result.error) : null;
  return m ? { taskId: m[2].toLowerCase(), title: m[1] || null } : null;
}

/**
 * The copy for a task waiting on a failed dependency: the state, then its
 * cause. An audit is re-queued by the system; any other task offers Retry
 * again once its dependency recovers, and the copy says which.
 */
export function waitingOnFailedCopy(dep: { title: string | null } | null, opts: { requeuesItself: boolean }): { state: string; cause: string } {
  const title = dep?.title?.trim();
  const then = opts.requeuesItself ? 'This starts once it completes.' : 'It can run again once that task completes.';
  return { state: 'Waiting on failed work', cause: `${title ? `“${title}”` : 'A task this one needs'} failed. ${then}` };
}
