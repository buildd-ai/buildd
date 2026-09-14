/**
 * Read side of `worker_error_traces` for the fleet-wide pattern-cost rollup.
 * See `buildErrorPatternPanel` in `./error-pattern-cost` for what this feeds.
 */

import { db } from '@buildd/core/db';
import { workerErrorTraces, workers } from '@buildd/core/db/schema';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { ErrorPatternTraceRow } from './error-pattern-cost';
import { FAILED_WORKER_STATUSES } from './failure-analytics';

/**
 * ISO date the scanner's false-positive gating was completed: PR #2152 gated
 * permission_denied/enoent/git_error/rate_limit/connection_refused/timeout,
 * and PR #2171 (merged 2026-09-07) finished the audit by gating no_such_file,
 * both command_not_found wordings, git_fatal, and sandbox_mount_gap. Traces
 * before this date can include patterns that fired on successful tool output
 * — see `apps/runner/src/error-trace-scanner.ts` for the full history. Only
 * `cd_no_such_file`, `oom_killed`, and `bwrap_namespace_denied` remain
 * ungated by design (narrow, format-locked signals kept for mid-chain-failure
 * recall) — if any of those dominate the ranking this reads, that is why.
 */
export const ERROR_TRACE_GATED_SINCE = '2026-09-07';

/** Cap on trace rows scanned per request. Mirrors SUBAGENT_TIME_ROW_LIMIT's role in subagent-time-query.ts. */
export const ERROR_PATTERN_ROW_LIMIT = 5000;

/** The window clamped to on/after `ERROR_TRACE_GATED_SINCE`, whichever is later. */
export function errorPatternEffectiveStart(windowStart: Date): Date {
  const gatedSinceDate = new Date(`${ERROR_TRACE_GATED_SINCE}T00:00:00Z`);
  return windowStart > gatedSinceDate ? windowStart : gatedSinceDate;
}

/**
 * Error-trace rows in the window, clamped to on/after the gate date, joined to
 * their owning worker's terminal status. Scoped to `workspaceIds` via a join
 * on `workers` — `worker_error_traces` itself carries no workspaceId (same
 * choice as `worker_action_events`; see `action-events.ts`).
 */
export async function fetchErrorPatternRows(opts: {
  workspaceIds: string[];
  windowStart: Date;
  limit?: number;
}): Promise<ErrorPatternTraceRow[]> {
  if (opts.workspaceIds.length === 0) return [];

  const effectiveStart = errorPatternEffectiveStart(opts.windowStart);

  const rows = await db
    .select({
      pattern: workerErrorTraces.pattern,
      workerId: workerErrorTraces.workerId,
      status: workers.status,
    })
    .from(workerErrorTraces)
    .innerJoin(workers, eq(workers.id, workerErrorTraces.workerId))
    .where(and(
      inArray(workers.workspaceId, opts.workspaceIds),
      gte(workerErrorTraces.ts, effectiveStart),
    ))
    // Newest first, so a truncated scan on a busy window keeps the most
    // recent slice rather than an arbitrary one.
    .orderBy(desc(workerErrorTraces.ts))
    .limit(opts.limit ?? ERROR_PATTERN_ROW_LIMIT);

  return (rows as { pattern: string; workerId: string; status: string }[]).map(r => ({
    pattern: r.pattern,
    workerId: r.workerId,
    workerFailed: (FAILED_WORKER_STATUSES as readonly string[]).includes(r.status),
  }));
}
