import { eq } from 'drizzle-orm';
import { db } from './db';
import { missions, tasks } from './db/schema';
import {
  computeMissionFlightStrip,
  type FlightStripSteeringEvent,
  type FlightStripTask,
  type FlightStripWorker,
  type MissionFlightStripData,
} from './mission-helpers';

/** Columns computeMissionFlightStrip needs off `tasks`, in the query shape
 * both the write-side store and the list page share. */
export const FLIGHT_STRIP_TASK_COLUMNS = {
  id: true,
  status: true,
  taskClass: true,
  roleSlug: true,
  kind: true,
  title: true,
} as const;

/** Columns computeMissionFlightStrip needs off `workers`. */
export const FLIGHT_STRIP_WORKER_COLUMNS = {
  id: true,
  taskId: true,
  status: true,
  startedAt: true,
  completedAt: true,
  updatedAt: true,
  exitCause: true,
} as const;

/** Loads exactly the fields `computeMissionFlightStrip` consumes for one
 * mission — the write-side counterpart to the list page's live-compute path,
 * so a completion-time write and an active-mission read never disagree about
 * what's fed in. */
export async function loadFlightStripInputs(
  missionId: string,
): Promise<{ tasks: FlightStripTask[]; workers: FlightStripWorker[] }> {
  const rows = await db.query.tasks.findMany({
    where: eq(tasks.missionId, missionId),
    columns: FLIGHT_STRIP_TASK_COLUMNS,
    with: { workers: { columns: FLIGHT_STRIP_WORKER_COLUMNS } },
  });

  const taskRows: FlightStripTask[] = rows.map(t => ({
    id: t.id,
    status: t.status,
    taskClass: t.taskClass,
    roleSlug: t.roleSlug,
    kind: t.kind,
    title: t.title,
  }));
  const workerRows: FlightStripWorker[] = rows.flatMap(t =>
    (t.workers ?? []).map(w => ({
      id: w.id,
      taskId: t.id,
      status: w.status,
      startedAt: w.startedAt,
      completedAt: w.completedAt,
      updatedAt: w.updatedAt,
      exitCause: w.exitCause,
    })),
  );
  return { tasks: taskRows, workers: workerRows };
}

/**
 * Rule P-1's write side: compute the flight strip once, at the moment a
 * mission transitions to `status='completed'`, and store it. A completed
 * mission's worker spans never change afterwards, so this never needs to
 * recompute — every later reader (Rule P-2) reads the stored snapshot
 * instead of re-querying tasks/workers.
 *
 * Callers own the "is this mission actually completing" decision; this
 * function always computes and overwrites. The backfill script is the one
 * caller that guards on `flightStripCache IS NULL` before calling it —
 * that's what makes the *backfill* idempotent, not this function.
 */
export async function computeAndStoreFlightStripCache(
  missionId: string,
  opts: { missionCompletedAt: Date | string; steeringEvents?: readonly FlightStripSteeringEvent[] },
): Promise<MissionFlightStripData> {
  const { tasks: taskRows, workers: workerRows } = await loadFlightStripInputs(missionId);
  const data = computeMissionFlightStrip(taskRows, workerRows, {
    missionCompletedAt: opts.missionCompletedAt,
    steeringEvents: opts.steeringEvents,
  });
  await db.update(missions).set({ flightStripCache: data }).where(eq(missions.id, missionId));
  return data;
}
