import { db } from '@buildd/core/db';
import { accounts, tasks, workers } from '@buildd/core/db/schema';
import { and, eq, inArray, ne, notExists, sql, type SQL } from 'drizzle-orm';
import {
  INTERACTIVE_WORKER_RUNNER,
  LIVE_WORKER_STATUSES,
  TERMINAL_TASK_STATUSES,
  isTerminalTaskStatus,
  type WorkerExitCause,
} from '@buildd/shared';
import { releaseAndNotify, resolveReleaseReasonForTask } from '@/lib/path-claim-release';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { wakeOldestPendingTaskOnCapacityFreed } from '@/lib/capacity-freed-wake';
import { wakeTask } from '@/lib/dispatch-authority';
import { RELEASED_SLOT_WORKER_ERROR } from '@/lib/worker-termination';

/**
 * Detaching an interactive worker: the row `claim_task` minted for a local
 * Claude/Codex session (`workers.runner = 'mcp'`).
 *
 * Buildd cannot stop that process. It runs on someone's own machine and no
 * runner holds it, so an abort push reaches nothing. What buildd CAN do is stop
 * counting it: move the row out of the live set, give back its concurrency
 * seat and release its task's path claims. The session itself keeps running;
 * its next write to this worker is refused like any write to a terminal worker.
 *
 * Two doors, one primitive:
 *  - "Release slot" in the task UI (POST /api/workers/[id]/release-slot).
 *  - Auto-heal: a live interactive worker whose task already ended. The
 *    session usually stays open and keeps calling buildd, which keeps the row
 *    fresh for the idle-TTL reaper, so without this it holds a seat
 *    indefinitely. Run when a merge completes the task, when the task is
 *    cancelled, on every claim (team-scoped), on the session's own MCP calls,
 *    and on the hourly maintenance sweep, which also repairs rows leaked before
 *    this shipped.
 *
 * Exactly once: the worker write is a compare-and-swap out of the live set, and
 * only the caller that wins it releases the seat. A repeat, or a race with the
 * session's own complete_task, is a no-op.
 */

/**
 * A task's terminal write and its worker's can land in either order inside one
 * completion request. The sweeps leave a task this long before detaching its
 * worker, so they never cut into a completion that is still in flight.
 */
export const DETACH_GRACE_MS = 30_000;

export type DetachActor =
  | { kind: 'user'; userId: string; label: string }
  | { kind: 'system' };

export interface DetachResult {
  /** True only for the call that moved the row out of the live set. */
  detached: boolean;
  /** Why nothing happened, when nothing did. */
  reason?: 'not_found' | 'not_interactive' | 'already_released';
  workerStatus?: string;
  taskStatus?: string | null;
}

/**
 * What a detached worker is recorded as. A completed task's worker completed
 * (its PR landed); otherwise it ends as bookkeeping, never charged a retry.
 */
export function detachedWorkerOutcome(taskStatus: string | null | undefined): {
  status: 'completed' | 'failed';
  exitCause: WorkerExitCause | null;
  error: string | null;
} {
  if (taskStatus === 'completed') return { status: 'completed', exitCause: null, error: null };
  if (taskStatus === 'cancelled') return { status: 'failed', exitCause: 'task_cancelled', error: RELEASED_SLOT_WORKER_ERROR };
  return { status: 'failed', exitCause: 'reassigned', error: RELEASED_SLOT_WORKER_ERROR };
}

/** The audit line written on the worker's timeline. */
export function detachAuditLabel(actor: DetachActor, reason: string): string {
  const who = actor.kind === 'user' ? actor.label : 'buildd';
  return `Slot released by ${who}: ${reason}. The local session was not stopped.`;
}

const liveInteractive = (): SQL => and(
  eq(workers.runner, INTERACTIVE_WORKER_RUNNER),
  inArray(workers.status, [...LIVE_WORKER_STATUSES]),
)!;

/**
 * Detach one interactive worker. Idempotent. Never changes a terminal task's
 * status or its PR; an open task goes back to pending so it can be picked up.
 */
