/**
 * The approval half of the landing clock (`approvedGreenAt` in lib/pr-landing.ts).
 *
 * Kept out of pr-landing.ts so that module's import surface stays what its door
 * tests mock; `landPr` loads this on demand and treats any failure as "unknown".
 */

import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';

/**
 * When the newest review round on this PR concluded (epoch ms), or null. The
 * reviewer's worker completion is the verdict landing; if its worker has not
 * stamped one yet (the approve door calls in the same breath), the review task's
 * own last update stands in for it.
 */
export async function readReviewApprovedAt(workspaceId: string, prNumber: number): Promise<number | null> {
  const [review] = await db
    .select({ id: tasks.id, updatedAt: tasks.updatedAt })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.category, 'review'),
        sql`${tasks.context}->>'prNumber' = ${String(prNumber)}`,
      ),
    )
    .orderBy(desc(tasks.createdAt))
    .limit(1);
  if (!review) return null;

  const [worker] = await db
    .select({ completedAt: workers.completedAt })
    .from(workers)
    .where(eq(workers.taskId, review.id))
    .orderBy(desc(workers.createdAt))
    .limit(1);

  const at = worker?.completedAt ?? review.updatedAt;
  return at ? at.getTime() : null;
}
