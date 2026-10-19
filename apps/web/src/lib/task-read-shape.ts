/**
 * The shapes `GET /api/tasks/[id]` answers with (spec 3ef37387 R-19).
 *
 * - default (lean): every small column, `context` and `result` reduced to the
 *   keys `get_task` renders, no decision JSON, the workspace as id/name/repo.
 * - `view=status`: id, workspace, status and updatedAt, for pollers.
 * - `include=context|result|decisions`: that blob whole. `include=full`: the
 *   pre-R-19 row (every column, the workspace row without its dispatch token)
 *   for callers that still need it, the runner's claim path among them.
 */
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { tasks } from '@buildd/core/db/schema';
import { BACKEND_PINNED_KEY, BACKEND_ROUTING_KEY } from '@buildd/core/backend-policy';

/** `tasks.context` keys the lean read keeps: spec pin, backend routing, loop history. */
export const LEAN_CONTEXT_KEYS = ['specSource', BACKEND_PINNED_KEY, BACKEND_ROUTING_KEY, 'failedOverFrom', 'failoverReason', 'loopHistory'] as const;

/** `tasks.result` keys the lean read keeps: what `get_task` prints. */
export const LEAN_RESULT_KEYS = [
  'summary', 'summarySource', 'error', 'branch', 'commits', 'sha', 'files', 'added', 'removed',
  'prUrl', 'prNumber', 'mismatch', 'evidence', 'releaseSummary', 'loopHistory',
] as const;

function pick(column: AnyColumn, keys: readonly string[]): SQL<Record<string, unknown> | null> {
  const pairs = keys.map(k => sql`${k}::text, ${column} -> ${k}::text`);
  return sql<Record<string, unknown> | null>`case when ${column} is null then null else jsonb_strip_nulls(jsonb_build_object(${sql.join(pairs, sql`, `)})) end`;
}

export const leanContextSql = pick(tasks.context, LEAN_CONTEXT_KEYS);
export const leanResultSql = pick(tasks.result, LEAN_RESULT_KEYS);

export interface TaskReadShape {
  statusOnly: boolean;
  full: boolean;
  /** An expansion asked for by name (`include=full` asks for every blob). */
  wants: (name: string) => boolean;
  include: Set<string>;
}

export function taskReadShape(params: URLSearchParams): TaskReadShape {
  const include = new Set((params.get('include') || '').split(',').map(s => s.trim()).filter(Boolean));
  const full = include.has('full');
  return {
    statusOnly: params.get('view') === 'status',
    full,
    include,
    wants: name => include.has(name) || (full && ['context', 'result', 'decisions', 'evidence'].includes(name)),
  };
}

/** Columns for the task row: blobs only when asked for. */
export function taskReadColumns(shape: TaskReadShape) {
  if (shape.statusOnly) return { id: true, workspaceId: true, missionId: true, parentTaskId: true, createdByWorkerId: true, status: true, updatedAt: true } as const;
  if (shape.full) return undefined;
  return {
    ...(!shape.wants('context') ? { context: false as const } : {}),
    ...(!shape.wants('result') ? { result: false as const } : {}),
    ...(!shape.wants('decisions') ? { categoryDecision: false as const, verdictDecision: false as const } : {}),
    outputSchema: false as const, releaseResult: false as const, pathDeclaration: false as const,
  };
}
