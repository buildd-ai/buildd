import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { releaseAndNotify } from '@/lib/path-claim-release';
import { resolveCompletedTask } from '@/lib/task-dependencies';

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
 * (e.g. its GitHub issue was reopened): broadcast the change and reopen its
 * mission if that mission had already completed — the same reopen the PATCH
 * route runs. Lazily imports mission-loop so callers that never reopen don't
 * pull in its dependency graph. Never throws.
 */
export async function applyTaskReopenSideEffects(task: TaskRef, reason: string): Promise<void> {
  await emitTaskUpdated({ ...task, status: 'pending' });
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
 *
 * Each step is independent and failures are logged, never thrown, so one broken
 * side effect cannot stop the others or fail the caller's already-committed write.
 */
export async function applyTaskCancelSideEffects(task: TaskRef): Promise<void> {
  const { id, workspaceId } = task;

  const abort = (async () => {
    const activeWorker = await db.query.workers.findFirst({
      where: and(
        eq(workers.taskId, id),
        inArray(workers.status, ['running', 'waiting_input']),
      ),
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
  ]);

  const labels = ['abort push', 'path-claim release', 'resolveCompletedTask', 'TASK_UPDATED'];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[task-cancel] ${labels[i]} failed for ${id}:`, r.reason);
    }
  });
}
