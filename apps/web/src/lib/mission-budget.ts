import { db } from '@buildd/core/db';
import { missions, missionNotes, workers, tasks } from '@buildd/core/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { notify } from '@/lib/pushover';

/**
 * Compute total USD spend for all workers across all tasks in a mission.
 * Returns 0 when the mission has no workers or no recorded spend.
 */
export async function getMissionSpendUsd(missionId: string): Promise<number> {
  const result = await db
    .select({ spend: sql<string>`COALESCE(SUM(${workers.costUsd}), '0')` })
    .from(workers)
    .innerJoin(tasks, eq(tasks.id, workers.taskId))
    .where(eq(tasks.missionId, missionId));
  return parseFloat(result[0]?.spend ?? '0');
}

/**
 * Atomically transition a mission to budget_exhausted, post a mission note,
 * and send a Pushover notification. Idempotent — only fires once per exhaustion event
 * (subsequent calls with an already-transitioned mission are no-ops).
 */
export async function exhaustMissionBudget(
  missionId: string,
  missionTitle: string,
  spendUsd: number,
  budgetUsd: number,
): Promise<void> {
  const [transitioned] = await db
    .update(missions)
    .set({ status: 'budget_exhausted', updatedAt: new Date() })
    .where(and(eq(missions.id, missionId), eq(missions.status, 'active')))
    .returning({ id: missions.id });

  if (!transitioned) return;

  const spendStr = spendUsd.toFixed(4);
  const budgetStr = budgetUsd.toFixed(2);

  await db.insert(missionNotes).values({
    missionId,
    authorType: 'system',
    type: 'warning',
    title: 'Budget exhausted',
    body: `$${spendStr} spent vs $${budgetStr} budget — no new tasks will be spawned. Raise costBudgetUsd to resume.`,
    status: 'open',
  }).catch(e => console.error('[mission-budget] Failed to insert note:', e));

  notify({
    app: 'tasks',
    title: `Budget exhausted: ${missionTitle}`,
    message: `$${spendStr} spent vs $${budgetStr} budget — spawning paused. Raise the budget to resume.`,
    priority: 0,
  });
}
