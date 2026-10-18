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

/** `tasks.result.errorType` the cascade writes. */
export const DEPENDENCY_FAILED_ERROR_TYPE = 'dependency_failed';

export interface DependencyFailure {
  /** The dependency whose failure failed this task. */
  taskId: string;
  title: string | null;
}

/** The text rows written before `errorType` existed still carry. */
const LEGACY_ERROR_RE = /^Blocked: dependency "([\s\S]*)" \(([0-9a-f-]{36})\) failed$/i;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `result` the cascade writes for a task whose dependency `dep` failed. */
export function dependencyFailedResult(dep: { id: string; title: string | null }): {
  error: string;
  errorType: typeof DEPENDENCY_FAILED_ERROR_TYPE;
  blockedBy: DependencyFailure;
} {
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
