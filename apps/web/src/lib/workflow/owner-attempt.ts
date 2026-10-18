/**
 * AC-1 slice 9 (docs/specs/workflow-kernel-library.md §9): the moves of a kernel delivery's owner
 * task that the attempt writers outside the worker PATCH make (the cleanup route, the claim route,
 * the recovery doors, the reaper). Each submits the kernel command where the kernel is hosted, then
 * projects the same move on the caller's own host under the same guard, so a control plane that is
 * down, refusing or too old still leaves the task where the kernel would have put it, and a late or
 * duplicate move after a re-claim moves nothing. None runs a kernel command on the web host in own
 * mode. A task that is no delivery's owner is the caller's to write.
 */
import {
  attemptEnded,
  attemptReopened,
  attemptRequeued,
  attemptWithdrawn,
  type KernelPrincipal,
} from './kernel-client';
import { projectOwnerEnd, projectReopen, projectRequeue, projectWithdraw, type AttemptTask } from './seam';
import { CLAIM_CLOCK_SKEW_MS, isAttemptRow, isAttemptRowSql, notOwnerTaskSql } from './task-projection';

/** The predicate a writer's own status write for a non-owner task carries (task-projection.ts). */
export { notOwnerTaskSql };
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

/** The owner task of a delivery, as the moves read it. */
export type OwnerTask = AttemptTask & { deliveryId: string };

/** Whether a task row is a delivery's owner, which the kernel moves (the routes' own rule). */
export const isOwnerTask = (t: { deliveryId?: string | null; deliveryRole?: string | null } | null | undefined): t is { deliveryId: string; deliveryRole: 'owner' } =>
  !!t?.deliveryId && t.deliveryRole === 'owner';

function logged(label: string, taskId: string, err: unknown): void {
  console.error(`[workflow] ${label} for task ${taskId} did not reach the kernel; projecting it here:`, err);
}

/** AttemptRequeued, then `projectRequeue`. Answers whether the task is back in the queue for this attempt. */
export async function requeueOwner(p: { task: OwnerTask; workerId: string; reason: string; source: string; principal: KernelPrincipal | null }): Promise<boolean> {
  try {
    const r = await attemptRequeued({ task: p.task, workerId: p.workerId, reason: p.reason, source: p.source }, { principal: p.principal });
    if (r.requeued) return true;
  } catch (err) {
    logged(`AttemptRequeued(${p.reason})`, p.task.id, err);
  }
  return projectRequeue({ deliveryId: p.task.deliveryId, taskId: p.task.id, workerId: p.workerId }).catch(() => false);
}

/** AttemptEnded, then `projectOwnerEnd`. Answers the status the task holds for this end, or null. */
export async function endOwner(p: {
  task: OwnerTask; workerId: string; status: 'completed' | 'failed' | 'lost';
  localHeadSha: string | null; commitCount: number; source: string; principal: KernelPrincipal | null;
}): Promise<'completed' | 'failed' | null> {
  try {
    await attemptEnded({ task: p.task, workerId: p.workerId, status: p.status, localHeadSha: p.localHeadSha, commitCount: p.commitCount, source: p.source }, { principal: p.principal });
  } catch (err) {
    logged(`AttemptEnded(${p.status})`, p.task.id, err);
  }
  return projectOwnerEnd({ deliveryId: p.task.deliveryId, taskId: p.task.id, workerId: p.workerId, status: p.status }).catch(() => null);
}

/** AttemptReopened, then `projectReopen`. Answers whether the task is open again as `to` says. */
export async function reopenOwner(p: {
  task: OwnerTask; workerId: string | null; endedAt: string | null; to: 'pending' | 'assigned';
  reason: string; source: string; principal: KernelPrincipal | null;
}): Promise<boolean> {
  const { task, workerId, endedAt, to } = p;
  try {
    const r = await attemptReopened({ task, workerId, endedAt, to, reason: p.reason, source: p.source }, { principal: p.principal });
    if (r.reopened) return true;
  } catch (err) {
    logged(`AttemptReopened(${p.reason})`, task.id, err);
  }
  return projectReopen({ deliveryId: task.deliveryId, taskId: task.id, workerId, endedAt, to }).catch(() => false);
}

/** AttemptWithdrawn, then `projectWithdraw`. Answers whether the task now has the outcome's status. */
export async function withdrawOwner(p: {
  task: OwnerTask; claim: { claimedBy: string; claimedAt: string } | null; outcome: 'requeued' | 'failed';
  reason: string; source: string; principal: KernelPrincipal | null;
}): Promise<boolean> {
  const { task, claim, outcome } = p;
  try {
    const r = await attemptWithdrawn({ task, claim, outcome, reason: p.reason, source: p.source }, { principal: p.principal });
    if (r.withdrawn) return true;
  } catch (err) {
    logged(`AttemptWithdrawn(${p.reason})`, task.id, err);
  }
  return projectWithdraw({ deliveryId: task.deliveryId, taskId: task.id, claim, outcome, reason: p.reason }).catch(() => false);
}

