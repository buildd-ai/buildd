/**
 * The I/O half of `./task-estimate-actuals.ts`: when a work task that has a
 * frozen estimate settles, store what it actually took in
 * `task_estimate_actuals` (its own table; the estimate row is never updated).
 *
 * Called on every `task.completed` and rewritten each time: the worker's
 * completion records agent time, a later merge fills in wall time. A task with
 * no estimate (team not opted in, or created before the switch) records
 * nothing: there is nothing to score it against. Never throws.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from './db/client';
import { taskEstimateActuals, taskEstimates, tasks, workers } from './db/schema';
import { computeTaskActuals, type ActualsSession } from './task-estimate-actuals';

export type RecordActualsOutcome = 'recorded' | 'skipped' | 'failed';

export async function recordTaskActuals(taskId: string): Promise<RecordActualsOutcome> {
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { id: true, workspaceId: true, taskClass: true },
    });
    if (!task || (task.taskClass ?? 'work') !== 'work') return 'skipped';

    const [estimate] = await db
      .select({ teamId: taskEstimates.teamId })
      .from(taskEstimates)
      .where(eq(taskEstimates.taskId, taskId))
      .limit(1);
    if (!estimate) return 'skipped';

    const [sessions, children] = await Promise.all([
      db.select({
        taskId: workers.taskId, startedAt: workers.startedAt, completedAt: workers.completedAt,
        inputTokens: workers.inputTokens, outputTokens: workers.outputTokens, mergedAt: workers.mergedAt,
      }).from(workers).where(and(
        eq(workers.taskId, taskId), eq(workers.status, 'completed'),
        isNotNull(workers.startedAt), isNotNull(workers.completedAt),
      )),
      db.select({ taskClass: tasks.taskClass }).from(tasks).where(eq(tasks.parentTaskId, taskId)),
    ]);

    const a = computeTaskActuals({ taskClass: task.taskClass, sessions: sessions as ActualsSession[], children });
    if (!a) return 'skipped';

    const values = {
      agentMinutes: a.agentMinutes,
      tokens: Math.round(a.tokens),
      repairs: a.repairs,
      workerCount: a.workerCount,
      firstStartedAt: a.firstStartedAt,
      wallMinutes: a.wallMinutes,
      wallBasis: a.wallBasis,
      recordedAt: new Date(),
    };
    await db
      .insert(taskEstimateActuals)
      .values({ teamId: estimate.teamId, workspaceId: task.workspaceId, taskId, ...values })
      .onConflictDoUpdate({ target: taskEstimateActuals.taskId, set: values });
    return 'recorded';
  } catch (err) {
    const e = err as { name?: string; code?: string } | null;
    console.warn(`[task-estimate] actuals failed for task ${taskId}: ${e?.name ?? 'Error'}${e?.code ? ` (${e.code})` : ''}`);
    return 'failed';
  }
}

