/**
 * Retry lineage shared by every registry experiment.
 *
 * Extracted from `./model-routing-experiment.ts` when the CBM-access
 * experiment became its second caller, so "which task does an attempt inherit
 * its arm from" has one definition. It is a leaf module on purpose: the pure
 * halves of experiments import it, and `model-routing-experiment.ts` itself
 * pulls in the tier registry (and so the db client).
 */

export function isReviewerTask(category: string | null | undefined, reviewerFor: unknown): boolean {
  return category === 'review' || (typeof reviewerFor === 'string' && reviewerFor.length > 0);
}

/**
 * The task whose assignment an attempt should inherit, or null when the task
 * draws (or is judged) on its own.
 *
 * Only `taskClass: 'attempt'` tasks inherit: CI retries, conflict retries and
 * reviewer-requested rework all carry `parentTaskId` + class `attempt`.
 * `parentTaskId` on a `work` task is NOT retry lineage (a task created by a
 * worker records its creator there), so it must not inherit. Reviewer tasks
 * are attempts too but are never enrolled — the reviewer is held fixed while
 * an experiment runs.
 */
export function resolveInheritanceParent(task: {
  parentTaskId?: string | null;
  taskClass?: string | null;
  category?: string | null;
  reviewerFor?: unknown;
}): string | null {
  if (task.taskClass !== 'attempt') return null;
  if (isReviewerTask(task.category, task.reviewerFor)) return null;
  return task.parentTaskId || null;
}
