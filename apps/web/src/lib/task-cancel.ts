import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { releaseAndNotify } from '@/lib/path-claim-release';
import { releaseCrossWorkspaceDependentsOf, resolveCompletedTask } from '@/lib/task-dependencies';
import { wakeTask } from '@/lib/dispatch-authority';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { settleSessionlessWorkersOfTask } from '@/lib/sessionless-worker-settle';
import { LIVE_WORKER_STATUSES } from '@buildd/shared';

export interface TaskRef {
  id: string;
  workspaceId: string;
  missionId: string | null;
}

/**
 * Broadcast a task status change on its workspace channel so dashboards and
 * runners see it without polling. Best-effort — never throws.
 */
export async function emitTaskUpdated(task: TaskRef & { status: string }): Promise<void> {
  try {
    await triggerEvent(channels.workspace(task.workspaceId), events.TASK_UPDATED, {
      task: { id: task.id, status: task.status, workspaceId: task.workspaceId, missionId: task.missionId },
    });
  } catch (err) {
    console.error(`[task-cancel] TASK_UPDATED push failed for ${task.id}:`, err);
  }
}

/**
 * After a cancelled task is written back to `pending` outside the task PATCH
 * (e.g. its GitHub issue was reopened): broadcast the change, wake it, and
 * reopen its mission if that mission had already completed — the same reopen
 * the PATCH route runs. The status write already made the wake durable (outbox
 * trigger); the wake labels it and kicks delivery. Lazily imports mission-loop
 * so callers that never reopen don't pull in its dependency graph. Never throws.
 */
export async function applyTaskReopenSideEffects(task: TaskRef, reason: string): Promise<void> {
  await emitTaskUpdated({ ...task, status: 'pending' });
  await wakeTask(task.id, 'task.requeued').catch((err) =>
    console.error(`[task-cancel] wake failed for reopened task ${task.id}:`, err),
  );
  if (!task.missionId) return;
  try {
    const [{ reopenCompletedMission }, { systemActor }] = await Promise.all([
      import('@/lib/mission-loop'),
      import('@/lib/mission-feed'),
    ]);
    await reopenCompletedMission(task.missionId, systemActor(reason));
  } catch (err) {
    console.error(`[task-cancel] mission reopen failed for task ${task.id}:`, err);
  }
}

/**
 * Everything that has to happen after a task row is written to `cancelled`,
 * whichever path wrote it (task PATCH, GitHub issue close, bulk cancel).
 * Call it only for rows that actually changed — it is not a status write.
 *
 *  1. Abort any running/waiting_input worker right away, rather than letting it
 *     keep spending tokens until its next sync poll notices.
 *  2. Release the task's own path_claims. The abort is best-effort delivery; a
 *     worker that is already dead never sends the terminal PATCH that would
 *     normally release them, and held claims deadlock overlapping siblings.
 *     Idempotent — a no-op when nothing is held.
 *  3. resolveCompletedTask — parent aggregation and the mission dormancy
 *     check. Cancelled tasks deliberately do not unblock or cascade dependents
 *     (see resolveCompletedTask).
 *  4. TASK_UPDATED on the workspace channel.
 *  5. The supersession reconciler's `cancelled` event: open retries of this
 *     task (CI/review/conflict attempts) go with it (`cancel_supersedes_retry`).
 *  6. Detach an interactive (claim_task) worker. The abort push in step 1
 *     reaches only runner-held sessions; a local one would otherwise keep its
 *     seat (lib/interactive-detach.ts).
 *  7. Settle a worker with no session to abort: a question park, a pause, a
 *     parked cloud run (lib/sessionless-worker-settle.ts). Nothing would ever
 *     report its end, so it stayed `waiting_input`, holding a slot and drawn
 *     as a live run with a question.
 *
 * Each step is independent and failures are logged, never thrown, so one broken
 * side effect cannot stop the others or fail the caller's already-committed write.
 */
