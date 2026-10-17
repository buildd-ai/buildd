/**
 * The read behind GET /api/missions/recent (spec c7410e76 R-24): every open
 * mission of the given workspaces, plus those delivered in the last 7 days.
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
 */
import { db } from '@buildd/core/db';
import { missionNotes, missions } from '@buildd/core/db/schema';
import { sqlExtras, sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { missionStatusNoteIntoPattern, MISSION_COMPLETED_MARKER, MISSION_STATUS_CHANGE_TITLES } from '@/lib/mission-status-note';
import type { RecentMission } from '@buildd/shared';

export const RECENT_DAYS = 7;
/** Bound recent deliveries only; open missions must never be truncated. */
const MAX_DELIVERED_MISSIONS = 300;
/** Safety cap on open missions; exceeded with a warning log. */
const MAX_OPEN_MISSIONS = 1000;
const OPEN_STATUSES = ['active', 'paused', 'budget_exhausted'] as const;

/**
 * A note that records a completion: the server's own marker (a PATCH by a person or MCP
 * caller; post_note cannot write it), or a system-authored status note (older rows, which
 * predate the marker). A bare author type is not trusted for anyone else's note.
 */
function completionNote(title1: string, title2: string) {
  return sql`(${missionNotes.collapseKey} = ${MISSION_COMPLETED_MARKER}
    or (${missionNotes.authorType} = 'system'
      and ${missionNotes.title} in (${title1}, ${title2})
      and ${missionNotes.body} like ${missionStatusNoteIntoPattern('completed')}))`;
}

/** When the mission last became completed: the later of its stamp and its newest "→ completed" status note. */
export function deliveredAtSqlFor(since: Date) {
  const [title1, title2] = MISSION_STATUS_CHANGE_TITLES;
  return sql<string | Date | null>`greatest(${missions.completedAt}, (
  select max(${missionNotes.createdAt}) from ${missionNotes}
  where ${missionNotes.missionId} = ${missions.id}
    and ${missionNotes.createdAt} >= ${since}
    and ${missionNotes.type} = 'update'
    and ${completionNote(title1, title2)}
))`;
}

export const deliveredAtSql = sql<string | Date | null>`greatest(${missions.completedAt}, (
  select max(${missionNotes.createdAt}) from ${missionNotes}
  where ${missionNotes.missionId} = ${missions.id}
    and ${missionNotes.type} = 'update'
    and ${completionNote(MISSION_STATUS_CHANGE_TITLES[0], MISSION_STATUS_CHANGE_TITLES[1])}
))`;


/** The listed missions, open first, newest activity first within each set; `completedAt` is the delivered time, set only on a completed one. */
export async function loadRecentMissions(workspaceIds: string[], now = Date.now()): Promise<Array<Omit<RecentMission, 'stage'>>> {
  if (workspaceIds.length === 0) return [];
  const since = new Date(now - RECENT_DAYS * 86_400_000);
  const selection = {
    columns: { id: true, title: true, workspaceId: true, status: true, isHeld: true, executor: true } as const,
    extras: sqlExtras({ deliveredAt: deliveredAtSqlFor(since) }),
    orderBy: sqlOrderBy([desc(missions.updatedAt)]),
  };
  const openWhere = and(inArray(missions.workspaceId, workspaceIds), inArray(missions.status, [...OPEN_STATUSES]));
  const deliveredWhere = and(inArray(missions.workspaceId, workspaceIds), eq(missions.status, 'completed'), gte(deliveredAtSqlFor(since), since));
  const [open, delivered] = await Promise.all([
    db.query.missions.findMany({
      ...selection,
      where: sqlWhere(openWhere),
      limit: MAX_OPEN_MISSIONS + 1, // +1 to detect overflow
    }),
    db.query.missions.findMany({
      ...selection,
      where: sqlWhere(deliveredWhere),
      limit: MAX_DELIVERED_MISSIONS,
    }),
  ]);
  if (open.length > MAX_OPEN_MISSIONS) {
    console.warn(`[missions/recent] ${open.length} open missions exceed the safety cap of ${MAX_OPEN_MISSIONS}; returning the first ${MAX_OPEN_MISSIONS}`);
    open.splice(MAX_OPEN_MISSIONS);
  }
  return [...open, ...delivered].map(r => ({
    id: r.id,
    title: r.title,
    workspaceId: r.workspaceId as string,
    status: r.status,
    isHeld: !!r.isHeld,
    executor: r.executor,
    completedAt: r.status === 'completed' && r.deliveredAt ? new Date(r.deliveredAt).toISOString() : null,
  }));
}
