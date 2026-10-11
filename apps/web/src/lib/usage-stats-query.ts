/**
 * Worker-row fetch behind the usage rollups. Split from `usage-stats.ts` so
 * that module stays pure (and client-bundle safe — the health page's client
 * component imports its types).
 */

import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import type { UsageWorkerRow } from './usage-stats';

/** Cap on worker rows scanned per request. Keeps a 30d team-wide window bounded. */
export const USAGE_ROW_LIMIT = 5000;

/**
 * Terminal workers in the window, with the task fields the rollup groups by.
 * Failed workers are included — they burned tokens too, and excluding them
 * would understate what a role actually costs.
 *
 * The order is part of the contract. With `limit` and no `orderBy`, a window
 * larger than the cap returned an arbitrary subset, which makes the p50/p90 in
 * /api/stats/usage a percentile of nothing. Newest-first means a truncated scan
 * is the COMPLETE set of workers for a narrower window, which the route reports
 * as `scan.completeSince`. `id` breaks completedAt ties so paging is stable.
 */
export async function fetchUsageRows(opts: {
  workspaceIds: string[];
  windowStart: Date;
  /**
   * Exclusive upper bound, for reading a PREVIOUS period of equal length beside
   * the current one. Exclusive so a worker sitting exactly on the boundary is
   * counted in the newer period only, never in both.
   */
  windowEnd?: Date;
  limit?: number;
  /** Only the work on tasks this person started (`tasks.createdByUserId`): a member's own usage. */
  forUserId?: string;
}): Promise<UsageWorkerRow[]> {
  if (opts.workspaceIds.length === 0) return [];

  const rows = await db.query.workers.findMany({
    where: and(
      inArray(workers.workspaceId, opts.workspaceIds),
      gte(workers.completedAt, opts.windowStart),
      opts.windowEnd ? lt(workers.completedAt, opts.windowEnd) : undefined,
      opts.forUserId
        ? inArray(workers.taskId, db.select({ id: tasks.id }).from(tasks).where(eq(tasks.createdByUserId, opts.forUserId)))
        : undefined,
    ),
    columns: {
      id: true,
      completedAt: true,
      taskId: true,
      workspaceId: true,
      inputTokens: true,
      outputTokens: true,
      costUsd: true,
      turns: true,
      resultMeta: true,
      mcpCalls: true,
      runner: true,
      costBasis: true,
    },
    with: {
      // `predictedModel` is the assigned side of the divergence rate — the model
      // the router picked at claim time, against which `resultMeta.modelUsage`
      // is compared.
      task: {
        columns: {
          id: true,
          status: true,
          roleSlug: true,
          creationSource: true,
          parentTaskId: true,
          predictedModel: true,
          createdAt: true,
          claimedAt: true,
        },
        // One boolean, not the whole context blob: the role split needs only
        // whether the role was routed (lib/task-role-apply.ts).
        // The callback form: a nested relation is aliased, so the column must
        // come from the aliased table, not the imported one.
        extras: (t, { sql }) => ({
          roleInferred: sql<boolean>`(${t.context} -> 'roleInferred') is not null`.as('role_inferred'),
        }),
      },
    },
    orderBy: [desc(workers.completedAt), desc(workers.id)],
    limit: opts.limit ?? USAGE_ROW_LIMIT,
  });

  return (rows as any[]).map(w => ({
    workerId: w.id,
    completedAt: w.completedAt ?? null,
    taskId: w.taskId ?? null,
    parentTaskId: w.task?.parentTaskId ?? null,
    workspaceId: w.workspaceId,
    taskStatus: w.task?.status ?? null,
    roleSlug: w.task?.roleSlug ?? null,
    roleInferred: w.task?.roleInferred === true,
    taskCreatedAt: w.task?.createdAt ?? null,
    taskClaimedAt: w.task?.claimedAt ?? null,
    creationSource: w.task?.creationSource ?? null,
    assignedModel: w.task?.predictedModel ?? null,
    inputTokens: w.inputTokens,
    outputTokens: w.outputTokens,
    costUsd: w.costUsd,
    turns: w.turns,
    resultMeta: w.resultMeta ?? null,
    mcpCalls: w.mcpCalls ?? null,
    runner: w.runner ?? null,
    costBasis: w.costBasis ?? null,
  }));
}
