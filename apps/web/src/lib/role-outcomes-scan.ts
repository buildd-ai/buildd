/**
 * DB reads for the `role-outcomes` feed. Read-only: two SELECTs, no writes.
 * The aggregation is pure and lives in `role-outcomes.ts`.
 */

import { db } from '@buildd/core/db';
import { tasks, workerHeartbeats, workers } from '@buildd/core/db/schema';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { FAILED_WORKER_STATUSES } from './failure-analytics';
import { HEARTBEAT_FRESH_MINUTES, scanStart, type HeartbeatVersionRow, type RoleOutcomeRow } from './role-outcomes';

/**
 * Row cap on the worker scan. A bound on an hourly query against production,
 * not a tuning knob: newest-first, so a truncated scan keeps the recent window
 * whole and loses the far end of the baseline. `truncated` is recorded.
 */
export const MAX_WORKER_ROWS = 10_000;

const COUNTED_STATUSES = ['completed', ...FAILED_WORKER_STATUSES];

export interface RoleOutcomesScan {
  workers: RoleOutcomeRow[];
  heartbeats: HeartbeatVersionRow[];
  truncated: boolean;
}

function asDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

export async function scanRoleOutcomes(now: Date): Promise<RoleOutcomesScan> {
  const rows = await db
    .select({
      status: workers.status,
      exitCause: workers.exitCause,
      error: workers.error,
      createdAt: workers.createdAt,
      completedAt: workers.completedAt,
      roleSlug: tasks.roleSlug,
    })
    .from(workers)
    .leftJoin(tasks, eq(tasks.id, workers.taskId))
    .where(and(gte(workers.createdAt, scanStart(now)), inArray(workers.status, COUNTED_STATUSES)))
    .orderBy(desc(workers.createdAt))
    .limit(MAX_WORKER_ROWS);

  const beats = await db
    .select({
      runnerVersion: workerHeartbeats.runnerVersion,
      runnerCommit: workerHeartbeats.runnerCommit,
      lastHeartbeatAt: workerHeartbeats.lastHeartbeatAt,
    })
    .from(workerHeartbeats)
    .where(gte(workerHeartbeats.lastHeartbeatAt, new Date(now.getTime() - HEARTBEAT_FRESH_MINUTES * 60_000)));

  return {
    workers: (rows as any[]).map(r => ({
      status: String(r.status),
      exitCause: (r.exitCause as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      roleSlug: (r.roleSlug as string | null) ?? null,
      createdAt: asDate(r.createdAt),
      completedAt: r.completedAt ? asDate(r.completedAt) : null,
    })),
    heartbeats: (beats as any[]).map(b => ({
      runnerVersion: (b.runnerVersion as string | null) ?? null,
      runnerCommit: (b.runnerCommit as string | null) ?? null,
      lastHeartbeatAt: asDate(b.lastHeartbeatAt),
    })),
    truncated: rows.length >= MAX_WORKER_ROWS,
  };
}
