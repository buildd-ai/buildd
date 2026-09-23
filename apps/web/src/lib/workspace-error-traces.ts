/**
 * Workspace-level error-trace rollup: which trace patterns recur across a
 * workspace, and how often. Backs GET /api/workspaces/[id]/error-traces and
 * the `get_error_traces` MCP action's `workspaceId` scope.
 *
 * The per-task and per-worker trace routes answer "what did THIS run hit".
 * This answers "is this a new failure or the thirtieth occurrence", which is
 * what a caller needs before filing friction and which previously required
 * already knowing a task id.
 *
 * Aggregation happens in SQL (GROUP BY pattern) so a noisy workspace never
 * ships every trace row to the function to be counted in JS.
 *
 * Server-only: imports the db.
 */
import { db } from '@buildd/core/db';
import { workers, workerErrorTraces } from '@buildd/core/db/schema';
import { and, desc, eq, gt, sql, type SQL } from 'drizzle-orm';
import type { QueryBuilder } from 'drizzle-orm/pg-core';
import type { WorkspaceErrorTracePattern } from '@buildd/shared';

export const ROLLUP_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const ROLLUP_DEFAULT_LIMIT = 20;
export const ROLLUP_MAX_LIMIT = 100;
/** Example task ids returned per pattern. */
const EXAMPLE_TASKS = 3;

export interface RollupOptions {
  workspaceId: string;
  since: Date;
  limit: number;
}

export function parseRollupParams(params: URLSearchParams, now: Date = new Date()): { since: Date; limit: number } {
  const rawSince = params.get('since');
  let since = new Date(now.getTime() - ROLLUP_DEFAULT_WINDOW_MS);
  if (rawSince) {
    const parsed = new Date(rawSince);
    if (!isNaN(parsed.getTime())) since = parsed;
  }
  const rawLimit = parseInt(params.get('limit') ?? '', 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), ROLLUP_MAX_LIMIT)
    : ROLLUP_DEFAULT_LIMIT;
  return { since, limit };
}

/**
 * Traces carry no workspace_id of their own (task_id is nullable), so tenancy
 * comes from the worker that produced the trace: worker_id is NOT NULL and
 * every worker row has a workspace.
 */
function workspaceScope(workspaceId: string, since: Date): SQL {
  return and(eq(workers.workspaceId, workspaceId), gt(workerErrorTraces.ts, since))!;
}

const count = sql<number>`count(*)`.mapWith(Number);
const lastSeen = sql`max(${workerErrorTraces.ts})`;

/**
 * The rollup query, built on whatever select-capable builder the caller passes
 * — `db` to execute, a bare `QueryBuilder` to render the SQL in tests.
 */
export function buildWorkspaceErrorTraceRollupQuery(
  builder: Pick<typeof db, 'select'> | QueryBuilder,
  { workspaceId, since, limit }: RollupOptions,
) {
  return (builder as Pick<typeof db, 'select'>)
    .select({
      pattern: workerErrorTraces.pattern,
      count,
      taskCount: sql<number>`count(distinct ${workerErrorTraces.taskId})`.mapWith(Number),
      firstSeen: sql<Date | string>`min(${workerErrorTraces.ts})`,
      lastSeen: sql<Date | string>`${lastSeen}`,
      exampleExcerpt: sql<string>`(array_agg(${workerErrorTraces.excerpt} order by ${workerErrorTraces.ts} desc))[1]`,
      exampleSource: sql<string | null>`(array_agg(${workerErrorTraces.source} order by ${workerErrorTraces.ts} desc))[1]`,
      exampleTaskIds: sql<unknown>`array_to_json(((array_agg(distinct ${workerErrorTraces.taskId}::text) filter (where ${workerErrorTraces.taskId} is not null)))[1:${sql.raw(String(EXAMPLE_TASKS))}])`,
    })
    .from(workerErrorTraces)
    .innerJoin(workers, eq(workerErrorTraces.workerId, workers.id))
    .where(workspaceScope(workspaceId, since))
    .groupBy(workerErrorTraces.pattern)
    .orderBy(desc(count), desc(lastSeen))
    .limit(limit);
}

function toIso(v: Date | string | null | undefined): string {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function toIdList(v: unknown): string[] {
  let value = v;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

export async function getWorkspaceErrorTraceRollup(opts: RollupOptions): Promise<WorkspaceErrorTracePattern[]> {
  const rows = await buildWorkspaceErrorTraceRollupQuery(db, opts);
  return rows.map((r) => ({
    pattern: r.pattern,
    count: Number(r.count) || 0,
    taskCount: Number(r.taskCount) || 0,
    firstSeen: toIso(r.firstSeen),
    lastSeen: toIso(r.lastSeen),
    exampleExcerpt: r.exampleExcerpt ?? '',
    exampleSource: r.exampleSource ?? null,
    exampleTaskIds: toIdList(r.exampleTaskIds),
  }));
}
