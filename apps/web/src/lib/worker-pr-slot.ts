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
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
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
  const id = await insertPrOwnerRow({
    workspaceId: worker.workspaceId!,
    taskId: worker.taskId!,
    accountId: worker.accountId ?? null,
    name: `${worker.name ?? 'worker'} · PR #${pr.number}`,
    branch: pr.head ?? `pr-${pr.number}`,
    prNumber: pr.number!,
    prUrl: pr.url,
  });
  return id ?? worker.id;
}

/**
 * A PR-only owner row on a task: no session ran on it, it only says which task
 * a PR belongs to, so every per-PR surface can find the PR. Also the row the
 * orphan-PR sweep (lib/orphan-pr-sweep.ts) adopts a PR onto when no worker or
 * delivery row holds it.
 */
export async function insertPrOwnerRow(row: {
  workspaceId: string;
  taskId: string;
  accountId: string | null;
  name: string;
  branch: string;
  prNumber: number;
  prUrl: string;
  prBaseRef?: string | null;
}): Promise<string | null> {
  const [inserted] = await db
    .insert(workers)
    .values({
      workspaceId: row.workspaceId,
      taskId: row.taskId,
      accountId: row.accountId,
      name: row.name,
      runner: 'external',
      branch: row.branch,
      status: 'completed',
      prNumber: row.prNumber,
      prUrl: row.prUrl,
      ...(row.prBaseRef ? { prBaseRef: row.prBaseRef } : {}),
    })
    .returning({ id: workers.id });
  if (!inserted?.id) return null;
  await recordPrFact({ workerId: inserted.id }, { kind: 'open' }, { scope: factFunnelScope });
  return inserted.id;
}

export interface OtherOpenPr { number: number; url: string }

/**
 * The task's other PRs that are still open, besides `prNumber`. A task that
 * opens a later PR re-implementing an earlier one leaves the earlier one open
 * with nobody deciding it; create_pr names them so the agent records the
 * supersession, or says they land alongside.
 */
export async function otherOpenTaskPrs(taskId: string | null, prNumber: number): Promise<OtherOpenPr[]> {
  if (!taskId) return [];
  const rows = await db.query.workers.findMany({
    where: sqlWhere(and(eq(workers.taskId, taskId), isNotNull(workers.prNumber), isNull(workers.mergedAt))),
    columns: { prNumber: true, prUrl: true, prLifecycleStatus: true },
  });
  const seen = new Set<number>();
  const out: OtherOpenPr[] = [];
  for (const r of rows ?? []) {
    if (!r.prNumber || !r.prUrl || r.prNumber === prNumber || seen.has(r.prNumber)) continue;
    if (isTerminalPrLifecycle(r.prLifecycleStatus)) continue;
    seen.add(r.prNumber);
    out.push({ number: r.prNumber, url: r.prUrl });
  }
  return out.sort((a, b) => a.number - b.number);
}

/** What create_pr tells the agent when its task still holds other open PRs. */
export function supersessionPrompt(prNumber: number, others: OtherOpenPr[]): string | null {
  if (others.length === 0) return null;
  const list = others.map(o => `#${o.number}`).join(', ');
  return `This task still has ${others.length === 1 ? 'another open PR' : 'other open PRs'}: ${list}. ` +
    `If PR #${prNumber} re-implements ${others.length === 1 ? 'it' : 'any of them'}, call record_pr_supersession ` +
    `{ prNumber: <old>, supersedingPrNumber: ${prNumber}, reason } for each and close it; ` +
    `if ${others.length === 1 ? 'it lands' : 'they land'} alongside, say so in the PR body.`;
}
