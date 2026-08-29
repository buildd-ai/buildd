import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';

export const DEFAULT_MAX_CONCURRENT_TASKS = 3;

/**
 * Check whether the workspace is at its per-repo concurrency cap.
 *
 * Only applies to repo-backed workspaces; repo-less ones are never capped.
 * Returns { active, cap } when the cap is reached, null when the task can proceed.
 *
 * The effective cap is GREATEST(workspaceCap, missionCap) — a mission may raise
 * its workspace's default cap to allow more parallel tasks. This matches the
 * same logic used by the claim route's per-task workspace_cap deferral.
 *
 * Used by both /api/tasks/[id]/start (pre-broadcast check) and by the claim
 * route for explicit single-task claims. This is the single canonical per-task
 * implementation.
 */
export async function checkWorkspaceCap(
  workspaceId: string,
  workspaceMaxConcurrentTasks: number | null,
  missionMaxConcurrentTasks?: number | null,
): Promise<{ active: number; cap: number } | null> {
  const workspaceCap = workspaceMaxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
  const missionCap = missionMaxConcurrentTasks ?? 0;
  const cap = Math.max(workspaceCap, missionCap);

  const activeWorkers = await db.query.workers.findMany({
    where: and(
      eq(workers.workspaceId, workspaceId),
      inArray(workers.status, ['running', 'starting', 'idle']),
    ),
    columns: { id: true },
  });
  const active = activeWorkers.length;
  return active >= cap ? { active, cap } : null;
}
