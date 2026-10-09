/**
 * Parked workers (docs/design/cloudflare-sandbox-runner.md, Phase 2
 * "Resumable runs"). A cloud --once runner whose worker is waiting for an
 * answer uploads its branch, uncommitted work and transcript, marks the worker
 * parked (`workers.parkedUntil`), and lets its container go. The answer wakes
 * a new container (`task.resume`) that re-attaches to the SAME worker.
 *
 * The predicates live here so the routes (`/api/workers/[id]/park`,
 * `/api/workers/[id]/reattach`) and the sweeps (stale-workers.ts) share one
 * definition, and so tests can render them to SQL.
 */
import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { workers } from '@buildd/core/db/schema';
import { PARKABLE_WORKER_STATUSES } from '@buildd/shared';

/** Same as the standalone waiting_input timeout (stale-workers.ts cleanupStuckWaitingInput). */
export const PARK_MAX_MS = 24 * 60 * 60 * 1000;
/** Same as the mission waiting_input timeout. */
export const PARK_MISSION_MAX_MS = 4 * 60 * 60 * 1000;

/** Statuses a worker may be parked in: a question, or a run the agent parked after a restart. */
export const PARKABLE_STATUSES = PARKABLE_WORKER_STATUSES;

/**
 * park time + min(24 h, the task's waiting_input timeout). Past it the
 * existing cleanupStuckWaitingInput path takes over unchanged.
 */
export function parkedUntilFor(now: Date, isMissionTask: boolean): Date {
  return new Date(now.getTime() + (isMissionTask ? PARK_MISSION_MAX_MS : PARK_MAX_MS));
}

/**
 * The caller a predicate below is scoped to: the authenticated account, plus
 * the OAuth session user and per-task token scope when there are any.
 */
export interface WorkerCaller {
  id: string;
  teamId?: string | null;
  sessionUserId?: string | null;
  taskScope?: { taskId: string } | null;
}

/**
 * SQL form of callerOwnsWorker (lib/worker-owner.ts), for the conditional
 * UPDATEs below, which must not read the row first. Same account, and the same
 * claimer: the session user for an OAuth session, no recorded claimer for a
 * bld_ key. A per-task token is further confined to its own task. Matches no
 * row on a missing account id, or a session with no team id.
 */
export function ownedByCaller(caller: WorkerCaller): SQL {
  const sessionUser = caller.sessionUserId ?? null;
  if (!caller.id || (sessionUser !== null && !caller.teamId)) return sql`false`;
  const taskId = caller.taskScope?.taskId;
  return and(
    eq(workers.accountId, caller.id),
    sessionUser === null
      ? isNull(workers.claimedByUserId)
      : and(eq(workers.claimedByUserId, sessionUser), isNotNull(workers.workspaceId)),
    ...(taskId ? [eq(workers.taskId, taskId)] : []),
  )!;
}

export function parkWhere(workerId: string, caller: WorkerCaller) {
  return and(
    eq(workers.id, workerId),
    ownedByCaller(caller),
    inArray(workers.status, [...PARKABLE_STATUSES]),
  );
}

export function unparkWhere(workerId: string, caller: WorkerCaller) {
  return and(eq(workers.id, workerId), ownedByCaller(caller));
}

/**
 * One conditional UPDATE is the whole re-attach: it clears the park, so of two
 * processes racing for the same worker exactly one gets the row back.
 */
export function reattachWhere(workerId: string, caller: WorkerCaller, now: Date) {
  return and(
    eq(workers.id, workerId),
    ownedByCaller(caller),
    inArray(workers.status, [...PARKABLE_STATUSES]),
    gt(workers.parkedUntil, now),
  );
}

/** Rows the offline-runner and staleness sweeps may act on: never a live park. */
export function notParkedScope(now: Date) {
  return or(isNull(workers.parkedUntil), lte(workers.parkedUntil, now));
}
