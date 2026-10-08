import { db } from '@buildd/core/db';
import { missions, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { eq, and, inArray, or, sql, type SQL } from 'drizzle-orm';
import { CAP_EXEMPT_KEY, bypassFlagCondition } from '@/lib/bypass-flags';

export const DEFAULT_MAX_CONCURRENT_TASKS = 3;

/**
 * A worker holds a workspace seat only while its task is open. A row can
 * outlive its task (a local claim_task session whose PR the merge webhook
 * completed stays `running`, and no reaper touches interactive workers); counted,
 * those phantom seats fill the cap and the claim query silently drops every
 * woken task in the workspace. Literal, not a bound param, so the claim WHERE
 * and the explicit-claim probe render the same text.
 */
const TASK_STILL_OPEN = sql.raw(`NOT IN ('completed', 'failed', 'cancelled')`);

/**
 * The claim query's workspace-cap predicate: TRUE when the task may be claimed.
 *
 * Counts live workers on the workspace's OTHER open tasks against
 * GREATEST(workspace cap, mission cap); repo-less workspaces are never capped;
 * context.capExempt (the operator override written by /start) passes.
 */
export function workspaceCapGate(): SQL {
  return or(
    bypassFlagCondition(tasks.context, CAP_EXEMPT_KEY),
    sql`(
      SELECT COUNT(*) FROM ${workers} w2
      JOIN ${tasks} t3 ON t3.id = w2.task_id
      WHERE t3.workspace_id = ${tasks.workspaceId}
      AND w2.status IN ('running', 'starting', 'idle')
      AND t3.id != ${tasks.id}
      AND t3.status ${TASK_STILL_OPEN}
      AND EXISTS (
        SELECT 1 FROM ${workspaces} ws
        WHERE ws.id = t3.workspace_id
        AND ws.repo IS NOT NULL
      )
    ) < GREATEST(
      (SELECT COALESCE(ws2.max_concurrent_tasks, 3) FROM ${workspaces} ws2
       WHERE ws2.id = ${tasks.workspaceId}),
      COALESCE(
        (SELECT m.max_concurrent_tasks FROM ${missions} m WHERE m.id = ${tasks.missionId}),
        0
      )
    )`,
  )!;
}

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
      sql`EXISTS (SELECT 1 FROM ${tasks} t_open WHERE t_open.id = ${workers.taskId} AND t_open.status ${TASK_STILL_OPEN})`,
    ),
    columns: { id: true },
  });
  const active = activeWorkers.length;
  return active >= cap ? { active, cap } : null;
}
