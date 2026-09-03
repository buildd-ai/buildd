/**
 * Read side of the buildd-MCP per-action event stream (worker_action_events).
 *
 * This is deliberately raw: one row per call (workerId, taskId, action, ts),
 * no aggregation and no RUNTIME/WORK classification. Classifying a call
 * requires joining it to its task's outputRequirement/loopConfig — that join
 * belongs to whoever builds the drill-down panel that consumes this, not
 * here (health-analytics-spec §4.3 item 1 / WU-4 explicitly scopes this file
 * to "the events exist and carry enough context", not to rendering).
 */

import { db } from '@buildd/core/db';
import { workerActionEvents, workers } from '@buildd/core/db/schema';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';

/**
 * ISO date the runner started writing to worker_action_events. There is no
 * backfill — a row's absence before this date means "not yet captured", not
 * "no buildd calls happened". Consumers must render "actions recorded since
 * {date}" rather than let a quiet pre-capture window read as zero activity.
 * This is a third coverage class, distinct from `tools.coverage`'s
 * histogram/derived/none split in usage-stats.ts, which has a derived
 * fallback — this capture has none.
 */
export const ACTION_EVENTS_CAPTURED_SINCE = '2026-09-03';

/** Cap on event rows scanned per request. Mirrors USAGE_ROW_LIMIT's role in usage-stats-query.ts. */
export const ACTION_EVENTS_ROW_LIMIT = 5000;

export interface ActionEventRow {
  workerId: string;
  taskId: string | null;
  action: string;
  ts: Date;
}

/**
 * Raw action events in a window, newest-first, capped at `limit`. Scoped to
 * `workspaceIds` via a join on `workers` — the events table itself carries no
 * workspaceId (same choice as worker_error_traces).
 */
export async function fetchActionEvents(opts: {
  workspaceIds: string[];
  windowStart: Date;
  limit?: number;
}): Promise<ActionEventRow[]> {
  if (opts.workspaceIds.length === 0) return [];

  const rows = await db
    .select({
      workerId: workerActionEvents.workerId,
      taskId: workerActionEvents.taskId,
      action: workerActionEvents.action,
      ts: workerActionEvents.ts,
    })
    .from(workerActionEvents)
    .innerJoin(workers, eq(workerActionEvents.workerId, workers.id))
    .where(and(
      inArray(workers.workspaceId, opts.workspaceIds),
      gte(workerActionEvents.ts, opts.windowStart),
    ))
    .orderBy(desc(workerActionEvents.ts))
    .limit(opts.limit ?? ACTION_EVENTS_ROW_LIMIT);

  return rows;
}

/**
 * Terminal worker population in the window — the denominator for the third
 * coverage class (`workersWithEvents / workers`). Same population usage-stats
 * reads (`completedAt >= windowStart`), so the two coverage figures on
 * adjacent panels describe the same cohort.
 */
export async function countWorkersInWindow(opts: {
  workspaceIds: string[];
  windowStart: Date;
}): Promise<number> {
  if (opts.workspaceIds.length === 0) return 0;

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workers)
    .where(and(
      inArray(workers.workspaceId, opts.workspaceIds),
      gte(workers.completedAt, opts.windowStart),
    ));

  return row?.count ?? 0;
}
