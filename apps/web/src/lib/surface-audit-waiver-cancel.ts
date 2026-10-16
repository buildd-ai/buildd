/**
 * A recorded visual-review waiver retires the mission's queued audit.
 *
 * Without this, the waived mission kept a pending `[surface audit]` task that
 * nothing would ever claim usefully, so the page said "Nothing is waiting"
 * beside "1 task still queued" (spec 8e137fdb I-3, AC-2). Only a pending,
 * unclaimed audit with no live worker is cancelled; one an agent has started
 * is left to finish. The cancellation carries the waiver as its reason, in the
 * same `context.cancellation` shape every other cancel records.
 */
import { and, eq, isNull, like, sql, type SQL } from 'drizzle-orm';
import { tasks, workers } from '@buildd/core/db/schema';
import { SURFACE_AUDIT_TITLE_PREFIX } from '@buildd/core/surface-audit';
import { LIVE_WORKER_STATUSES } from '@buildd/shared';
import type { TaskCancellation } from './task-cancellation';

/** The audit rows a waiver may cancel. Exported so the predicate is testable as SQL. */
export function waivableAuditWhere(missionId: string): SQL {
  return and(
    eq(tasks.missionId, missionId),
    eq(tasks.status, 'pending'),
    isNull(tasks.claimedBy),
    like(tasks.title, `${SURFACE_AUDIT_TITLE_PREFIX}%`),
    // Built as SQL, not a db subquery, so the predicate renders without a connection.
    sql`not exists (select 1 from ${workers} where ${workers.taskId} = ${tasks.id} and ${workers.status} in (${sql.join(LIVE_WORKER_STATUSES.map(s => sql`${s}`), sql`, `)}))`,
  )!;
}

export function waiverCancellation(reason: string, actor: string, now = new Date()): TaskCancellation {
  return { reason: `Visual review waived: ${reason}`.slice(0, 500), actor, at: now.toISOString() };
}

/** Cancel the waived mission's queued audit(s); returns the ids cancelled. Never throws past the caller's waiver. */
export async function cancelWaivedSurfaceAudits(missionId: string, reason: string, actor: string): Promise<string[]> {
  const { db } = await import('@buildd/core/db');
  const cancellation = waiverCancellation(reason, actor);
  const rows = await db
    .update(tasks)
    .set({
      status: 'cancelled',
      context: sql`coalesce(${tasks.context}, '{}'::jsonb) || jsonb_build_object('cancellation', ${JSON.stringify(cancellation)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(waivableAuditWhere(missionId))
    .returning({ id: tasks.id, workspaceId: tasks.workspaceId, missionId: tasks.missionId });
  if (rows.length > 0) {
    const { emitTaskUpdated } = await import('./task-cancel');
    await announceCancelledAudits(rows, emitTaskUpdated);
  }
  return rows.map(r => r.id);
}

type CancelledAudit = { id: string; workspaceId: string; missionId: string | null };

/** Tell open dashboards each audit is cancelled, the same TASK_UPDATED every cancel sends. Best-effort. */
export async function announceCancelledAudits(
  rows: readonly CancelledAudit[],
  emit: (task: CancelledAudit & { status: string }) => Promise<void>,
): Promise<void> {
  for (const r of rows) {
    try {
      await emit({ ...r, status: 'cancelled' });
    } catch (err) {
      console.error(`[surface-audit-waiver] TASK_UPDATED push failed for ${r.id}:`, err);
    }
  }
}
