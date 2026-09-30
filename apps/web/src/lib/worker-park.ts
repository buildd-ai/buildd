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
import { and, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { workers } from '@buildd/core/db/schema';

/** Same as the standalone waiting_input timeout (stale-workers.ts cleanupStuckWaitingInput). */
export const PARK_MAX_MS = 24 * 60 * 60 * 1000;
/** Same as the mission waiting_input timeout. */
export const PARK_MISSION_MAX_MS = 4 * 60 * 60 * 1000;

/** Statuses a worker may be parked in: a question, or a run the agent parked after a restart. */
export const PARKABLE_STATUSES = ['waiting_input', 'running'] as const;

/**
 * park time + min(24 h, the task's waiting_input timeout). Past it the
 * existing cleanupStuckWaitingInput path takes over unchanged.
 */
export function parkedUntilFor(now: Date, isMissionTask: boolean): Date {
  return new Date(now.getTime() + (isMissionTask ? PARK_MISSION_MAX_MS : PARK_MAX_MS));
}

export function parkWhere(workerId: string, accountId: string) {
  return and(
    eq(workers.id, workerId),
    eq(workers.accountId, accountId),
    inArray(workers.status, [...PARKABLE_STATUSES]),
  );
}

export function unparkWhere(workerId: string, accountId: string) {
  return and(eq(workers.id, workerId), eq(workers.accountId, accountId));
}

/**
 * One conditional UPDATE is the whole re-attach: it clears the park, so of two
 * processes racing for the same worker exactly one gets the row back.
 */
export function reattachWhere(workerId: string, accountId: string, now: Date) {
  return and(
    eq(workers.id, workerId),
    eq(workers.accountId, accountId),
    inArray(workers.status, [...PARKABLE_STATUSES]),
    gt(workers.parkedUntil, now),
  );
}

/** Rows the offline-runner and staleness sweeps may act on: never a live park. */
export function notParkedScope(now: Date) {
  return or(isNull(workers.parkedUntil), lte(workers.parkedUntil, now));
}
