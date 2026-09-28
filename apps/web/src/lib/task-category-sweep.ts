/**
 * The task category sweep: every task no trigger has looked at yet gets one
 * look (task-category-decision.ts). POST /api/tasks categorizes its own tasks
 * after the response; this covers every other creation path (missions,
 * schedules, webhooks, retries), from the hourly schedules tick, and is what
 * the backfill script runs over a wider window.
 *
 * A row's category may have come from its caller or from the keyword rules;
 * the row doesn't say. The sweep infers it: a category that differs from what
 * the keyword rules give for the same text was supplied, and is kept.
 */
import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import type { TaskCategoryValue } from '@buildd/shared';
import { classifyTask } from './task-category';
import { categorizeTask, type CategorizeResult } from './task-category-decision';

export interface SweepOptions {
  /** Only tasks created since. Unset = all (the backfill). */
  since?: Date;
  limit?: number;
  concurrency?: number;
  /** Stop starting new looks after this long; a run inside a cron must stay short. */
  budgetMs?: number;
  /** Also re-ask tasks skipped earlier because no key resolved. */
  retryUnconfigured?: boolean;
  categorize?: typeof categorizeTask;
}

/** Tasks no look has been recorded for (the backfill's dry run). */
export async function countPendingTaskCategories(): Promise<number> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(isNull(tasks.categoryDecision));
  return n;
}

export type SweepCounts = Record<CategorizeResult['outcome'], number> & { looked: number };

export async function sweepTaskCategories(opts: SweepOptions = {}): Promise<SweepCounts> {
  const { limit = 40, concurrency = 4, budgetMs = 20_000 } = opts;
  const categorize = opts.categorize ?? categorizeTask;
  const pending = opts.retryUnconfigured
    ? or(isNull(tasks.categoryDecision), sql`${tasks.categoryDecision}->>'skipped' = 'unconfigured'`)
    : isNull(tasks.categoryDecision);
  const rows = await db
    .select({
      id: tasks.id, title: tasks.title, description: tasks.description, category: tasks.category,
      workspaceId: tasks.workspaceId, accountId: tasks.createdByAccountId,
      teamId: workspaces.teamId, gitConfig: workspaces.gitConfig,
    })
    .from(tasks)
    .innerJoin(workspaces, eq(tasks.workspaceId, workspaces.id))
    .where(and(pending, opts.since ? gte(tasks.createdAt, opts.since) : undefined))
    .orderBy(desc(tasks.createdAt))
    .limit(limit);

  const counts: SweepCounts = { looked: 0, applied: 0, kept: 0, skipped: 0, lost_race: 0, error: 0 };
  const deadline = Date.now() + budgetMs;
  let next = 0;
  const worker = async () => {
    while (next < rows.length && Date.now() < deadline) {
      const r = rows[next++];
      if (!r.teamId) continue;
      const stored = (r.category ?? null) as TaskCategoryValue | null;
      const keyword = classifyTask(r.title, r.description ?? undefined) as TaskCategoryValue | null;
      const res = await categorize({
        taskId: r.id, teamId: r.teamId, workspaceId: r.workspaceId, accountId: r.accountId ?? null,
        title: r.title, description: r.description ?? null,
        stored, callerSet: stored !== null && stored !== keyword,
        dataClass: (r.gitConfig as { dataClass?: string } | null)?.dataClass ?? null,
      });
      counts.looked += 1;
      counts[res.outcome] += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return counts;
}
