/**
 * AC-3's two statements rendered through the real PgDialect: the ownership
 * read is a SELECT and the fact record an INSERT into workflow_facts, so a
 * read records at most a fact and never touches a lifecycle column.
 */
import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { deliveryOwnedWorkers, deliveryOwnedWorkersSql, prHasDeliveryOwnedRow, prHasDeliveryOwnedRowSql, recordPrStateObserved } from './render-observation';

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('deliveryOwnedWorkersSql', () => {
  it('is one SELECT matching a delivery by owner task, attempt delivery id or PR number', () => {
    const { sql, params } = render(deliveryOwnedWorkersSql(['w1', 'w2']));
    const text = norm(sql);
    expect(text.startsWith('-- workflow:delivery_owned_workers SELECT')).toBe(true);
    expect(text).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
    expect(text).toContain('JOIN workflow_deliveries d ON d.workspace_id = w.workspace_id');
    expect(text).toContain('d.owner_task_id = w.task_id OR d.id = t.delivery_id OR (w.pr_number IS NOT NULL AND d.pr_number = w.pr_number');
    // The PR match is repo-aware: same number in another repo is not this delivery's PR.
    expect(text).toContain("lower(w.pr_url) = lower('https://github.com/' || d.repo_full_name || '/pull/' || d.pr_number::text)");
    // Kernel-decided only while the workspace switch reads on.
    expect(text).toContain("d.authority = 'kernel' AND NOT EXISTS (SELECT 1 FROM workspaces kw");
    expect(text).toContain('GROUP BY w.id');
    expect(params).toContain(JSON.stringify(['w1', 'w2']));
  });

  it('maps rows to ownership and skips the statement for no ids', async () => {
    const seen: string[] = [];
    const exec = async (q: SQL) => { seen.push(render(q).sql); return { rows: [{ workerId: 'w1', kernel: true }, { workerId: 'w2', kernel: false }] }; };
    expect(await deliveryOwnedWorkers([], exec)).toEqual(new Map());
    expect(seen).toEqual([]);
    const owned = await deliveryOwnedWorkers(['w1', 'w2', 'w1'], exec);
    expect(owned.get('w1')).toEqual({ kernel: true });
    expect(owned.get('w2')).toEqual({ kernel: false });
    expect(seen).toHaveLength(1);
  });
});

describe('prHasDeliveryOwnedRowSql', () => {
  it('asks over every row the merge stamp would reach (same url and number), with the same ownership predicate', async () => {
    const { sql, params } = render(prHasDeliveryOwnedRowSql({ prUrl: 'https://github.com/owner/repo/pull/42', prNumber: 42 }));
    const text = norm(sql);
    expect(text.startsWith('-- workflow:pr_has_delivery_owned_row SELECT EXISTS')).toBe(true);
    expect(text).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
    expect(text).toContain('WHERE w.pr_url = $1::text AND w.pr_number = $2::int');
    expect(text).toContain("lower(w.pr_url) = lower('https://github.com/' || d.repo_full_name");
    expect(params).toEqual(['https://github.com/owner/repo/pull/42', 42]);
    expect(await prHasDeliveryOwnedRow({ prUrl: 'u', prNumber: 1 }, async () => ({ rows: [{ owned: true }] }))).toBe(true);
    expect(await prHasDeliveryOwnedRow({ prUrl: 'u', prNumber: 1 }, async () => ({ rows: [{ owned: false }] }))).toBe(false);
  });
});

describe('recordPrStateObserved', () => {
  const pull = (over: Record<string, unknown>) => ({ state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', head: { sha: 'abc' }, base: { ref: 'dev' }, ...over });

  it('records a merged PR as the pr_closed fact under the merged key, and nothing else', async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const exec = async (q: SQL) => { seen.push(render(q)); return { rows: [] }; };
    const ok = await recordPrStateObserved({ workspaceId: 'ws1', repoFullName: 'owner/repo', prNumber: 42, pull: pull({}), source: 'render:test' }, exec);
    expect(ok).toBe(true);
    expect(seen).toHaveLength(1);
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
