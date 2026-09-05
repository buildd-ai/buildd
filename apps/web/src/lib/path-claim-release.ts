/**
 * Path-claim release helper — app-layer wrapper that combines DB release
 * with agent delivery and Pusher fan-out.
 *
 * Called from every terminal signal that should release held locks:
 *   - PATCH /api/workers/[id] on terminal status
 *   - GitHub webhook on PR merged / PR closed
 *   - stale-workers reaper on orphaned worker cleanup
 */

import { releaseClaims, rearmWaiter } from '@buildd/core/path-claim';
import { buildWorkerMessage, enqueueWorkerMessage } from '@buildd/core/worker-messages';
import { triggerEvent, channels } from '@/lib/pusher';

/**
 * Why the locks dropped — decides what the waiting agent should do next.
 *
 * `merged`        the holder's PR is in the base branch: rebase.
 * `pending_merge` the holder finished, PR still open: locks free, base unchanged.
 * `abandoned`     failed, closed unmerged, or reaped: nothing landed.
 *
 * Required rather than defaulted: there are three call sites and each one knows
 * the answer, while a default would quietly re-introduce "merged" as a lie.
 */
export type PathReleaseReason = 'merged' | 'pending_merge' | 'abandoned';

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
    if (!result) return; // no active claims — nothing to do

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
    // Parallel, and each failure re-arms its own waiter: `releaseClaims` has
    // already stamped notifiedAt, so without the re-arm a failed enqueue is a
    // permanently silent waiter (no retry, no starvation warning either).
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
      },
    );
  } catch (err) {
    console.error(`[path-claim] releaseAndNotify failed for task ${taskId}:`, err);
  }
}
