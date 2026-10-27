import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { OPEN_TASK_STATUSES } from '@buildd/shared';

/** Whether a batched criterion check run of this mission is queued or running, for the Re-verify control. */
export function reverifyStateOf(statuses: readonly string[]): 'idle' | 'queued' | 'running' {
  if (statuses.includes('in_progress')) return 'running';
  return statuses.some((s) => (OPEN_TASK_STATUSES as readonly string[]).includes(s)) ? 'queued' : 'idle';
}

export async function readReverifyState(missionId: string): Promise<'idle' | 'queued' | 'running'> {
  const rows = await db.select({ status: tasks.status }).from(tasks)
    .where(and(eq(tasks.missionId, missionId), sql`${tasks.context} ? 'specCriterionBatch'`, sql`${tasks.status} IN ('pending', 'assigned', 'in_progress')`));
  return reverifyStateOf(rows.map((r) => r.status));
}
