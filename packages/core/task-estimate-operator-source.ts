/**
 * The query half of `./task-estimate-operator.ts`: estimates created in an
 * admin window over a set of workspaces, with their task and actuals, plus the
 * coverage counts. Bounded by the window and `OPERATOR_ROW_LIMIT`; the
 * learning-curve subquery runs only for rows with actuals (the scored ones).
 */
import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from './db/client';
import { taskEstimateActuals, taskEstimates, tasks } from './db/schema';
import type { OperatorEstimateRow, OperatorReportInput } from './task-estimate-operator';

/** Estimate rows one operator read loads; the newest win. */
export const OPERATOR_ROW_LIMIT = 5000;

export interface OperatorScope {
  workspaceIds: readonly string[];
  since: Date;
  estimatorVersion?: string | null;
}

export async function fetchOperatorEstimateRows(scope: OperatorScope, limit = OPERATOR_ROW_LIMIT): Promise<{ rows: OperatorEstimateRow[]; truncated: boolean }> {
  if (scope.workspaceIds.length === 0) return { rows: [], truncated: false };
  const where = and(
    inArray(taskEstimates.workspaceId, [...scope.workspaceIds]),
    gte(taskEstimates.createdAt, scope.since),
    scope.estimatorVersion ? eq(taskEstimates.estimatorVersion, scope.estimatorVersion) : undefined,
  );
  const raw = await db
    .select({
      taskId: taskEstimates.taskId,
      teamId: taskEstimates.teamId,
      workspaceId: taskEstimates.workspaceId,
      estimatorVersion: taskEstimates.estimatorVersion,
      createdAt: taskEstimates.createdAt,
      p50Minutes: taskEstimates.p50Minutes,
      p80Minutes: taskEstimates.p80Minutes,
      p50Tokens: taskEstimates.p50Tokens,
      p80Tokens: taskEstimates.p80Tokens,
      expectedRepairs: taskEstimates.expectedRepairs,
      explanation: taskEstimates.explanation,
      kind: tasks.kind,
      complexity: tasks.complexity,
      taskClass: tasks.taskClass,
      taskStatus: tasks.status,
      actualMinutes: taskEstimateActuals.agentMinutes,
      actualTokens: taskEstimateActuals.tokens,
      actualRepairs: taskEstimateActuals.repairs,
      // Same definition as fetchLiveEstimateRows: a task's finish is its last completed session's end.
      priorCompleted: sql<number | null>`CASE WHEN ${taskEstimateActuals.taskId} IS NULL THEN NULL ELSE (
        SELECT COUNT(*) FROM (
          SELECT w.task_id
            FROM workers w
            JOIN tasks pt ON pt.id = w.task_id
           WHERE pt.workspace_id = ${taskEstimates.workspaceId}
             AND pt.task_class = 'work'
             AND pt.status = 'completed'
             AND w.status = 'completed'
             AND w.completed_at IS NOT NULL
           GROUP BY w.task_id
          HAVING MAX(w.completed_at) < ${taskEstimates.createdAt}
        ) done
      ) END`.mapWith(v => (v === null ? null : Number(v))),
    })
    .from(taskEstimates)
    .innerJoin(tasks, eq(tasks.id, taskEstimates.taskId))
    .leftJoin(taskEstimateActuals, eq(taskEstimateActuals.taskId, taskEstimates.taskId))
    .where(where)
    .orderBy(desc(taskEstimates.createdAt))
    .limit(limit + 1);
  const truncated = raw.length > limit;
  const rows = raw.slice(0, limit).map(({ actualMinutes, actualTokens, actualRepairs, ...r }): OperatorEstimateRow => ({
    ...r,
    taskStatus: r.taskStatus as string,
    actuals: actualMinutes === null || actualTokens === null ? null : { minutes: actualMinutes, tokens: actualTokens, repairs: actualRepairs ?? 0 },
  }));
  return { rows, truncated };
}

/**
 * Coverage and write counts, aggregated in the query so the row cap does not
 * shrink them: work tasks created in the window, how many of those have an
 * estimate per version, and estimate rows written in the window.
 */
export async function fetchOperatorEstimateCounts(scope: OperatorScope): Promise<OperatorReportInput['counts']> {
  if (scope.workspaceIds.length === 0) return { workTasks: 0, estimatedByVersion: {}, written: 0 };
  const ids = [...scope.workspaceIds];
  const taskWhere = and(inArray(tasks.workspaceId, ids), gte(tasks.createdAt, scope.since), eq(tasks.taskClass, 'work'));
  const [work, estimated, written] = await Promise.all([
    db.select({ n: count() }).from(tasks).where(taskWhere),
    db
      .select({ version: taskEstimates.estimatorVersion, n: count() })
      .from(taskEstimates)
      .innerJoin(tasks, eq(tasks.id, taskEstimates.taskId))
      .where(and(taskWhere, scope.estimatorVersion ? eq(taskEstimates.estimatorVersion, scope.estimatorVersion) : undefined))
      .groupBy(taskEstimates.estimatorVersion),
    db
      .select({ n: count() })
      .from(taskEstimates)
      .where(and(inArray(taskEstimates.workspaceId, ids), gte(taskEstimates.createdAt, scope.since))),
  ]);
  return {
    workTasks: Number(work[0]?.n ?? 0),
    estimatedByVersion: Object.fromEntries(estimated.map(e => [e.version, Number(e.n)])),
    written: Number(written[0]?.n ?? 0),
  };
}
