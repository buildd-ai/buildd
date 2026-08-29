/**
 * Worker-row fetch behind the usage rollups. Split from `usage-stats.ts` so
 * that module stays pure (and client-bundle safe — the health page's client
 * component imports its types).
 */

import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { and, gte, inArray } from 'drizzle-orm';
import type { UsageWorkerRow } from './usage-stats';

/** Cap on worker rows scanned per request. Keeps a 30d team-wide window bounded. */
export const USAGE_ROW_LIMIT = 5000;

/**
 * Terminal workers in the window, with the task fields the rollup groups by.
 * Failed workers are included — they burned tokens too, and excluding them
 * would understate what a role actually costs.
 */
export async function fetchUsageRows(opts: {
  workspaceIds: string[];
  windowStart: Date;
  limit?: number;
}): Promise<UsageWorkerRow[]> {
  if (opts.workspaceIds.length === 0) return [];

  const rows = await db.query.workers.findMany({
    where: and(
      inArray(workers.workspaceId, opts.workspaceIds),
      gte(workers.completedAt, opts.windowStart),
    ),
    columns: {
      id: true,
      taskId: true,
      workspaceId: true,
      inputTokens: true,
      outputTokens: true,
      costUsd: true,
      turns: true,
      resultMeta: true,
      mcpCalls: true,
    },
    with: {
      task: { columns: { id: true, status: true, roleSlug: true, parentTaskId: true } },
    },
    limit: opts.limit ?? USAGE_ROW_LIMIT,
  });

  return (rows as any[]).map(w => ({
    workerId: w.id,
    taskId: w.taskId ?? null,
    parentTaskId: w.task?.parentTaskId ?? null,
    workspaceId: w.workspaceId,
    taskStatus: w.task?.status ?? null,
    roleSlug: w.task?.roleSlug ?? null,
    inputTokens: w.inputTokens,
    outputTokens: w.outputTokens,
    costUsd: w.costUsd,
    turns: w.turns,
    resultMeta: w.resultMeta ?? null,
    mcpCalls: w.mcpCalls ?? null,
  }));
}
