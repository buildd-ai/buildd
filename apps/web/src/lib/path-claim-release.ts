/**
 * Path-claim release helper — app-layer wrapper that combines DB release
 * with Pusher fan-out.
 *
 * Called from every terminal signal that should release held locks:
 *   - PATCH /api/workers/[id] on terminal status
 *   - GitHub webhook on PR merged / PR closed
 *   - stale-workers reaper on orphaned worker cleanup
 */

import { releaseClaims } from '@buildd/core/path-claim';
import { triggerEvent, channels } from '@/lib/pusher';

/**
 * Release all active path_claims for a task, then fan out a
 * `path_claim_released` Pusher event to the workspace channel so live
 * workers that are waiting can retry their check_path_claim call.
 *
 * Idempotent — safe to call even if the task has no active claims.
 * Fire-and-forget safe: all errors are caught and logged.
 */
export async function releaseAndNotify(taskId: string): Promise<void> {
  try {
    const result = await releaseClaims(taskId);
    if (!result) return; // no active claims — nothing to do

    const { workspaceId, releasedPaths, notifiedWaiters } = result;

    if (notifiedWaiters.length > 0) {
      await triggerEvent(
        channels.workspace(workspaceId),
        'path_claim_released',
        {
          taskId,
          paths: releasedPaths,
          waitingTaskIds: notifiedWaiters,
        },
      );
    }
  } catch (err) {
    console.error(`[path-claim] releaseAndNotify failed for task ${taskId}:`, err);
  }
}
