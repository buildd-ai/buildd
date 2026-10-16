/**
 * What a read may do with a delivery-owned PR (docs/specs/workflow-kernel-library.md
 * §1, AC-3): a page render, an MCP read or `explain` that notices GitHub moved
 * records at most a fact. It never writes `tasks.status`/`result`,
 * `workers.mergedAt`, `workers.prLifecycleStatus`, `workers.prUrl` or
 * `workers.prNumber`, during the request or in `after()`.
 *
 * Two statements, both reached through seam.ts:
 *  - `deliveryOwnedWorkers`: a SELECT that says which workers' rows belong to a
 *    delivery (any authority), so the read-through knows to keep its hands off;
 *  - `recordPrStateObserved`: an INSERT of the `pr_closed` fact under the same
 *    natural key `ingestFact` uses (facts.ts `factKeyFor`), recorded but not
 *    applied. No reducer pass, no effect, no drain: the webhook and the hourly
 *    pr-reconcile ingest the same fact (a duplicate whose first application
 *    never ran is applied then), and the reducer decides there.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import type { Exec } from './kernel';
import { workspaceKernelOnSql } from './authority';
import { factKeyFor, insertFactSql } from './facts';
import { toLivePr } from './github-facts';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

export interface DeliveryOwnership {
  /** The kernel decides for this delivery (authority kernel, workspace switch on). */
  kernel: boolean;
}

/**
 * A worker's row is delivery-owned when its task owns a delivery, its task is
 * an attempt of one (`tasks.delivery_id`), or its PR number is a delivery's PR
 * in the same workspace. The PR match ignores the repo on purpose: an
 * over-match only means a read leaves a row to the healers, never a wrong write.
 */
export function deliveryOwnedWorkersSql(workerIds: string[]): SQL {
  return sql`-- workflow:delivery_owned_workers
SELECT w.id AS "workerId",
  bool_or(d.authority = 'kernel' AND ${workspaceKernelOnSql(sql`d.workspace_id`)}) AS kernel
FROM workers w
LEFT JOIN tasks t ON t.id = w.task_id
JOIN workflow_deliveries d ON d.workspace_id = w.workspace_id
  AND (d.owner_task_id = w.task_id OR d.id = t.delivery_id OR (w.pr_number IS NOT NULL AND d.pr_number = w.pr_number))
WHERE w.id IN (SELECT x::uuid FROM jsonb_array_elements_text(${JSON.stringify(workerIds)}::jsonb) x)
GROUP BY w.id`;
}

/** Throws on a read failure: the caller fails closed (treats every row as delivery-owned). */
export async function deliveryOwnedWorkers(workerIds: string[], exec: Exec = dbExec): Promise<Map<string, DeliveryOwnership>> {
  const ids = [...new Set(workerIds.filter(Boolean))];
  const out = new Map<string, DeliveryOwnership>();
  if (ids.length === 0) return out;
  const res = await exec(deliveryOwnedWorkersSql(ids));
  for (const r of (res.rows ?? []) as Array<{ workerId: unknown; kernel: unknown }>) {
    if (typeof r.workerId === 'string') out.set(r.workerId, { kernel: r.kernel === true });
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
  return true;
}
