/**
 * What a read may do with a delivery-owned PR (docs/specs/workflow-kernel-library.md
 * §1, AC-3): a page render, an MCP read or `explain` that notices GitHub moved
 * records at most a fact. It never writes `tasks.status`/`result`,
 * `workers.mergedAt`, `workers.prLifecycleStatus`, `workers.prUrl` or
 * `workers.prNumber`, during the request or in `after()`.
 *
 * Two statements, both reached through seam.ts:
 *  - `deliveryOwnedWorkers`: a SELECT that says which workers' rows are
 *    delivery-owned (pr-fact-scope.ts `kernelOwnedRowSql`, the one definition the
 *    fact funnel uses too), so the read-through knows to keep its hands off;
 *  - `recordPrStateObserved`: an INSERT of the `pr_closed` fact under the same
 *    natural key `ingestFact` uses (facts.ts `factKeyFor`), recorded but not
 *    applied. No reducer pass, no effect, no drain: it schedules the fast heal
 *    (kernel-heal.ts), the webhook or the floor ingest the same fact (a duplicate
 *    whose first application never ran is applied then), and the reducer decides there.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import type { Exec } from './kernel';
import { factKeyFor, insertFactSql } from './facts';
import { kernelOwnedRowSql } from './pr-fact-scope';
import { kernelDeliveryIdOfPr, scheduleKernelHeal } from './kernel-heal';
import { toLivePr } from './github-facts';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

/**
 * Which of `workerIds` are delivery-owned, by the one definition (pr-fact-scope.ts
 * `kernelOwnedRowSql`): the row's PR belongs to a delivery with authority kernel in a workspace
 * whose kill switch is on. A delivery released to legacy, or the switch off, is not owned: the
 * read heals it as before. One SELECT.
 */
export function deliveryOwnedWorkersSql(workerIds: string[]): SQL {
  return sql`-- workflow:delivery_owned_workers
SELECT w.id AS "workerId"
FROM workers w
WHERE w.id IN (SELECT x::uuid FROM jsonb_array_elements_text(${JSON.stringify(workerIds)}::jsonb) x)
  AND w.pr_number IS NOT NULL AND ${kernelOwnedRowSql()}`;
}

/** Throws on a read failure: the caller fails closed (treats every row as delivery-owned). */
export async function deliveryOwnedWorkers(workerIds: string[], exec: Exec = dbExec): Promise<Set<string>> {
  const ids = [...new Set(workerIds.filter(Boolean))];
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const res = await exec(deliveryOwnedWorkersSql(ids));
  for (const r of (res.rows ?? []) as Array<{ workerId: unknown }>) {
    if (typeof r.workerId === 'string') out.add(r.workerId);
  }
  return out;
}

/**
 * Record a closed or merged PR a read saw, as the `pr_closed` fact, without
 * applying it. `pull` is GitHub's pull object from the read that noticed it.
 * Returns true when a fact statement was issued (an open PR records nothing).
 */
export async function recordPrStateObserved(p: {
  workspaceId: string; repoFullName: string; prNumber: number; pull: unknown; source: string;
}, exec: Exec = dbExec): Promise<boolean> {
  const live = toLivePr(p.pull as Parameters<typeof toLivePr>[0]);
  if (!live || (live.state === 'open' && !live.merged)) return false;
  const fact = { kind: 'pr_closed' as const, workspaceId: p.workspaceId, source: p.source, repoFullName: p.repoFullName, prNumber: p.prNumber };
  await exec(insertFactSql({
    workspaceId: p.workspaceId, kind: 'pr_closed', factKey: factKeyFor(fact, live), source: p.source,
    repoFullName: p.repoFullName, prNumber: p.prNumber, payload: { live },
  }));
  // S4a: the fact is the kernel's to apply, in minutes (kernel-heal.ts), not on the hourly floor.
  // A Redis marker, not delivery state: the read still writes no lifecycle column.
  const deliveryId = await kernelDeliveryIdOfPr({ workspaceId: p.workspaceId, repoFullName: p.repoFullName, prNumber: p.prNumber }, exec).catch(() => null);
  if (deliveryId) await scheduleKernelHeal(deliveryId);
  return true;
}