export async function detachInteractiveWorker(input: {
  workerId: string;
  actor: DetachActor;
  reason: string;
  now?: Date;
}): Promise<DetachResult> {
  const now = input.now ?? new Date();
  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, input.workerId),
    columns: { id: true, taskId: true, accountId: true, workspaceId: true, status: true, runner: true },
  });
  if (!worker) return { detached: false, reason: 'not_found' };
  if (worker.runner !== INTERACTIVE_WORKER_RUNNER) return { detached: false, reason: 'not_interactive' };

  const task = worker.taskId
    ? await db.query.tasks.findFirst({ where: eq(tasks.id, worker.taskId), columns: { id: true, status: true } })
    : null;
  const taskStatus = task?.status ?? null;
  if (!(LIVE_WORKER_STATUSES as readonly string[]).includes(worker.status)) {
    return { detached: false, reason: 'already_released', workerStatus: worker.status, taskStatus };
  }

  const outcome = detachedWorkerOutcome(taskStatus);
  const milestone = { type: 'checkpoint', event: 'slot_released', label: detachAuditLabel(input.actor, input.reason), ts: now.getTime() };
  const [won] = await db
    .update(workers)
    .set({
      status: outcome.status,
      exitCause: outcome.exitCause,
      error: outcome.error,
      waitingFor: null,
      completedAt: now,
      updatedAt: now,
      milestones: sql`COALESCE(${workers.milestones}, '[]'::jsonb) || ${JSON.stringify([milestone])}::jsonb`,
    })
    .where(and(eq(workers.id, worker.id), liveInteractive()))
    .returning({ id: workers.id });
  if (!won) {
    return { detached: false, reason: 'already_released', taskStatus };
  }

  console.log(
    `[interactive-detach] worker ${worker.id} (task ${worker.taskId ?? '-'}, ${taskStatus ?? 'no task'}) ` +
    `detached by ${input.actor.kind === 'user' ? `user ${input.actor.userId}` : 'system'}: ${input.reason}`,
  );
  await afterDetach({ ...worker, taskStatus }, outcome.status);
  return { detached: true, workerStatus: outcome.status, taskStatus };
}

/**
 * Everything a normal terminal worker gets, for the one row this caller moved:
 * its seat, its task's path claims, the dashboards, and a capacity wake. Each
 * step logs and swallows its own failure; the worker write already committed.
 */
async function afterDetach(
  worker: { id: string; taskId: string | null; accountId: string | null; workspaceId: string; taskStatus: string | null },
  status: 'completed' | 'failed',
): Promise<void> {
  const steps: Array<[string, () => Promise<unknown>]> = [
    ['seat release', () => releaseConcurrencySeats([worker.accountId])],
  ];
  if (worker.taskId) {
    const taskId = worker.taskId;
    if (!isTerminalTaskStatus(worker.taskStatus)) {
      steps.push(['task requeue', () => requeueOpenTask(taskId)]);
    }
    steps.push(['path-claim release', async () => releaseAndNotify(taskId, await resolveReleaseReasonForTask(taskId))]);
  }
  steps.push(['worker event', () => triggerEvent(
    channels.workspace(worker.workspaceId),
    status === 'completed' ? events.WORKER_COMPLETED : events.WORKER_FAILED,
    { workerId: worker.id, taskId: worker.taskId, status, detached: true },
  )]);
  steps.push(['capacity wake', () => wakeOldestPendingTaskOnCapacityFreed(worker.workspaceId, worker.taskId)]);

  for (const [label, step] of steps) {
    try {
      await step();
    } catch (err) {
      console.error(`[interactive-detach] ${label} failed for worker ${worker.id}:`, err);
    }
  }
}

/**
 * Give back OAuth concurrency seats, one per entry, grouped by the account that
 * held each. The same decrement every terminal-worker path applies; it is a
 * no-op for an account that is not seat-based. A null account holds no seat.
 */
export async function releaseConcurrencySeats(accountIds: ReadonlyArray<string | null | undefined>): Promise<void> {
  const byAccount = new Map<string, number>();
  for (const id of accountIds) {
    if (id) byAccount.set(id, (byAccount.get(id) ?? 0) + 1);
  }
  for (const [accountId, count] of byAccount) {
    await db
      .update(accounts)
      .set({ activeSessions: sql`GREATEST(${accounts.activeSessions} - ${count}, 0)` })
      .where(and(eq(accounts.id, accountId), eq(accounts.authType, 'oauth')));
  }
}

