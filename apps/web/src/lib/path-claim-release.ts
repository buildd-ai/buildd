/**
 * Path-claim release helper — app-layer wrapper that combines DB release
 * with agent delivery and Pusher fan-out.
 *
 * Called from every terminal signal that should release held locks:
 *   - PATCH /api/workers/[id] on terminal status
 *   - GitHub webhook on PR merged / PR closed
 *   - stale-workers reaper on orphaned worker cleanup
 *   - direct task cancellation (PATCH /api/tasks/[id])
 *   - reviewer supersession on PR merge, human review interrupt, task
 *     reassignment, and the answered-question continuation path
 *   - the path-claims maintenance sweep, for whatever the above missed
 *
 * Selective narrowing (lib/path-claim-check.ts `narrowPathClaim`) reuses the
 * delivery half, `deliverPathReleased`, for just the waiters it freed.
 */

import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { releaseClaims, rearmWaiter, type ReleaseResult } from '@buildd/core/path-claim';
import { buildWorkerMessage, enqueueWorkerMessage } from '@buildd/core/worker-messages';
import { triggerEvent, channels } from '@/lib/pusher';

/**
 * Why the locks dropped — decides what the waiting agent should do next.
 *
 * `merged`        the holder's PR is in the base branch: rebase.
 * `pending_merge` the holder finished, PR still open: locks free, base unchanged.
 * `abandoned`     failed, closed unmerged, or reaped: nothing landed.
 * `narrowed`      the holder is still working but gave these paths back
 *                 without landing anything on them: base unchanged.
 *
 * Required rather than defaulted: every call site knows the answer, while a
 * default would quietly re-introduce "merged" as a lie.
 */
export type PathReleaseReason = 'merged' | 'pending_merge' | 'abandoned' | 'narrowed';

/**
 * Release all active path_claims for a task, deliver a `path_released` message
 * to every waiting task, then fan out a `path_claim_released` Pusher event on
 * the workspace channel.
 *
 * The message is the delivery that actually reaches an agent: the runner
 * subscribes to `worker-<id>` channels only, so a workspace-channel event has
 * no agent-side consumer. The event is kept for dashboard clients.
 *
 * Idempotent — safe to call even if the task has no active claims.
 * Fire-and-forget safe: all errors are caught and logged.
 */
export async function releaseAndNotify(taskId: string, reason: PathReleaseReason): Promise<void> {
  try {
    const result = await releaseClaims(taskId);
    if (!result) return; // nothing released and nobody waiting
    await deliverPathReleased(taskId, result, reason);
  } catch (err) {
    console.error(`[path-claim] releaseAndNotify failed for task ${taskId}:`, err);
  }
}

/**
 * Deliver `path_released` to each waiter in `result` (already stamped
 * notified by the core release/narrow statement), re-arming any waiter whose
 * delivery fails, then fan out `path_claim_released` for dashboards.
 *
 * Only the waiters in `result` are messaged — for a narrowing that is exactly
 * the ones blocked on a released path, not every waiter on the task.
 * Never throws.
 */
export async function deliverPathReleased(
  taskId: string,
  result: ReleaseResult,
  reason: PathReleaseReason,
): Promise<void> {
  try {
    const { workspaceId, releasedPaths, notifiedWaiters } = result;
    if (notifiedWaiters.length === 0) return;

    // One message per waiting task, carrying every path that freed for it.
    // `waiters` is absent only if a caller passes an older result shape; the
    // released paths are the correct fallback (they are what was freed).
    const pathsByWaiter = new Map<string, string[]>();
    if (Array.isArray(result.waiters) && result.waiters.length > 0) {
      for (const { waitingTaskId, blockedPath } of result.waiters) {
        const paths = pathsByWaiter.get(waitingTaskId) ?? [];
        if (!paths.includes(blockedPath)) paths.push(blockedPath);
        pathsByWaiter.set(waitingTaskId, paths);
      }
    } else {
      for (const waitingTaskId of new Set(notifiedWaiters)) {
        pathsByWaiter.set(waitingTaskId, releasedPaths);
      }
    }

    const releasedAt = new Date().toISOString();
    // Parallel, and each failure re-arms its own waiter: the core statement has
    // already stamped notifiedAt, so without the re-arm a failed enqueue is a
    // permanently silent waiter. The next release event for this task (a
    // repeated terminal signal, or the maintenance sweep) wakes it again.
    await Promise.all([...pathsByWaiter].map(async ([waitingTaskId, paths]) => {
      try {
        const delivered = await enqueueWorkerMessage(
          waitingTaskId,
          buildWorkerMessage({
            type: 'path_released',
            fromTaskId: taskId,
            toTaskId: waitingTaskId,
            body: { paths, releasedAt, reason },
          }),
        );
        // false = the waiting task row is gone; nothing to re-arm for.
        if (!delivered) return;
      } catch (err) {
        console.error(`[path-claim] path_released enqueue failed for task ${waitingTaskId}:`, err);
        await rearmWaiter(taskId, waitingTaskId).catch(rearmErr =>
          console.error(`[path-claim] rearmWaiter failed for task ${waitingTaskId}:`, rearmErr),
        );
      }
    }));

    await triggerEvent(
      channels.workspace(workspaceId),
      'path_claim_released',
      {
        taskId,
        paths: releasedPaths,
        waitingTaskIds: notifiedWaiters,
        reason,
      },
    );
  } catch (err) {
    console.error(`[path-claim] path_released delivery failed for task ${taskId}:`, err);
  }
}

/**
 * Work out which `PathReleaseReason` applies to a task whose own terminal
 * write didn't already know the answer (the maintenance sweep, mainly — it
 * finds a stale claim after the fact and has no request context to read).
 *
 * Mirrors the PATCH /api/workers/[id] logic: a merged PR always means
 * `merged`; a completed task with a still-open PR means `pending_merge`
 * (the work landed, just not into the base branch yet); everything else is
 * `abandoned`.
 */
export async function resolveReleaseReasonForTask(taskId: string): Promise<PathReleaseReason> {
  const taskWorkers = await db.query.workers.findMany({
    where: eq(workers.taskId, taskId),
    columns: { mergedAt: true, prLifecycleStatus: true, prNumber: true },
  });
  const merged = taskWorkers.some(w => w.mergedAt || w.prLifecycleStatus === 'merged');
  if (merged) return 'merged';

  const hasOpenPr = taskWorkers.some(w => w.prNumber);
  if (hasOpenPr) {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { status: true },
    });
    if (task?.status === 'completed') return 'pending_merge';
  }

  return 'abandoned';
}
