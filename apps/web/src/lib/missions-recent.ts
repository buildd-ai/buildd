/**
 * The read behind GET /api/missions/recent (spec c7410e76 R-24): every open
 * mission of the given workspaces, plus those delivered recently
 * (`RECENTLY_DELIVERED_DAYS`, the one definition: spec 3ef37387 R-24).
 *
 * "Delivered" is the latest transition into completed, not
 * `missions.completedAt` alone. The automated completion re-stamps that column
 * each time, but an explicit status PATCH stamps it only on a mission's first
 * completion (the follow-up metric keys off it), so a mission completed,
 * reopened and completed again that way would still carry its first date.
 * A PATCH into completed writes a feed note tagged with `MISSION_COMPLETED_MARKER`
 * (a `collapse_key` post_note cannot write), so the later of the stamp and the
 * newest such note is the current completion. Automated completion keeps the
 * earlier stamp when no task finished since the reopen (completeMissionSql). A reopened mission is open again and lists as open; a completed
 * mission with neither (finished before the stamp existed) is not listed.
 *
 * The delivered read is one grouped pass: the given workspaces' completed
 * missions, left-joined to their completion notes inside the window. The note
 * match (a LIKE on the body) runs once per note row of those missions, never
 * per mission in a correlated subquery, and never over another tenant's notes.
 */
import { db } from '@buildd/core/db';
import { missionNotes, missions } from '@buildd/core/db/schema';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { missionStatusNoteIntoPattern, MISSION_COMPLETED_MARKER, MISSION_STATUS_CHANGE_TITLES } from '@/lib/mission-status-note';
import { RECENTLY_DELIVERED_DAYS, type RecentMission } from '@buildd/shared';

export const RECENT_DAYS = RECENTLY_DELIVERED_DAYS;
/** Bound recent deliveries only; open missions must never be truncated. */
const MAX_DELIVERED_MISSIONS = 300;
const OPEN_STATUSES = ['active', 'paused', 'budget_exhausted'] as const;

/**
 * A note that records a completion: the server's own marker (a PATCH by a person or MCP
 * caller; post_note cannot write it), or a system-authored status note (older rows, which
 * predate the marker). A bare author type is not trusted for anyone else's note.
 */
export function completionNoteSql() {
  const [title1, title2] = MISSION_STATUS_CHANGE_TITLES;
  return sql`(${missionNotes.type} = 'update' and (${missionNotes.collapseKey} = ${MISSION_COMPLETED_MARKER}
    or (${missionNotes.authorType} = 'system'
      and ${missionNotes.title} in (${title1}, ${title2})
      and ${missionNotes.body} like ${missionStatusNoteIntoPattern('completed')})))`;
}

/** When the mission last became completed, over the joined notes: the later of its stamp and its newest completion note. */
export const deliveredAtSql = sql<string | Date | null>`greatest(${missions.completedAt}, max(${missionNotes.createdAt}))`;

const LISTED = { id: missions.id, title: missions.title, workspaceId: missions.workspaceId, status: missions.status, isHeld: missions.isHeld, executor: missions.executor };

/** Completed missions of these workspaces delivered since `since`, newest activity first. */
export function deliveredMissionsQuery(workspaceIds: string[], since: Date) {
  return db
    .select({ ...LISTED, deliveredAt: deliveredAtSql })
    .from(missions)
    .leftJoin(missionNotes, and(
      eq(missionNotes.missionId, missions.id),
      gte(missionNotes.createdAt, since),
      completionNoteSql(),
    ))
    .where(and(inArray(missions.workspaceId, workspaceIds), eq(missions.status, 'completed')))
    .groupBy(missions.id)
    .having(gte(deliveredAtSql, since))
    .orderBy(desc(missions.updatedAt))
    .limit(MAX_DELIVERED_MISSIONS);
}

/** The listed missions, open first, newest activity first within each set; `completedAt` is the delivered time, set only on a completed one. */
export async function loadRecentMissions(workspaceIds: string[], now = Date.now()): Promise<Array<Omit<RecentMission, 'stage'>>> {
  if (workspaceIds.length === 0) return [];
  const since = new Date(now - RECENT_DAYS * 86_400_000);
  const [open, delivered] = await Promise.all([
    db.query.missions.findMany({
      columns: { id: true, title: true, workspaceId: true, status: true, isHeld: true, executor: true },
      where: sqlWhere(and(inArray(missions.workspaceId, workspaceIds), inArray(missions.status, [...OPEN_STATUSES]))),
      orderBy: sqlOrderBy([desc(missions.updatedAt)]),
    }),
    deliveredMissionsQuery(workspaceIds, since),
  ]);
  return [
    ...open.map(r => ({ ...r, deliveredAt: null as string | Date | null })),
    ...delivered,
  ].map(r => ({
    id: r.id,
    title: r.title,
    workspaceId: r.workspaceId as string,
    status: r.status,
    isHeld: !!r.isHeld,
    executor: r.executor,
    completedAt: r.status === 'completed' && r.deliveredAt ? new Date(r.deliveredAt).toISOString() : null,
  }));
}
