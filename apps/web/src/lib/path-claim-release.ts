/**
 * Path-claim release helper — app-layer wrapper that combines DB release
 * with agent delivery and Pusher fan-out.
 *
 * Called from every terminal signal that should release held locks:
 *   - PATCH /api/workers/[id] on terminal status
 *   - GitHub webhook on PR merged / PR closed
 *   - stale-workers reaper on orphaned worker cleanup
 */

import { releaseClaims } from '@buildd/core/path-claim';
import { buildWorkerMessage, enqueueWorkerMessage } from '@buildd/core/worker-messages';
import { triggerEvent, channels } from '@/lib/pusher';

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
export async function releaseAndNotify(taskId: string): Promise<void> {
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
    for (const [waitingTaskId, paths] of pathsByWaiter) {
      try {
        await enqueueWorkerMessage(
          waitingTaskId,
          buildWorkerMessage({
            type: 'path_released',
            fromTaskId: taskId,
            toTaskId: waitingTaskId,
            body: { paths, releasedAt },
          }),
        );
      } catch (err) {
        // One undeliverable waiter must not strand the others.
        console.error(`[path-claim] path_released enqueue failed for task ${waitingTaskId}:`, err);
      }
    }

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