/** A worker's end as the reopen names it: its completed_at, ISO (the guard compares to the millisecond). */
export const endedAtOf = (completedAt: Date | string | null | undefined): string | null =>
  completedAt == null ? null : new Date(completedAt).toISOString();

/**
 * The owner task's latest attempt row (a placeholder no runner executed is never one): the worker a
 * reopen names. Null when the task never ran an attempt.
 */
export async function latestAttemptWorker(taskId: string): Promise<{ id: string; completedAt: Date | null; lastCommitSha: string | null; commitCount: number | null } | null> {
  const rows = await db.query.workers.findMany({
    where: sqlWhere(eq(workers.taskId, taskId)),
    columns: { id: true, runner: true, completedAt: true, lastCommitSha: true, commitCount: true },
    orderBy: sqlOrderBy([desc(workers.createdAt), desc(workers.id)]),
    limit: 20,
  });
  const w = rows.find((r) => isAttemptRow(r));
  return w ? { id: w.id, completedAt: w.completedAt ?? null, lastCommitSha: w.lastCommitSha ?? null, commitCount: w.commitCount ?? null } : null;
}

/**
 * The recovery doors' reopen of failed owner tasks (credential restored, GitHub access verified, an
 * incident's recovery): each failed owner among `taskIds` gets AttemptReopened(pending) naming its
 * latest attempt, so a reopen that lands after the task was claimed again moves nothing. Answers the
 * ids now back in the queue.
 */
export async function reopenFailedOwners(taskIds: string[], p: { reason: string; source: string }): Promise<string[]> {
  if (taskIds.length === 0) return [];
  const { systemPrincipal } = await import('./kernel-client');
  const owners = await db.query.tasks.findMany({
    where: sqlWhere(and(inArray(tasks.id, taskIds), eq(tasks.status, 'failed'), isNotNull(tasks.deliveryId), eq(tasks.deliveryRole, 'owner'))),
    columns: { id: true, workspaceId: true, deliveryId: true, deliveryRole: true, context: true },
  });
  const reopened: string[] = [];
  for (const o of owners) {
    const latest = await latestAttemptWorker(o.id);
    const ok = await reopenOwner({
      task: { ...o, deliveryId: o.deliveryId! }, workerId: latest?.id ?? null, endedAt: endedAtOf(latest?.completedAt),
      to: 'pending', reason: p.reason, source: p.source, principal: systemPrincipal(`system:${p.source}`),
    });
    if (ok) reopened.push(o.id);
  }
  return reopened;
}

/**
 * A delivery owner task as a sweep moves it: the attempt a move is for is its latest attempt row
 * when that row is the current claim's (made at or after `claimed_at`); with none, the claim itself
 * (claimed_by, and claimed_at as Postgres renders it). Null: the task is no delivery's owner.
 */
export async function ownerTaskAttemptOf(taskId: string): Promise<{
  task: OwnerTask; currentWorkerId: string | null; claim: { claimedBy: string; claimedAt: string } | null;
  /** What the current attempt's worker reported, for its end. */
  head?: { localHeadSha: string | null; commitCount: number };
} | null> {
  const r = (await db.execute(sql`SELECT tk.workspace_id, tk.delivery_id, tk.delivery_role, tk.context, tk.claimed_by, tk.claimed_at::text AS claim_stamp,
      cw.id AS current_worker, cw.last_commit_sha, cw.commit_count
    FROM tasks tk
    LEFT JOIN LATERAL (SELECT w.id, w.last_commit_sha, w.commit_count FROM workers w WHERE w.task_id = tk.id AND ${isAttemptRowSql('w')}
        AND (tk.claimed_at IS NULL OR w.created_at >= tk.claimed_at - make_interval(secs => ${CLAIM_CLOCK_SKEW_MS / 1000}::double precision))
        ORDER BY w.created_at DESC, w.id DESC LIMIT 1) cw ON true
    WHERE tk.id = ${taskId}::uuid`) as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0];
  if (!r || !isOwnerTask({ deliveryId: r.delivery_id as string | null, deliveryRole: r.delivery_role as string | null })) return null;
  return {
    task: { id: taskId, workspaceId: String(r.workspace_id), deliveryId: String(r.delivery_id), deliveryRole: 'owner', context: r.context },
    currentWorkerId: r.current_worker ? String(r.current_worker) : null,
    head: { localHeadSha: r.last_commit_sha ? String(r.last_commit_sha) : null, commitCount: Number(r.commit_count ?? 0) },
    claim: r.claimed_by && r.claim_stamp ? { claimedBy: String(r.claimed_by), claimedAt: String(r.claim_stamp) } : null,
  };
}
