/**
 * Read side of the per-worker subagent-delegation columns (`subagent_spans`,
 * `subagent_spans_observed`, `background_agent_ms`) added in migration 0107
 * (packages/core/drizzle/0107_absent_the_executioner.sql). See
 * `buildSubagentDelegationPanel` in `./subagent-time` for what they compute.
 */

import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { and, desc, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { SubagentTimeRow } from './subagent-time';

/**
 * ISO date the runner started writing subagent-delegation columns. A worker
 * row completed before this date reads `background_agent_ms = 0` by column
 * default, not because no delegation happened — the value is absent, not
 * measured, so such rows are excluded here rather than counted as a real zero.
 */
export const SUBAGENT_TIME_CAPTURED_SINCE = '2026-08-15';

/** Cap on worker rows scanned per request. Mirrors USAGE_ROW_LIMIT's role in usage-stats-query.ts. */
export const SUBAGENT_TIME_ROW_LIMIT = 5000;

/**
 * Terminal worker rows in the window, newest-first, capped at `limit`, scoped
 * to `workspaceIds`. Never returns a row from before `SUBAGENT_TIME_CAPTURED_SINCE`,
 * regardless of how far back `windowStart` reaches.
 */
export async function fetchSubagentTimeRows(opts: {
  workspaceIds: string[];
  windowStart: Date;
  limit?: number;
}): Promise<SubagentTimeRow[]> {
  if (opts.workspaceIds.length === 0) return [];

  const capturedSince = new Date(`${SUBAGENT_TIME_CAPTURED_SINCE}T00:00:00Z`);
  const effectiveStart = opts.windowStart > capturedSince ? opts.windowStart : capturedSince;

  const rows = await db
    .select({
      startedAt: workers.startedAt,
      completedAt: workers.completedAt,
      backgroundAgentMs: workers.backgroundAgentMs,
      subagentSpansObserved: workers.subagentSpansObserved,
      spansLength: sql<number>`jsonb_array_length(coalesce(${workers.subagentSpans}, '[]'::jsonb))`,
    })
    .from(workers)
    .where(and(
      inArray(workers.workspaceId, opts.workspaceIds),
      isNotNull(workers.completedAt),
      gte(workers.completedAt, effectiveStart),
    ))
    .orderBy(desc(workers.completedAt))
    .limit(opts.limit ?? SUBAGENT_TIME_ROW_LIMIT);

  return rows;
}
