import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, gt, inArray, or, sql } from 'drizzle-orm';
import type { MissionFollowupTask } from '@buildd/core/mission-helpers';

/** What `loadMissionFollowupTasks` needs to know about each mission it's scoring. */
export interface FollowupCandidateMission {
  id: string;
  completedAt: Date | string | null;
  /** This mission's own task ids — a `parentTaskId` onto one of these counts as a follow-up. */
  taskIds: string[];
}

/** A candidate row from `tasks` — created after the earliest completedAt in view, right taskClass. */
export interface FollowupCandidateRow {
  id: string;
  createdAt: Date | string;
  missionId: string | null;
  parentTaskId: string | null;
  context: Record<string, unknown> | null;
}

/**
 * Pure matcher: given candidate rows (already filtered to countable taskClass
 * and created after the earliest completedAt in view) and the missions being
 * scored, bucket each row under every mission it's a follow-up of. Split out
 * from the query so the matching rules — the actual logic — are testable
 * without a database.
 */
export function matchMissionFollowups(
  rows: FollowupCandidateRow[],
  missions: Array<FollowupCandidateMission & { completedAt: Date | string }>,
): Map<string, MissionFollowupTask[]> {
  const result = new Map<string, MissionFollowupTask[]>();
  const taskIdsByMission = new Map(missions.map(m => [m.id, new Set(m.taskIds)]));
  for (const m of missions) result.set(m.id, []);

  for (const row of rows) {
    for (const m of missions) {
      if (new Date(row.createdAt).getTime() <= new Date(m.completedAt).getTime()) continue;
      const matchesMissionId = row.missionId === m.id;
      const matchesParent = !!row.parentTaskId && taskIdsByMission.get(m.id)!.has(row.parentTaskId);
      const matchesFailureContext = row.context != null && JSON.stringify(row.context).includes(m.id);
      if (matchesMissionId || matchesParent || matchesFailureContext) {
        result.get(m.id)!.push({ id: row.id, createdAt: row.createdAt as unknown as Date });
      }
    }
  }

  return result;
}

/**
 * Batched lookup: for every mission that has a `completedAt`, find the
 * countable (work/bookkeeping) tasks created after it that still reference
 * that mission — by `missionId`, by `parentTaskId` onto one of its tasks, or
 * by a `failureContext` mention in `context`. One query for however many
 * missions are in view; missions with no `completedAt` are skipped (their
 * metric renders `no_baseline`, not zero).
 */
export async function loadMissionFollowupTasks(
  missions: FollowupCandidateMission[],
): Promise<Map<string, MissionFollowupTask[]>> {
  const scored = missions.filter((m): m is FollowupCandidateMission & { completedAt: Date | string } => m.completedAt != null);
  const result = new Map<string, MissionFollowupTask[]>();
  for (const m of missions) result.set(m.id, []);
  if (scored.length === 0) return result;

  const missionIds = scored.map(m => m.id);
  const allTaskIds = scored.flatMap(m => m.taskIds);
  const minCompletedAt = new Date(Math.min(...scored.map(m => new Date(m.completedAt).getTime())));

  const rows = await db
    .select({
      id: tasks.id,
      createdAt: tasks.createdAt,
      missionId: tasks.missionId,
      parentTaskId: tasks.parentTaskId,
      context: tasks.context,
    })
    .from(tasks)
    .where(and(
      inArray(tasks.taskClass, ['work', 'bookkeeping']),
      gt(tasks.createdAt, minCompletedAt),
      or(
        inArray(tasks.missionId, missionIds),
        allTaskIds.length > 0 ? inArray(tasks.parentTaskId, allTaskIds) : sql`false`,
        // UUIDs only ever contain hex digits and hyphens, so a plain
        // alternation is a safe regex — no escaping needed.
        sql`${tasks.context}::text ~* ${missionIds.join('|')}`,
      ),
    ));

  return matchMissionFollowups(rows as FollowupCandidateRow[], scored);
}
