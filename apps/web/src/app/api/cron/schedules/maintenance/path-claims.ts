import { findStaleClaimHolderTaskIds } from '@buildd/core/path-claim';
import { releaseAndNotify, resolveReleaseReasonForTask } from '@/lib/path-claim-release';

/**
 * Reaper for `path_claims` rows that a terminal-transition write should have
 * released and didn't — a task that is completed/failed/cancelled, or whose
 * every worker is terminal, but still holds an active claim.
 *
 * This is the backstop of last resort: `releaseAndNotify` is idempotent, so
 * calling it again here for a row that WAS already released is a no-op, and
 * calling it for a row a bug left behind is what finally clears it and wakes
 * anything waiting on it. `findStaleClaimHolderTaskIds` (packages/core) is the
 * same detection the claim route's layer-2 backstop already applies at read
 * time — this just also fixes the underlying rows instead of only hiding them
 * from one query.
 *
 * Runs every tick of the `schedules` cron (~1 min) — cheap: a workspace with
 * no leaked claims does two empty-set queries and returns 0.
 */
export async function sweepAbandonedPathClaims(): Promise<number> {
  let released = 0;
  try {
    const staleTaskIds = await findStaleClaimHolderTaskIds();
    for (const taskId of staleTaskIds) {
      try {
        const reason = await resolveReleaseReasonForTask(taskId);
        await releaseAndNotify(taskId, reason);
        released++;
      } catch (err) {
        console.error(`[path-claims-sweep] failed to release claims for task ${taskId}:`, err);
      }
    }
  } catch (err) {
    console.warn('[path-claims-sweep] sweep failed:', err instanceof Error ? err.message : err);
  }
  return released;
}