/** An open task whose only worker was released goes back to the queue. */
async function requeueOpenTask(taskId: string): Promise<void> {
  const otherLive = db
    .select({ id: workers.id })
    .from(workers)
    .where(and(eq(workers.taskId, taskId), inArray(workers.status, [...LIVE_WORKER_STATUSES])));
  const [requeued] = await db
    .update(tasks)
    .set({ status: 'pending', claimedBy: null, claimedAt: null, expiresAt: null, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), ne(tasks.status, 'pending'), notTerminalTask(), notExists(otherLive)))
    .returning({ id: tasks.id });
  if (requeued) await wakeTask(taskId, 'task.requeued');
}

const notTerminalTask = (): SQL => sql`${tasks.status} NOT IN (${sql.join(TERMINAL_TASK_STATUSES.map(s => sql`${s}`), sql`, `)})`;

/**
 * Live interactive workers whose task has ended, for the sweeps. A task that
 * was deleted has ended too: its worker's task_id is set NULL and nothing else
 * would ever move it out of the live set (the session keeps it fresh, and no
 * task row exists to finish). The event door (`taskId`) never takes that arm. `accountId`
 * narrows to that account's team: the row holds no live work buildd can see
 * (its task is over), so any teammate's claim may free it, as with the reaper's
 * never-started arm. No `accountId` is the global repair sweep.
 */
export function endedTaskInteractiveScope(opts: { accountId?: string; taskId?: string; now: Date; graceMs: number }): SQL {
  const ended = opts.graceMs > 0
    ? sql`AND t_end.updated_at < ${new Date(opts.now.getTime() - opts.graceMs).toISOString()}::timestamptz`
    : sql``;
  const endedTask = sql`EXISTS (
      SELECT 1 FROM ${tasks} t_end
      WHERE t_end.id = ${workers.taskId}
      AND t_end.status IN (${sql.join(TERMINAL_TASK_STATUSES.map(s => sql`${s}`), sql`, `)})
      ${ended}
    )`;
  // Same grace as an ended task, measured on the worker itself; a floor of the
  // default grace so a zero-grace caller cannot cut into a delete in flight.
  const orphanCutoff = new Date(opts.now.getTime() - Math.max(opts.graceMs, DETACH_GRACE_MS)).toISOString();
  const deletedTask = sql`(${workers.taskId} IS NULL AND ${workers.updatedAt} < ${orphanCutoff}::timestamptz)`;
  return and(
    liveInteractive(),
    opts.taskId ? eq(workers.taskId, opts.taskId) : undefined,
    opts.taskId ? endedTask : sql`(${endedTask} OR ${deletedTask})`,
    opts.accountId
      ? sql`${workers.accountId} IN (
          SELECT sibling.id FROM ${accounts} sibling
          WHERE sibling.team_id = (SELECT owner.team_id FROM ${accounts} owner WHERE owner.id = ${opts.accountId})
        )`
      : undefined,
  )!;
}

/**
 * Detach every live interactive worker whose task has ended. Returns how many
 * this call detached. Never throws: it rides on claim, MCP and cron paths that
 * must not fail because a repair did.
 *
 * `taskId` with `graceMs: 0` is the event door (a merge or cancel just ended
 * that task, so there is no completion left in flight to wait for).
 */
export async function detachInteractiveWorkersOfEndedTasks(opts: {
  accountId?: string;
  taskId?: string;
  now?: Date;
  graceMs?: number;
  limit?: number;
} = {}): Promise<number> {
  const now = opts.now ?? new Date();
  let detached = 0;
  try {
    // Plain select, not the relational builder: this runs ahead of the
    // reaper's own findMany sequence on the claim path.
    const rows = await db
      .select({ id: workers.id, taskStatus: tasks.status })
      .from(workers)
      // Left join: a worker whose task row was deleted (task_id set NULL) has
      // no task to join, and is exactly the leak the orphan arm below repairs.
      .leftJoin(tasks, eq(tasks.id, workers.taskId))
      .where(endedTaskInteractiveScope({
        accountId: opts.accountId,
        taskId: opts.taskId,
        now,
        graceMs: opts.graceMs ?? DETACH_GRACE_MS,
      }))
      .limit(opts.limit ?? 100);
    for (const row of rows) {
      const r = await detachInteractiveWorker({
        workerId: row.id,
        actor: { kind: 'system' },
        reason: row.taskStatus ? `task ${row.taskStatus}` : 'task deleted',
        now,
      });
      if (r.detached) detached++;
    }
  } catch (err) {
    console.warn('[interactive-detach] ended-task sweep failed:', err instanceof Error ? err.message : err);
  }
  return detached;
}
