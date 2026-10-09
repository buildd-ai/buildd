/**
 * DB read behind fleet occupancy. Split from `fleet-occupancy.ts` so the fold
 * stays pure and client-safe. Scoped to the given workspaces, which the caller
 * resolves from one team.
 */

import { db } from '@buildd/core/db';
import { workers, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or, type SQL } from 'drizzle-orm';
import { LIVE_WORKER_STATUSES } from '@buildd/shared';
import { buildOccupancySeries, occupancyBuckets, type OccupancySeries, type OccupancyWindow, type OccupancyWorkerRow } from './fleet-occupancy';

/** The team's workspace ids: the scope every occupancy read is limited to. */
export async function teamWorkspaceIds(teamId: string): Promise<string[]> {
  const rows = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.teamId, teamId));
  return (rows as { id: string }[]).map(r => r.id);
}

/** Cap on worker rows per request; newest first, so a cut drops the oldest work. */
export const OCCUPANCY_ROW_LIMIT = 20_000;

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);

/**
 * Workers that may have held a slot in [since, now): started before now, and
 * finished inside the window, or not finished and either live or touched inside
 * it (the fold caps those; one last touched before the window ended before it).
 */
export function occupancyWhere(workspaceIds: string[], since: Date, now: Date): SQL {
  return and(
    inArray(workers.workspaceId, workspaceIds),
    isNotNull(workers.startedAt),
    lt(workers.startedAt, now),
    or(
      gte(workers.completedAt, since),
      and(isNull(workers.completedAt), or(inArray(workers.status, [...LIVE_WORKER_STATUSES]), gte(workers.updatedAt, since))),
    ),
  )!;
}

/** Workers that held a slot at some point in [since, now). */
export async function fetchOccupancyRows(workspaceIds: string[], since: Date, now: Date): Promise<OccupancyWorkerRow[]> {
  if (workspaceIds.length === 0) return [];
  const rows = await db
    .select({
      runner: workers.runner,
      status: workers.status,
      startedAt: workers.startedAt,
      completedAt: workers.completedAt,
      updatedAt: workers.updatedAt,
    })
    .from(workers)
    .where(occupancyWhere(workspaceIds, since, now))
    .orderBy(desc(workers.startedAt))
    .limit(OCCUPANCY_ROW_LIMIT);
  return (rows as Array<{ runner: string | null; status: string; startedAt: Date | null; completedAt: Date | null; updatedAt: Date | null }>).map(r => ({
    runner: r.runner,
    status: r.status,
    startedAt: ms(r.startedAt),
    completedAt: ms(r.completedAt),
    updatedAt: ms(r.updatedAt),
  }));
}

export async function loadOccupancySeries(workspaceIds: string[], window: OccupancyWindow, now = Date.now(), tzOffsetMs = 0): Promise<OccupancySeries & { truncated: boolean }> {
  const { from } = occupancyBuckets(window, now, tzOffsetMs);
  const rows = await fetchOccupancyRows(workspaceIds, new Date(from), new Date(now));
  return { ...buildOccupancySeries({ window, now, workers: rows, tzOffsetMs }), truncated: rows.length >= OCCUPANCY_ROW_LIMIT };
}
