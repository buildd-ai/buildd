/**
 * Render recordPrFactSql through PgDialect so a malformed fragment fails here.
 * The ordering rules themselves run on real Postgres in
 * apps/web/tests/db/pr-facts.test.ts (bun run test:db).
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { prFactApplies, recordPrFactSql } from '../pr-facts';

const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(q);

describe('recordPrFactSql', () => {
  test('a merge targets every row of the PR, keeps the first instant, and guards terminal-wins in the WHERE', () => {
    const { sql, params } = render(recordPrFactSql({ prUrl: 'https://github.com/acme/app/pull/7', prNumber: 7 }, { kind: 'merged', mergedAt: '2026-10-01T10:00:00Z' })!);
    expect(sql).toContain('w.pr_url = $');
    expect(sql).toContain('w.pr_number = $');
    expect(sql).not.toContain('w.id = $');
    expect(sql).toContain('merged_at = COALESCE(w.merged_at,');
    expect(sql).toContain("(w.merged_at IS NULL OR w.pr_lifecycle_status IS DISTINCT FROM 'merged')");
    expect(sql).toContain('RETURNING w.id, w.task_id, w.workspace_id, prev.previous_status');
    expect(params).toContain('2026-10-01T10:00:00.000Z');
  });

  test('an open fact never lifts merged; only a reopen lifts closed', () => {
    const plain = render(recordPrFactSql({ workerId: 'w1' }, { kind: 'open' })!).sql;
    const reopened = render(recordPrFactSql({ workerId: 'w1' }, { kind: 'open', reopened: true })!).sql;
    expect(plain).toContain('NOT IN ($');
    expect(render(recordPrFactSql({ workerId: 'w1' }, { kind: 'open' })!).params).toEqual(expect.arrayContaining(['merged', 'closed']));
    expect(render(recordPrFactSql({ workerId: 'w1' }, { kind: 'open', reopened: true })!).params).not.toContain('closed');
    expect(reopened).toContain('w.merged_at IS NULL');
  });

  test('a CI fact for an old SHA and an unscoped target build no statement', () => {
    expect(recordPrFactSql({ workerId: 'w1' }, { kind: 'ci', status: 'ci_failed', headSha: 'A', currentHeadSha: 'B' })).toBeNull();
    expect(recordPrFactSql({ workerIds: [] }, { kind: 'closed' })).toBeNull();
    expect(recordPrFactSql({ prUrl: '', prNumber: 1 }, { kind: 'closed' })).toBeNull();
    expect(render(recordPrFactSql({ workerIds: ['a', 'b'] }, { kind: 'closed' })!).sql).toContain('jsonb_array_elements_text');
  });

  test('bookkeeping is bound, and conflict is first-seen', () => {
    const { sql, params } = render(recordPrFactSql({ workerId: 'w1' }, { kind: 'conflict' }, { prLastCheckedAt: new Date('2026-10-02T00:00:00Z'), prIsDraft: true })!);
    expect(sql).toContain('conflict_detected_at = COALESCE(w.conflict_detected_at, now())');
    expect(sql).toContain('pr_last_checked_at = $');
    expect(params).toEqual(expect.arrayContaining(['2026-10-02T00:00:00.000Z', true]));
  });

  test('the pure mirror: terminal wins', () => {
    expect(prFactApplies({ kind: 'open' }, { prLifecycleStatus: 'merged', mergedAt: null })).toBe(false);
    expect(prFactApplies({ kind: 'open', reopened: true }, { prLifecycleStatus: 'closed', mergedAt: null })).toBe(true);
    expect(prFactApplies({ kind: 'ci', status: 'ci_green' }, { prLifecycleStatus: 'closed', mergedAt: null })).toBe(false);
    expect(prFactApplies({ kind: 'merged', mergedAt: '2026-10-01T00:00:00Z' }, { prLifecycleStatus: 'merged', mergedAt: '2026-10-01T00:00:00Z' })).toBe(false);
  });
});
