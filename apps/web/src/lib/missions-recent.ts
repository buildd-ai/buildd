/**
 * The read behind GET /api/missions/recent (spec c7410e76 R-24): every open
 * mission of the given workspaces, plus those delivered in the last 7 days.
 *
 * "Delivered" is the latest transition into completed, not
 * `missions.completedAt` alone. The automated completion re-stamps that column
 * each time, but an explicit status PATCH stamps it only on a mission's first
 * completion (the follow-up metric keys off it), so a mission completed,
 * reopened and completed again that way would still carry its first date.
 * Every PATCH status change writes a feed note (`missionStatusNoteBody`), so
 * the later of the stamp and the newest "→ completed" note is the current
 * completion. A reopened mission is open again and lists as open; a completed
 * mission with neither (finished before the stamp existed) is not listed.
 */
import { db } from '@buildd/core/db';
import { missionNotes, missions } from '@buildd/core/db/schema';
import { sqlExtras, sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { missionStatusNoteIntoPattern } from '@/lib/mission-status-note';
import type { RecentMission } from '@buildd/shared';

export const RECENT_DAYS = 7;
/** A bound on the read; no team keeps this many missions open or finishing in a week. */
const MAX_MISSIONS = 300;
const OPEN_STATUSES = ['active', 'paused', 'budget_exhausted'] as const;

/** When the mission last became completed: the later of its stamp and its newest "→ completed" status note. */
export const deliveredAtSql = sql<string | Date | null>`greatest(${missions.completedAt}, (
  select max(${missionNotes.createdAt}) from ${missionNotes}
  where ${missionNotes.missionId} = ${missions.id}
    and ${missionNotes.type} = 'update'
    and ${missionNotes.authorType} = 'system'
    and ${missionNotes.title} in ('Mission status changed', 'Mission reopened')
    and ${missionNotes.body} like ${missionStatusNoteIntoPattern('completed')}
))`;

/** Open missions, and those delivered since `since`, in the given workspaces. */
export function recentMissionsWhere(workspaceIds: string[], since: Date) {
  return and(
    inArray(missions.workspaceId, workspaceIds),
    or(
      inArray(missions.status, [...OPEN_STATUSES]),
      and(eq(missions.status, 'completed'), gte(deliveredAtSql, since)),
    ),
  );
}

/** The listed missions, newest activity first; `completedAt` is the delivered time, set only on a completed one. */
export async function loadRecentMissions(workspaceIds: string[], now = Date.now()): Promise<Array<Omit<RecentMission, 'stage'>>> {
  if (workspaceIds.length === 0) return [];
  const since = new Date(now - RECENT_DAYS * 86_400_000);
  const rows = await db.query.missions.findMany({
    where: sqlWhere(recentMissionsWhere(workspaceIds, since)),
    columns: { id: true, title: true, workspaceId: true, status: true, isHeld: true, executor: true },
    extras: sqlExtras({ deliveredAt: deliveredAtSql }),
    orderBy: sqlOrderBy([desc(missions.updatedAt)]),
    limit: MAX_MISSIONS,
  });
  return rows.map(r => ({
    id: r.id,
    title: r.title,
    workspaceId: r.workspaceId as string,
    status: r.status,
    isHeld: !!r.isHeld,
    executor: r.executor,
    completedAt: r.status === 'completed' && r.deliveredAt ? new Date(r.deliveredAt).toISOString() : null,
  }));
}
