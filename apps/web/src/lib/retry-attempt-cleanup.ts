import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, eq, or, inArray } from 'drizzle-orm';
import { applyTaskCancelSideEffects } from '@/lib/task-cancel';
import type { TaskStatusValue } from '@buildd/shared';

export interface RetryTaskCancelInput {
  workspaceId: string;
  prNumber: number;
  reason: string;
}

/**
 * Cancel all open/pending retry-class attempt tasks (taskClass='attempt') that
 * target a specific PR. Called when the PR merges or closes to prevent retry
 * attempts from running against a PR that no longer needs them.
 *
 * Handles all three retry types:
 * - ciRetryPrNumber: CI failure retries
 * - conflictRetryPrNumber: Merge conflict retries
 * - reviewerRetryPrNumber: Reviewer-requested fix retries
 */
export async function cancelRetryAttemptsForMergedPr(input: RetryTaskCancelInput): Promise<void> {
  const { workspaceId, prNumber, reason } = input;

  // Statuses we should cancel: pending, assigned, in progress, or review (legacy)
  const openStatuses: TaskStatusValue[] = ['pending', 'assigned', 'in_progress', 'review'];

  // Find all open retry-attempt tasks targeting this PR
  const retryTasks = await db.query.tasks.findMany({
    where: and(
      eq(tasks.workspaceId, workspaceId),
      eq(tasks.taskClass, 'attempt'),
      or(
        eq(tasks.ciRetryPrNumber, prNumber),
        eq(tasks.conflictRetryPrNumber, prNumber),
        eq(tasks.reviewerRetryPrNumber, prNumber),
      ),
      inArray(tasks.status, openStatuses),
    ),
    columns: {
      id: true,
      status: true,
      missionId: true,
    },
  });

  if (retryTasks.length === 0) {
    return;
  }

  console.log(`[retry-cleanup] Cancelling ${retryTasks.length} retry attempt(s) for PR #${prNumber} (${reason})`);

  for (const task of retryTasks) {
    const [cancelled] = await db
      .update(tasks)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(tasks.id, task.id))
      .returning({ id: tasks.id });

    if (cancelled) {
      await applyTaskCancelSideEffects({
        id: task.id,
        workspaceId,
        missionId: task.missionId,
      });
    }
  }
}

/**
 * Get the PR number from a retry task.
 * Supports ciRetryPrNumber, conflictRetryPrNumber, and reviewerRetryPrNumber.
 */
export function getRetryTaskPrNumber(task: {
  ciRetryPrNumber?: number | null;
  conflictRetryPrNumber?: number | null;
  reviewerRetryPrNumber?: number | null;
}): number | null {
  return task.conflictRetryPrNumber ?? task.reviewerRetryPrNumber ?? task.ciRetryPrNumber ?? null;
}
