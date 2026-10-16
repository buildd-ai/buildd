/**
 * The task transition a merged PR makes, for a PR the workflow kernel does not own (opened
 * before cutover, released to legacy, or the workspace's kill switch off). For a kernel-owned PR
 * the T17 statement makes it instead (lib/workflow/task-projection.ts), with the same rule:
 *
 *  - a task already completed stays as it is;
 *  - a local session (runner `mcp`) decides when it is done (it may still be planning PR B..D,
 *    which no open-PR check can see), so only its complete_task ends the task;
 *  - another open PR on the task (a stacked series) keeps it open: the last merge completes it;
 *  - otherwise the merge completes it, guarded on the row, because the worker's own completion
 *    can land between the read and this write and only the writer that flips it resolves it.
 *
 * `runMergedPrWork` calls this at the point the transition belongs, so its ordering against the
 * merge's other effects is unchanged.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { INTERACTIVE_WORKER_RUNNER } from '@buildd/shared';
import { otherOpenPrsOfTask } from '@/lib/task-open-prs';
import { deliveryOwnedTaskSql, taskCols } from '@/lib/workflow/pr-fact-scope';
import type { MergedPrTask, MergeTaskTransition } from '@/lib/pr-merged-work';

export function legacyCompleteTaskOnMerge(p: {
  repoFullName: string; prUrl: string; prNumber: number; runner?: string | null;
  /**
   * The caller is the kernel's own emit_pr_merged effect, queued before S4b (its T17 did not
   * project the task). Otherwise (the webhook's legacy path) a delivery-owned task is skipped: if
   * the kernel's observation threw, its floor applies T17, which completes the task itself. Only
   * when THIS PR is the delivery's: another PR of the task (a stacked series, a follow-up after
   * the delivery's PR was abandoned) is not the kernel's, and its merge completes the task here.
   */
  kernelEffect?: boolean;
}) {
  return async (task: MergedPrTask): Promise<MergeTaskTransition> => {
    if (task.status === 'completed') return 'already_completed';
    if (p.runner === INTERACTIVE_WORKER_RUNNER) {
      console.log(`Task ${task.id} stays open after PR #${p.prNumber} merged: interactive session completes its own task`);
      return 'not_flipped';
    }
    const openSiblingPrs = await otherOpenPrsOfTask(task.id, { prUrl: p.prUrl });
    if (openSiblingPrs.length > 0) {
      console.log(`Task ${task.id} stays open after PR #${p.prNumber} merged: ${openSiblingPrs.length} other PR(s) still open`);
      return 'not_flipped';
    }
    const [flipped] = await db
      .update(tasks)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(and(eq(tasks.id, task.id), ne(tasks.status, 'completed'), ...(p.kernelEffect ? [] : [sql`NOT ${deliveryOwnedTaskSql(taskCols(), { pr: { repoFullName: p.repoFullName, prNumber: p.prNumber } })}`])))
      .returning({ id: tasks.id });
    return flipped ? 'flipped' : 'not_flipped';
  };
}

/**
 * The branch-name match (`buildd/<id8>-…`) for a merged PR no worker row carries: completes the
 * task, guarded on the row. Never for the PR a task's delivery owns: that PR is merged by T17,
 * which completes its owner in its own statement, so a guess from the branch name must not race it.
 * Returns whether this write flipped the task.
 */
export async function completeTaskOnBranchMatchMerge(taskId: string, pr: { repoFullName: string; prNumber: number }): Promise<boolean> {
  const [flipped] = await db
    .update(tasks)
    .set({ status: 'completed', updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), ne(tasks.status, 'completed'), sql`NOT ${deliveryOwnedTaskSql(taskCols(), { pr })}`))
    .returning({ id: tasks.id });
  return !!flipped;
}
