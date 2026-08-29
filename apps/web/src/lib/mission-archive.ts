import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';

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

/** Fetch candidates, apply the pure selector, archive. Returns archived ids. */
export async function archiveStaleDoneMissions(now = new Date()): Promise<string[]> {
  const candidates = await db.query.missions.findMany({
    where: eq(missions.status, 'active'),
    columns: { id: true, status: true, updatedAt: true, goalCriteria: true, goalCriteriaState: true },
    with: {
      schedule: { columns: { enabled: true } },
      tasks: { columns: { status: true, updatedAt: true } },
    },
  });

  const ids = selectMissionsToArchive(
    candidates.map((m: any) => ({
      id: m.id,
      status: m.status,
      updatedAt: m.updatedAt,
      scheduleEnabled: m.schedule?.enabled ?? null,
      tasks: m.tasks ?? [],
      criteriaCount: Array.isArray(m.goalCriteria) ? m.goalCriteria.length : 0,
      criteriaOverall: m.goalCriteriaState?.overall ?? null,
    })),
    now,
  );

  if (ids.length > 0) {
    await db
      .update(missions)
      .set({ status: 'archived', updatedAt: now })
      .where(inArray(missions.id, ids));
  }

  return ids;
}
