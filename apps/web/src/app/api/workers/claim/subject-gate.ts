/**
 * Pre-claim subject-liveness gate (§6 of docs/design/task-subject-anchors.md).
 *
 * Filters tasks whose subject PR has been reconciled (dead) before a worker is
 * dispatched. Reads persisted task columns only — zero extra DB calls on the
 * hot path.
 */

import { tasks } from '@buildd/core/db/schema';
import { isNull, ne, or, sql } from 'drizzle-orm';

/**
 * SQL eligibility predicate for the subject-liveness gate.
 *
 * A task is eligible when:
 *   - It has no subject anchor (subjectKind IS NULL), OR
 *   - Its subject is not a pull_request, OR
 *   - Its subject resolution is not 'reconciled' (PR is live or unknown)
 *
 * Tasks with subjectResolution = 'reconciled' are tasks where the sweep
 * determined that the subject PR is dead (closed/merged with no live
 * successor). They must not be claimed.
 *
 * This predicate is inserted into the claimableConditions array at position
 * after the held-mission gate and before the dependency gate, per §6 ordering.
 */
export function subjectLivenessCondition() {
  return or(
    isNull(tasks.subjectKind),
    ne(tasks.subjectKind, 'pull_request'),
    isNull(tasks.subjectResolution),
    ne(tasks.subjectResolution, 'reconciled'),
  );
}

/**
 * Per-task in-loop liveness check. Reads persisted task columns only.
 *
 * Returns false when the task's subject PR has been marked reconciled (dead)
 * by the reconciliation sweep. Returns true in all other cases, including
 * tasks with no subject anchor (backwards-compatible no-op).
 */
export function subjectStillLive(task: {
  subjectKind?: string | null;
  subjectPrNumber?: number | null;
  subjectResolution?: string | null;
}): boolean {
  if (!task.subjectKind) return true;
  if (task.subjectKind !== 'pull_request') return true;
  if (!task.subjectPrNumber) return true;
  return task.subjectResolution !== 'reconciled';
}
