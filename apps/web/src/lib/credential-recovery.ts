/**
 * Auto-requeue tasks that failed due to an auth-class error, once the team's
 * backend credential is (re)stored healthy.
 *
 * Motivation: when a Claude/Codex credential is revoked or expires, every worker
 * that claims a task 401s and the task lands in `failed`. Fixing the credential
 * used to leave those tasks stranded — a manual re-run slog, and their dependents
 * stayed gated. This turns credential recovery into self-healing: storing a fresh
 * credential requeues the infra casualties.
 *
 * Safety:
 *   - Only `failed` tasks (terminal; no active worker) are touched.
 *   - Only tasks whose latest worker error classifies as an auth error
 *     (`classifyAuthErrorSeverity !== 'none'`) — genuine failures are left alone.
 *   - Bounded by a recency window and a hard count cap to avoid requeue storms.
 *   - Requeued tasks go back to `pending`; the claim dependency gate still applies,
 *     so gated dependents are not claimed prematurely.
 */
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { classifyAuthErrorSeverity } from '@buildd/core/auth-error-classifier';

/** How far back a failed task can be to still count as a recoverable casualty. */
export const RECOVERY_WINDOW_HOURS = 24;
/** Hard cap on tasks requeued per recovery, so a bad state can't fan out unboundedly. */
export const MAX_REQUEUE = 100;

export interface RequeueResult {
  requeued: string[];
  /** Failed auth-casualties found but skipped because the cap was hit. */
  skippedOverCap: number;
}

/**
 * Requeue a team's recent auth-failed tasks after a healthy credential is stored.
 * Returns the requeued task ids. Never throws into the caller's happy path — the
 * caller should treat this as best-effort (wrap in try/catch or `.catch`).
 */
export async function requeueAuthFailedTasks(teamId: string): Promise<RequeueResult> {
  // Failed tasks in this team's workspaces within the recovery window, with the
  // error of each of their workers. A task has multiple workers across retries;
  // we judge it by its most recent worker's error below.
  const rows = await db
    .select({
      taskId: tasks.id,
      taskUpdatedAt: tasks.updatedAt,
      workerError: workers.error,
      workerCreatedAt: workers.createdAt,
    })
    .from(tasks)
    .innerJoin(workspaces, eq(tasks.workspaceId, workspaces.id))
    .leftJoin(workers, eq(workers.taskId, tasks.id))
    .where(and(
      eq(workspaces.teamId, teamId),
      eq(tasks.status, 'failed'),
      gt(tasks.updatedAt, sql`NOW() - MAKE_INTERVAL(hours => ${RECOVERY_WINDOW_HOURS})`),
    ));

  // Group by task; keep the latest worker's error (max createdAt).
  const latestByTask = new Map<string, { error: string | null; at: number }>();
  for (const r of rows) {
    const at = r.workerCreatedAt ? new Date(r.workerCreatedAt).getTime() : 0;
    const cur = latestByTask.get(r.taskId);
    if (!cur || at >= cur.at) latestByTask.set(r.taskId, { error: r.workerError, at });
  }

  // Keep only tasks whose latest worker died with an auth-class error.
  const candidates = [...latestByTask.entries()]
    .filter(([, v]) => v.error != null && classifyAuthErrorSeverity(v.error) !== 'none')
    .map(([taskId]) => taskId);

  if (candidates.length === 0) return { requeued: [], skippedOverCap: 0 };

  const toRequeue = candidates.slice(0, MAX_REQUEUE);
  const skippedOverCap = candidates.length - toRequeue.length;

  // Flip failed → pending so the runner re-claims. Guard on status='failed' so a
  // task that changed state between the read and the write is not clobbered.
  await db
    .update(tasks)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(and(inArray(tasks.id, toRequeue), eq(tasks.status, 'failed')));

  if (toRequeue.length > 0) {
    console.log(
      `[credential-recovery] Requeued ${toRequeue.length} auth-failed task(s) for team ${teamId}` +
      (skippedOverCap > 0 ? ` (${skippedOverCap} more over the ${MAX_REQUEUE} cap left failed)` : ''),
    );
  }

  return { requeued: toRequeue, skippedOverCap };
}
