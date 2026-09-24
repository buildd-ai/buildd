/**
 * "A worker has the fix" — the one signal that lets the PR activity comment move
 * from `fix N of M queued` to `Fixing`.
 *
 * The comment used to say "buildd is pushing fixes to this branch" the moment a
 * request-changes review queued a builder attempt, while that task sat pending
 * with no worker. This is written from the claim route instead, after the
 * atomic claim succeeded, so "Fixing" is only ever true.
 *
 * Best-effort, like every PR activity write: failures log and return.
 */

import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { appendPrActivity, taskActivityUrl } from './pr-activity-comment';

export interface ClaimedTaskShape {
  id: string;
  workspaceId: string;
  taskClass?: string | null;
  reviewerRetryPrNumber?: number | null;
  ciRetryPrNumber?: number | null;
  context?: unknown;
}

/**
 * The PR this claimed task is fixing, or null when it is not a fix attempt.
 * Reads the same columns the fix-task inserts write (`reviewerRetryPrNumber`
 * for builder-after-review, `ciRetryPrNumber` for a CI retry).
 */
export function fixAttemptOf(task: ClaimedTaskShape): {
  prNumber: number;
  iteration: number | null;
  maxIterations: number | null;
} | null {
  const prNumber = task.reviewerRetryPrNumber ?? task.ciRetryPrNumber ?? null;
  if (prNumber == null) return null;
  const ctx = (task.context && typeof task.context === 'object' ? task.context : {}) as Record<string, unknown>;
  return {
    prNumber,
    iteration: typeof ctx.iteration === 'number' ? ctx.iteration : null,
    maxIterations: typeof ctx.maxIterations === 'number' ? ctx.maxIterations : null,
  };
}

export async function announceFixClaimed(task: ClaimedTaskShape): Promise<void> {
  const fix = fixAttemptOf(task);
  if (!fix) return;
  try {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, task.workspaceId),
      columns: { id: true },
      with: { githubRepo: { columns: { fullName: true }, with: { installation: { columns: { installationId: true } } } } },
    });
    const installationId = ws?.githubRepo?.installation?.installationId;
    const repoFullName = ws?.githubRepo?.fullName;
    if (!installationId || !repoFullName) return;
    await appendPrActivity({
      installationId,
      repoFullName,
      prNumber: fix.prNumber,
      entry: {
        kind: 'fix_started',
        iteration: fix.iteration,
        maxIterations: fix.maxIterations,
        taskUrl: taskActivityUrl(task.id),
      },
      // A PR buildd never announced on stays comment-free.
      onlyIfPresent: true,
      workspaceId: task.workspaceId,
    });
  } catch (err) {
    console.warn(`[pr-activity] could not announce fix claim for task ${task.id}:`, err instanceof Error ? err.message : err);
  }
}
