/**
 * Which worker row records a PR that `create_pr` just opened or adopted.
 *
 * A worker row carries ONE PR (`prUrl`/`prNumber`) and every per-PR surface
 * (get_pr, explain, update_pr, request_pr_review, delta re-review arming) finds
 * its owner by that number. A task may legitimately ship more than one PR (a
 * split, a stacked pair), so a second PR must not overwrite the first PR's
 * link: that orphans the first PR (404 'PR not found', 'already under review'
 * with no review task, no re-review) and hands its slot to a draft that
 * stacked PRs auto-land into.
 *
 * When the worker already holds a different, still-live PR, the new PR gets a
 * sibling owner row on the same task (the shape adoption uses for a PR buildd
 * did not push) and the first PR keeps the original worker.
 */

import { db } from '@buildd/core/db';
import { workers } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { isTerminalPrLifecycle } from '@/lib/dep-gate-contract';
import { recordPrFact } from '@buildd/core/pr-facts';
import { factFunnelScope } from '@/lib/workflow/pr-fact-scope';

export interface WorkerPrSlot {
  id: string;
  workspaceId: string | null;
  taskId: string | null;
  accountId?: string | null;
  name?: string | null;
  prNumber: number | null;
  prUrl: string | null;
  mergedAt?: Date | string | null;
  prLifecycleStatus?: string | null;
}

/** True when recording `newPrNumber` on this worker would displace a live, different PR. */
export function wouldDisplaceLivePr(worker: WorkerPrSlot, newPrNumber: number | null): boolean {
  if (!newPrNumber || !worker.prNumber || !worker.prUrl) return false;
  if (worker.prNumber === newPrNumber) return false;
  if (worker.mergedAt || isTerminalPrLifecycle(worker.prLifecycleStatus)) return false;
  return !!worker.taskId && !!worker.workspaceId;
}

/** The worker id to write the new PR's columns to: the worker itself, or a fresh sibling. */
export async function workerIdForNewPr(
  worker: WorkerPrSlot,
  pr: { number: number | null; url: string; head: string | null },
): Promise<string> {
  if (!wouldDisplaceLivePr(worker, pr.number)) return worker.id;
  // A retry for a PR this task already gave its own row reuses that row.
  const existing = await db.query.workers.findFirst({
    where: sqlWhere(and(eq(workers.taskId, worker.taskId!), eq(workers.prNumber, pr.number!))),
    columns: { id: true },
  });
  if (existing) return existing.id;
  const [row] = await db
    .insert(workers)
    .values({
      workspaceId: worker.workspaceId!,
      taskId: worker.taskId!,
      accountId: worker.accountId ?? null,
      name: `${worker.name ?? 'worker'} · PR #${pr.number}`,
      runner: 'external',
      branch: pr.head ?? `pr-${pr.number}`,
      status: 'completed',
      prNumber: pr.number,
      prUrl: pr.url,
    })
    .returning({ id: workers.id });
  if (!row?.id) return worker.id;
  await recordPrFact({ workerId: row.id }, { kind: 'open' }, { scope: factFunnelScope });
  return row.id;
}
