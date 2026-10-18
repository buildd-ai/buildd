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
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { missionStatusNoteIntoPattern, MISSION_COMPLETED_MARKER, MISSION_STATUS_CHANGE_TITLES } from '@/lib/mission-status-note';
import { RECENTLY_DELIVERED_WINDOW_MS } from '@/lib/recently-delivered';
import type { RecentMission } from '@buildd/shared';

export const RECENT_DAYS = RECENTLY_DELIVERED_WINDOW_MS / 86_400_000;
/** Bound recent deliveries only; open missions must never be truncated. */
const MAX_DELIVERED_MISSIONS = 300;
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

/** Open missions, and those delivered since `since`, in the given workspaces. */
export function recentMissionsWhere(workspaceIds: string[], since: Date) {
  return and(
    inArray(missions.workspaceId, workspaceIds),
    or(
      inArray(missions.status, [...OPEN_STATUSES]),
      and(eq(missions.status, 'completed'), gte(deliveredAtSqlFor(since), since)),
    ),
  );
}

/**
 * The completed missions of these workspaces delivered since `since`, newest
 * activity first, each with its delivered time. One statement: the completion
 * notes are aggregated once per mission (a grouped subquery, joined), where a
 * correlated subquery used to run the note scan for every row, twice (once to
 * filter, once to select).
 */
export function deliveredMissionsQuery(workspaceIds: string[], since: Date) {
  const [title1, title2] = MISSION_STATUS_CHANGE_TITLES;
  const completed = and(inArray(missions.workspaceId, workspaceIds), eq(missions.status, 'completed'));
  const notes = db.select({
    missionId: missionNotes.missionId,
    at: sql<Date | string | null>`max(${missionNotes.createdAt})`.as('completed_note_at'),
  })
    .from(missionNotes)
    .innerJoin(missions, eq(missions.id, missionNotes.missionId))
    .where(and(completed, gte(missionNotes.createdAt, since), eq(missionNotes.type, 'update'), completionNote(title1, title2)))
    .groupBy(missionNotes.missionId)
    .as('completion_notes');
  const deliveredAt = sql<string | Date | null>`greatest(${missions.completedAt}, ${notes.at})`;
  return db.select({
    id: missions.id, title: missions.title, workspaceId: missions.workspaceId, status: missions.status,
    isHeld: missions.isHeld, armedAt: missions.armedAt, executor: missions.executor, deliveredAt,
  })
    .from(missions)
    .leftJoin(notes, eq(notes.missionId, missions.id))
    .where(and(completed, gte(deliveredAt, since)))
    .orderBy(desc(missions.updatedAt))
    .limit(MAX_DELIVERED_MISSIONS);
}

/** The listed missions, open first, newest activity first within each set; `completedAt` is the delivered time, set only on a completed one. */
export async function loadRecentMissions(workspaceIds: string[], now = Date.now()): Promise<Array<Omit<RecentMission, 'stage'>>> {
  if (workspaceIds.length === 0) return [];
  const since = new Date(now - RECENT_DAYS * 86_400_000);
  const [open, delivered] = await Promise.all([
    db.select({
      id: missions.id, title: missions.title, workspaceId: missions.workspaceId, status: missions.status,
      isHeld: missions.isHeld, executor: missions.executor,
    })
      .from(missions)
      .where(and(inArray(missions.workspaceId, workspaceIds), inArray(missions.status, [...OPEN_STATUSES])))
      .orderBy(desc(missions.updatedAt)),
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
