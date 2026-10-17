import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { INTERACTIVE_WORKER_RUNNER, LIVE_WORKER_STATUSES, NEEDS_INPUT_ERROR_PREFIX, TERMINAL_TASK_STATUSES } from '@buildd/shared';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { releaseConcurrencySeats } from '@/lib/interactive-detach';
import { wakeOldestPendingTaskOnCapacityFreed } from '@/lib/capacity-freed-wake';

/**
 * Settling a live worker that has no session left to report its own end.
 *
 * A question park (the runner's default `inputAsRetry` mode), a person's pause
 * and a parked cloud run all end the agent's session while the worker row
 * stays live (`waiting_input`, or `parkedUntil` set). That is right while the
 * task is open: the answer or resume continues it. When the task is cancelled
 * or deleted, nothing will ever PATCH that row again. The abort push reaches
 * no session, so before this the row stayed `waiting_input`: an account slot
 * held (claim refused "all slots busy"), an open-ended "Has a question" bar on
 * Health, and the 24h waiting-input sweep later failing the cancelled task and
 * filing a retry of it.
 *
 * Exactly once: the write is a compare-and-swap out of the live set, and only
 * rows this call moved release a seat or fire an event. A repeat, or a race
 * with the runner's own terminal PATCH, moves nothing. The question itself is
 * kept in the worker's milestones and the task feed; `waitingFor` is cleared
 * so no surface reads it as still open and /respond refuses a late answer.
 *
 * A worker with a live session (running, or a question asked inside one) is
 * not touched here: it gets the abort push and reports its own end.
 */

/** Live, holding no session: the same rows `workerHoldsRunnerSlot` frees. */
export function sessionlessLiveWorkerSql(): SQL {
  return and(
    inArray(workers.status, [...LIVE_WORKER_STATUSES]),
    or(
      isNotNull(workers.parkedUntil),
      and(
        eq(workers.status, 'waiting_input'),
        or(
          sql`coalesce(${workers.error}, '') LIKE ${NEEDS_INPUT_ERROR_PREFIX + '%'}`,
          sql`${workers.waitingFor}->>'type' = 'pause'`,
        ),
      ),
    ),
  )!;
}

export type SettleCause = 'task_cancelled' | 'task_deleted' | 'task_ended';

const SETTLE_ERROR: Record<SettleCause, string> = {
  task_cancelled: 'Task cancelled while the agent was waiting; the question is closed',
  task_deleted: 'Task deleted while the agent was waiting; the question is closed',
  task_ended: 'Task ended while the agent was waiting; the question is closed',
};

interface SettledRow { id: string; taskId: string | null; accountId: string | null; workspaceId: string }

async function afterSettle(rows: SettledRow[]): Promise<void> {
  if (rows.length === 0) return;
  const steps: Array<[string, () => Promise<unknown>]> = [
    ['seat release', () => releaseConcurrencySeats(rows.map(r => r.accountId))],
  ];
  for (const r of rows) {
    steps.push(['worker event', () => triggerEvent(
      channels.workspace(r.workspaceId),
      events.WORKER_FAILED,
      { workerId: r.id, taskId: r.taskId, status: 'failed', settled: true },
    )]);
  }
  for (const ws of new Set(rows.map(r => r.workspaceId))) {
    steps.push(['capacity wake', () => wakeOldestPendingTaskOnCapacityFreed(ws, null)]);
  }
  for (const [label, step] of steps) {
    try {
      await step();
    } catch (err) {
      console.error(`[sessionless-settle] ${label} failed:`, err);
    }
  }
}

async function settleWhere(where: SQL, cause: SettleCause): Promise<SettledRow[]> {
  const now = new Date();
  const rows = await db
    .update(workers)
    .set({
      status: 'failed',
      exitCause: 'task_cancelled',
      error: SETTLE_ERROR[cause],
      waitingFor: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(where)
    .returning({ id: workers.id, taskId: workers.taskId, accountId: workers.accountId, workspaceId: workers.workspaceId });
  await afterSettle(rows);
  return rows;
}

/** Settle one task's sessionless live workers. Call on cancel, and before a delete. */
export async function settleSessionlessWorkersOfTask(taskId: string, cause: SettleCause): Promise<number> {
  return (await settleWhere(and(eq(workers.taskId, taskId), sessionlessLiveWorkerSql())!, cause)).length;
}

/**
 * The repair sweep: every sessionless live runner worker whose task is gone
 * (deleted) or terminal. Catches rows left before cancel and delete settled
 * them, and any door that ends a task without calling the above. An
 * interactive (`mcp`) worker is detached by lib/interactive-detach.ts instead.
 */
export async function settleOrphanedSessionlessWorkers(accountId?: string): Promise<number> {
  const taskEnded = sql`(
    ${workers.taskId} IS NULL
    OR EXISTS (SELECT 1 FROM ${tasks} t WHERE t.id = ${workers.taskId} AND t.status IN (${sql.join(TERMINAL_TASK_STATUSES.map(s => sql`${s}`), sql`, `)}))
  )`;
  const where = and(
    sessionlessLiveWorkerSql(),
    ne(workers.runner, INTERACTIVE_WORKER_RUNNER),
    taskEnded,
    accountId ? eq(workers.accountId, accountId) : undefined,
  )!;
  return (await settleWhere(where, 'task_ended')).length;
}
