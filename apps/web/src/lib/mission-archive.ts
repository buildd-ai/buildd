import { db } from '@buildd/core/db';
import { missions, tasks, taskSchedules } from '@buildd/core/db/schema';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { sqlExtras, sqlWhere } from '@buildd/core/db/relational-sql';

/**
 * Auto-archive for done missions ("Awaiting review" group): an active
 * mission whose tasks are all completed and that has seen no activity for
 * ARCHIVE_AFTER_MS moves to status='archived', clearing it from Home and
 * the default missions list. Missions with an enabled schedule are exempt
 * (they will run again); paused/completed are deliberate states we never
 * touch.
 */
export const ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface ArchiveCandidate {
  id: string;
  status: string;
  updatedAt: Date | string;
  scheduleEnabled: boolean | null;
  tasks: { status: string; updatedAt: Date | string }[];
  /** Count of stated goal criteria. Zero means the mission is not gated by them. */
  criteriaCount?: number;
  /** Stored `goalCriteriaState.overall`, or null when never evaluated. */
  criteriaOverall?: string | null;
}

export function selectMissionsToArchive(
  candidates: ArchiveCandidate[],
  now: Date,
): string[] {
  const cutoff = now.getTime() - ARCHIVE_AFTER_MS;
  return candidates
    .filter((m) => {
      if (m.status !== 'active') return false;
      if (m.scheduleEnabled === true) return false;
      if (m.tasks.length === 0) return false;
      if (!m.tasks.every((t) => t.status === 'completed')) return false;
      // Awaiting verification is not "done and ignored" — it is an open question.
      // Archiving clears the mission off Home, which is exactly how an unverified
      // mission disappears without anyone answering it.
      if ((m.criteriaCount ?? 0) > 0 && m.criteriaOverall !== 'pass') return false;
      const lastActivity = Math.max(
        new Date(m.updatedAt).getTime(),
        ...m.tasks.map((t) => new Date(t.updatedAt).getTime()),
      );
      return lastActivity < cutoff;
    })
    .map((m) => m.id);
}

/**
 * Fetch candidates, apply the pure selector, archive. Returns archived ids.
 *
 * Only missions that can pass the selector are read (spec "Fast at any size",
 * R-25): active, quiet past the cutoff, with at least one task, every task
 * completed and none touched since the cutoff. Their tasks come back as one
 * summary row (the newest update), not every row: the selector reads nothing
 * else of them. Criteria come back as a count and the stored verdict.
 */
export async function archiveStaleDoneMissions(now = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - ARCHIVE_AFTER_MS);
  const rows = (await db.query.missions.findMany({
    where: sqlWhere(and(
      eq(missions.status, 'active'),
      lt(missions.updatedAt, cutoff),
      sql`EXISTS (SELECT 1 FROM ${tasks} t WHERE t.mission_id = ${missions.id})`,
      sql`NOT EXISTS (SELECT 1 FROM ${tasks} t WHERE t.mission_id = ${missions.id} AND (t.status <> 'completed' OR t.updated_at >= ${cutoff.toISOString()}::timestamptz))`,
    )),
    columns: { id: true, status: true, updatedAt: true, scheduleId: true },
    extras: sqlExtras({
      criteriaCount: sql<number>`CASE WHEN jsonb_typeof(${missions.goalCriteria}) = 'array' THEN jsonb_array_length(${missions.goalCriteria}) ELSE 0 END`,
      criteriaOverall: sql<string | null>`${missions.goalCriteriaState}->>'overall'`,
      // Epoch milliseconds, truncated as a JS Date truncates the column.
      lastTaskUpdateMs: sql<number | null>`(SELECT floor(extract(epoch FROM max(t.updated_at)) * 1000)::float8 FROM ${tasks} t WHERE t.mission_id = ${missions.id})`,
    }),
    with: {
      schedule: { columns: { enabled: true } },
    },
  })) as Array<{
    id: string; status: string; updatedAt: Date; scheduleId: string | null;
    criteriaCount: number | null; criteriaOverall: string | null; lastTaskUpdateMs: number | string | null;
    schedule: { enabled: boolean } | null;
  }>;

  const candidates = rows.map(m => ({
    id: m.id,
    status: m.status,
    updatedAt: m.updatedAt,
    scheduleEnabled: m.schedule?.enabled ?? null,
    // Every task is completed (the read above): the newest update stands for them all.
    tasks: m.lastTaskUpdateMs != null ? [{ status: 'completed', updatedAt: new Date(Number(m.lastTaskUpdateMs)) }] : [],
    criteriaCount: Number(m.criteriaCount ?? 0),
    criteriaOverall: m.criteriaOverall ?? null,
    scheduleId: m.scheduleId,
  }));
  const ids = selectMissionsToArchive(candidates, now);

  if (ids.length > 0) {
    // Heartbeat schedules are owned by their mission — delete when the mission
    // is done. Mirrors the explicit-PATCH terminal-status path in
    // apps/web/src/app/api/missions/[id]/route.ts, which this raw db.update
    // otherwise bypasses (that's how the orphaned rows this fixes happened).
    const scheduleIds = candidates
      .filter((m: any) => ids.includes(m.id) && m.scheduleId)
      .map((m: any) => m.scheduleId as string);

    if (scheduleIds.length > 0) {
      await db.delete(taskSchedules).where(inArray(taskSchedules.id, scheduleIds));
    }

    await db
      .update(missions)
      .set({ status: 'archived', updatedAt: now, scheduleId: null })
      .where(inArray(missions.id, ids));
  }

  return ids;
}