export async function applyTaskCancelSideEffects(task: TaskRef): Promise<void> {
  const { id, workspaceId } = task;

  const abort = (async () => {
    const activeWorker = await db.query.workers.findFirst({
      where: sqlWhere(and(
        eq(workers.taskId, id),
        inArray(workers.status, ['running', 'waiting_input']),
      )),
      columns: { id: true },
    });
    if (activeWorker) {
      await triggerEvent(
        channels.worker(activeWorker.id),
        events.WORKER_COMMAND,
        { action: 'abort', reason: 'task_cancelled', timestamp: Date.now() },
      );
    }
  })();

  const results = await Promise.allSettled([
    abort,
    releaseAndNotify(id, 'abandoned'),
    resolveCompletedTask(id, workspaceId),
    emitTaskUpdated({ ...task, status: 'cancelled' }),
    import('@/lib/supersession').then(({ reconcileSubjectEvent }) =>
      reconcileSubjectEvent({ kind: 'cancelled', workspaceId, taskId: id, door: 'applyTaskCancelSideEffects' })),
    import('@/lib/interactive-detach').then(({ detachInteractiveWorkersOfEndedTasks }) =>
      detachInteractiveWorkersOfEndedTasks({ taskId: id, graceMs: 0 })),
    kernelAttemptEnded(id, workspaceId),
    settleSessionlessWorkersOfTask(id, 'task_cancelled'),
  ]);

  const labels = ['abort push', 'path-claim release', 'resolveCompletedTask', 'TASK_UPDATED', 'supersession', 'interactive detach', 'workflow AttemptEnded', 'sessionless settle'];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[task-cancel] ${labels[i]} failed for ${id}:`, r.reason);
    }
  });
}

/**
 * A cancelled attempt of a workflow-kernel delivery tells the kernel it ended
 * (docs/specs/workflow-state-kernel.md §18.1). The runner's terminal PATCH
 * reaches T4 only if the worker is alive to send it; a dead or detached one
 * never does, which would leave the ledger row `running` and the delivery
 * bound to it. A second report of the same end is a no-op in the ledger.
 */
async function kernelAttemptEnded(taskId: string, workspaceId: string): Promise<void> {
  const task = await db.query.tasks.findFirst({
    where: sqlWhere(eq(tasks.id, taskId)),
    columns: { id: true, deliveryId: true, deliveryRole: true, context: true },
  });
  if (!task?.deliveryId) return;
  const worker = await db.query.workers.findFirst({
    where: sqlWhere(eq(workers.taskId, taskId)),
    columns: { id: true, commitCount: true },
    orderBy: sqlOrderBy([desc(workers.createdAt)]),
  });
  // Through the client: the control plane applies it in own mode (AC-9).
  const { attemptEnded, systemPrincipal } = await import('@/lib/workflow/kernel-client');
  await attemptEnded({
    task: { id: task.id, workspaceId, deliveryId: task.deliveryId, deliveryRole: task.deliveryRole ?? null, context: task.context },
    workerId: worker?.id ?? `cancel:${taskId}`,
    status: 'lost',
    // 295486ba: a CI repair cancelled before anyone claimed it spends nothing.
    cancelled: true,
    localHeadSha: null,
    commitCount: worker?.commitCount ?? 0,
    source: 'cancel',
    // A person cancelling a review round is taking it over: the kernel
    // escalates (review_unavailable) instead of re-filing a reviewer at once.
    // Rounds the platform itself superseded are no longer current, so the
    // kernel treats this end as stale for them.
    ...(task.deliveryRole === 'review' ? { reviewFailure: 'human_takeover' as const } : {}),
  }, { principal: systemPrincipal('system:task_cancel') });
}

/**
 * Before a task row is deleted (DELETE /api/tasks/[id], bulk delete). The
 * delete sets `workers.task_id` to NULL and cascades the task's path claims
 * away, so nothing that keys on the task can reach its workers afterwards:
 *
 *  1. Settle the sessionless live workers (a question park above all): with no
 *     task left, nothing else would ever end them.
 *  2. Abort any live session still running it. The runner's terminal PATCH
 *     still lands, on a worker whose task is now NULL.
 *  3. Release the path claims with notification, so blocked siblings hear it
 *     (the cascade alone deletes the rows silently).
 *
 * The worker rows themselves are kept: they are the run's history.
 * Failures are logged, never thrown, like applyTaskCancelSideEffects.
 */
export async function applyTaskDeleteSideEffects(taskId: string): Promise<void> {
  const abort = async () => {
    const live = await db.query.workers.findMany({
      where: sqlWhere(and(eq(workers.taskId, taskId), inArray(workers.status, [...LIVE_WORKER_STATUSES]))),
      columns: { id: true },
    });
    await Promise.all(live.map(w => triggerEvent(
      channels.worker(w.id),
      events.WORKER_COMMAND,
      { action: 'abort', reason: 'task_cancelled', timestamp: Date.now() },
    )));
  };
  const results = await Promise.allSettled([
    settleSessionlessWorkersOfTask(taskId, 'task_deleted').then(abort),
    releaseAndNotify(taskId, 'abandoned'),
    // A dependent in another workspace stops waiting on a row that is about
    // to vanish (spec e28018c2 R-14).
    releaseCrossWorkspaceDependentsOf(taskId),
  ]);
  const labels = ['settle and abort', 'path-claim release', 'cross-workspace dependents'];
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[task-delete] ${labels[i]} failed for ${taskId}:`, r.reason);
  });
}

export const REQUEUED_WORKER_ERROR = 'Runner offline, requeued by owner';

/**
 * An owner puts a task back in the queue (`status: pending`) while it still has
 * live workers, typically because their runner went offline. Without this the
 * task read pending but its dead workers stayed `running`, so the task kept
 * showing as running and no runner claimed it until the stale-worker reap.
 *
 *  1. End every live worker (compare-and-swap out of the live set) as failed,
 *     `exitCause: reassigned` (infrastructure, not a chargeable attempt), with
 *     the reason recorded and any question closed.
 *  2. Push an abort to each, in case its runner is in fact still up.
 *  3. Release the task's path claims, which a dead worker never will.
 *
 * Returns the ids of the workers it ended. Notification failures are logged,
 * never thrown; the compare-and-swap write is the only step that can throw.
 */
export async function endLiveWorkersForRequeue(taskId: string): Promise<string[]> {
  const now = new Date();
  const ended = await db
    .update(workers)
    .set({
      status: 'failed',
      exitCause: 'reassigned',
      error: REQUEUED_WORKER_ERROR,
      waitingFor: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(and(eq(workers.taskId, taskId), inArray(workers.status, [...LIVE_WORKER_STATUSES])))
    .returning({ id: workers.id, taskId: workers.taskId, accountId: workers.accountId });
  if (ended.length === 0) return [];

  const results = await Promise.allSettled([
    ...ended.flatMap(w => [
      triggerEvent(channels.worker(w.id), events.WORKER_COMMAND, { action: 'abort', reason: 'task_requeued', timestamp: Date.now() }),
      triggerEvent(channels.worker(w.id), events.WORKER_FAILED, { workerId: w.id, taskId: w.taskId, status: 'failed', error: REQUEUED_WORKER_ERROR }),
    ]),
    releaseAndNotify(taskId, 'abandoned'),
  ]);
  results.forEach(r => {
    if (r.status === 'rejected') console.error(`[task-requeue] side effect failed for ${taskId}:`, r.reason);
  });
  return ended.map(w => w.id);
}
