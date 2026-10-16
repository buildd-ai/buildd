/**
 * AC-3's two statements rendered through the real PgDialect: the ownership
 * read is a SELECT and the fact record an INSERT into workflow_facts, so a
 * read records at most a fact and never touches a lifecycle column.
 */
import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { deliveryOwnedWorkers, deliveryOwnedWorkersSql, recordPrStateObserved } from './render-observation';

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('deliveryOwnedWorkersSql', () => {
  it('is one SELECT by the one definition of delivery-owned: a kernel-authority delivery, switch on, owns the row\'s PR', () => {
    const { sql, params } = render(deliveryOwnedWorkersSql(['w1', 'w2']));
    const text = norm(sql);
    expect(text.startsWith('-- workflow:delivery_owned_workers SELECT')).toBe(true);
    expect(text).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
    // The same predicate the PR fact funnel's scope excludes (pr-fact-scope.ts kernelOwnedRowSql):
    expect(text).toContain("EXISTS (SELECT 1 FROM workflow_deliveries kd JOIN workspaces kw ON kw.id = kd.workspace_id WHERE kd.authority = 'kernel'");
    expect(text).toContain("(COALESCE((kw.git_config)->>'workflowKernel', 'true') IN ('true', 'on'))");
    // Repo-aware and case folded: the same number in another repo is not this delivery's PR.
    expect(text).toContain("w.workspace_id = kd.workspace_id AND w.pr_number = kd.pr_number AND lower(w.pr_url) = lower('https://github.com/' || kd.repo_full_name || '/pull/' || kd.pr_number::text)");
    // A released delivery (authority legacy) is not owned, so it is no longer matched by owner task.
    expect(text).not.toContain('owner_task_id');
    expect(params).toContain(JSON.stringify(['w1', 'w2']));
  });

  it('maps rows to the owned set and skips the statement for no ids', async () => {
    const seen: string[] = [];
    const exec = async (q: SQL) => { seen.push(render(q).sql); return { rows: [{ workerId: 'w1' }] }; };
    expect(await deliveryOwnedWorkers([], exec)).toEqual(new Set());
    expect(seen).toEqual([]);
    const owned = await deliveryOwnedWorkers(['w1', 'w2', 'w1'], exec);
    expect(owned.has('w1')).toBe(true);
    expect(owned.has('w2')).toBe(false);
    expect(seen).toHaveLength(1);
  });
});

describe('recordPrStateObserved', () => {
  const pull = (over: Record<string, unknown>) => ({ state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', head: { sha: 'abc' }, base: { ref: 'dev' }, ...over });

  it('records a merged PR as the pr_closed fact under the merged key, and nothing else', async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const exec = async (q: SQL) => { seen.push(render(q)); return { rows: [] }; };
    const ok = await recordPrStateObserved({ workspaceId: 'ws1', repoFullName: 'owner/repo', prNumber: 42, pull: pull({}), source: 'render:test' }, exec);
    expect(ok).toBe(true);
    // The fact, then (S4a) a SELECT for the kernel delivery to schedule the fast heal for: no other write.
    expect(seen).toHaveLength(2);
    expect(norm(seen[1].sql)).toStartWith('-- workflow:kernel_delivery_of_pr SELECT');
    expect(norm(seen[0].sql)).toStartWith('-- workflow:insert_fact INSERT INTO workflow_facts');
    expect(seen[0].sql).toContain('ON CONFLICT (workspace_id, fact_key) DO NOTHING');
    expect(seen[0].params).toContain('pr_closed');
    expect(seen[0].params).toContain('merged:owner/repo#42');
    expect(seen[0].params).toContain('render:test');
  });

  it('records nothing for an open PR', async () => {
    const seen: string[] = [];
    const exec = async (q: SQL) => { seen.push(render(q).sql); return { rows: [] }; };
    const ok = await recordPrStateObserved({ workspaceId: 'ws1', repoFullName: 'owner/repo', prNumber: 42, pull: pull({ state: 'open', merged: false, merged_at: null }), source: 'render:test' }, exec);
    expect(ok).toBe(false);
    expect(seen).toEqual([]);
  });
});
