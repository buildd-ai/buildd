/**
 * A mission's `[surface audit]` waits on the mission's builder work, and the
 * mission is whatever its tasks are NOW. The audit's `dependsOn` is extended as
 * builder tasks are filed, so it is a record of membership at filing time; a
 * task unlinked (or moved) later must stop holding the audit.
 *
 * Three readers keep the stored list and the gate in step with membership:
 *  - `detachTaskFromMissionSurfaceAudits`: the unlink itself
 *    (PATCH /api/tasks/[id], which manage_missions unlink_task calls, emits
 *    `task.left_mission`; lib/surface-audit-subscribers.ts) drops the edge
 *    from the old mission's open audits;
 *  - `ensureMissionSurfaceAudit` rewrites the list to current members whenever
 *    it extends it (`missionMemberIds`);
 *  - the claim gate (`dependenciesSatisfied` in workers/claim/deps-gate.ts)
 *    ignores an audit's dependency that is not in the audit's mission, so an
 *    edge left by an unlink that predates this, or by any other path, never
 *    blocks it.
 */
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { SURFACE_AUDIT_TITLE_PREFIX } from '@buildd/core/surface-audit';
import { DEP_SATISFYING_STATUSES } from '@/lib/dep-gate-contract';
import { wakeTask } from '@/lib/dispatch-authority';

/**
 * Drop `taskId` from the dependsOn of every not-yet-started surface audit in
 * `missionId`. One atomic UPDATE; returns the audits it changed. An audit that
 * already started is left alone (its dependencies no longer gate anything).
 */
export async function detachTaskFromMissionSurfaceAudits(missionId: string, taskId: string): Promise<string[]> {
  const rows = await db.update(tasks)
    .set({
      dependsOn: sql`COALESCE(${tasks.dependsOn}, '[]'::jsonb) - ${taskId}::text`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(tasks.missionId, missionId),
      like(tasks.title, `${SURFACE_AUDIT_TITLE_PREFIX}%`),
      eq(tasks.status, 'pending'),
      sql`${tasks.dependsOn} @> jsonb_build_array(${taskId}::text)`,
    ))
    .returning({ id: tasks.id });
  return rows.map(r => r.id);
}

/** The subset of `ids` that are tasks of `missionId` right now, in input order. */
export async function missionMemberIds(missionId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db.query.tasks.findMany({
    where: and(eq(tasks.missionId, missionId), inArray(tasks.id, [...ids])),
    columns: { id: true },
  });
  const members = new Set(rows.map(r => r.id));
  return ids.filter(id => members.has(id));
}

/**
 * `task.left_mission`: drop the edge, then wake an audit the departed task
 * was the last thing holding. Only member dependencies count, and only their
 * status is read here; the claim gate re-checks the rest (open PRs).
 */
export async function onTaskLeftMission(missionId: string, taskId: string): Promise<string[]> {
  const auditIds = await detachTaskFromMissionSurfaceAudits(missionId, taskId);
  const woken: string[] = [];
  for (const auditId of auditIds) {
    const audit = await db.query.tasks.findFirst({ where: eq(tasks.id, auditId), columns: { id: true, dependsOn: true } });
    const deps = Array.isArray(audit?.dependsOn) ? (audit!.dependsOn as string[]) : [];
    const rows = deps.length > 0
      ? await db.query.tasks.findMany({
          where: and(eq(tasks.missionId, missionId), inArray(tasks.id, deps)),
          columns: { id: true, status: true },
        })
      : [];
    if (rows.every(r => (DEP_SATISFYING_STATUSES as readonly string[]).includes(r.status))) {
      await wakeTask(auditId, 'dependency.satisfied');
      woken.push(auditId);
    }
  }
  return woken;
}
