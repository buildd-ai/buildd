/**
 * Render recordPrFactSql through PgDialect so a malformed fragment fails here.
 * The ordering rules themselves run on real Postgres in
 * apps/web/tests/db/pr-facts.test.ts (bun run test:db).
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { prFactApplies, recordPrFact, recordPrFactSql, setPrFactsRecordedHook, unscopedPrFactScope, type PrFactScope } from '../pr-facts';
import { guardSql, prFactProjectionSql, prLiveProjectionSql, setSql } from '../pr-fact-sql';

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

/**
 * S4a (docs/specs/workflow-kernel-library.md §1): a terminal fact (merged, closed) carries a
 * scope, minted in the kernel, that keeps delivery-owned rows out of the funnel unless their
 * delivery already says the same thing. A non-terminal fact is scoped too (below).
 */
describe('terminal facts are scoped (S4a)', () => {
  const scope = (where: string): PrFactScope => ({ ...unscopedPrFactScope('test'), where: () => sql.raw(where) });

  test("the scope's predicate is part of both the row lock and the UPDATE's own WHERE", () => {
    const { sql: text } = render(recordPrFactSql({ workerId: 'w1' }, { kind: 'merged', mergedAt: '2026-10-01T00:00:00Z' }, {}, scope('NOT kernel_owned(w)').where('merged'))!);
    expect(text.match(/NOT kernel_owned\(w\)/g)?.length).toBe(2);
  });

  test('a terminal fact with no scope is refused before any statement runs', async () => {
    let ran = 0;
    const exec = async () => { ran++; return { rows: [] }; };
    // @ts-expect-error: the type requires a scope for merged and closed facts.
    await expect(recordPrFact({ workerId: 'w1' }, { kind: 'closed' }, { exec })).rejects.toThrow('scope');
    // @ts-expect-error: as above.
    await expect(recordPrFact({ workerId: 'w1' }, { kind: 'merged', mergedAt: new Date() }, { exec })).rejects.toThrow('scope');
    expect(ran).toBe(0);
  });

  test('an unscoped scope adds no predicate', () => {
    expect(unscopedPrFactScope('test').where('merged')).toBeNull();
  });

  test('the projection the kernel transition runs: every row of the PR, terminal-wins, the instant from SQL', () => {
    const q = prFactProjectionSql({ kind: 'merged' }, { from: sql.raw('d'), where: sql.raw('carries(d, w)'), mergedAt: sql.raw('d.merged_at') });
    const { sql: text } = render(q);
    expect(text.startsWith('UPDATE workers w SET updated_at = now(), pr_lifecycle_status = \'merged\', merged_at = COALESCE(w.merged_at, d.merged_at, now())')).toBe(true);
    expect(text).toContain("FROM d\nWHERE carries(d, w) AND (w.merged_at IS NULL OR w.pr_lifecycle_status IS DISTINCT FROM 'merged')");
    expect(text).toContain('RETURNING w.id');
    const closed = render(prFactProjectionSql({ kind: 'closed' }, { from: sql.raw('d'), where: sql.raw('carries(d, w)') })).sql;
    expect(closed).toContain("pr_lifecycle_status = 'closed'");
    expect(closed).toContain('w.merged_at IS NULL AND (w.pr_lifecycle_status IS NULL OR w.pr_lifecycle_status NOT IN (');
  });
});

/**
 * Every fact is scoped (AC-1, the non-terminal half): an open, CI, conflict or unresolvable fact
 * on a delivery-owned row is the kernel's to project (kernel.ts `w_live`). The scope's `defers`
 * predicate names those rows: the funnel reports them (so a caller's side effects still see a new
 * fact) and writes none of them.
 */
describe('non-terminal facts are scoped: a deferred row is reported, never written', () => {
  const deferring = (defers: string): PrFactScope => ({ ...unscopedPrFactScope('test'), defers: () => sql.raw(defers) });

  test('a non-terminal fact with no scope is refused before any statement runs', async () => {
    let ran = 0;
    const exec = async () => { ran++; return { rows: [] }; };
    // @ts-expect-error: every fact needs a scope.
    await expect(recordPrFact({ workerId: 'w1' }, { kind: 'ci', status: 'ci_failed' }, { exec })).rejects.toThrow('scope');
    // @ts-expect-error: as above.
    await expect(recordPrFact({ workerId: 'w1' }, { kind: 'open' })).rejects.toThrow('scope');
    expect(ran).toBe(0);
  });

  test('the deferred rows are locked and reported, and the UPDATE skips them', () => {
    const q = recordPrFactSql({ workerId: 'w1' }, { kind: 'ci', status: 'ci_failed' }, {}, null, sql.raw('kernel_owned(w)'));
    const { sql: text } = render(q!);
    expect(text).toContain('kernel_owned(w) AS deferred');
    expect(text).toMatch(/UPDATE workers w SET [\s\S]*FROM prev\n\s*WHERE w\.id = prev\.id AND NOT prev\.deferred AND /);
    expect(text).toContain('WHERE prev.deferred OR prev.id IN (SELECT id FROM upd)');
  });

  test('with nothing deferred the statement is the plain one', () => {
    const text = render(recordPrFactSql({ workerId: 'w1' }, { kind: 'ci', status: 'ci_failed' })!).sql;
    expect(text).not.toContain('deferred');
    expect(text).toContain('RETURNING w.id, w.task_id, w.workspace_id, prev.previous_status');
  });

  test('recordPrFact returns a deferred row flagged, and tells the recorded hook only what it wrote', async () => {
    let q: string | null = null;
    const exec = async (s: Parameters<PgDialect['sqlToQuery']>[0]) => {
      q = render(s).sql;
      return { rows: [
        { id: 'w1', task_id: 't1', workspace_id: 'ws', previous_status: 'ci_green', deferred: true },
        { id: 'w2', task_id: 't2', workspace_id: 'ws', previous_status: 'pr_open', deferred: false },
      ] };
    };
    const told: string[][] = [];
    setPrFactsRecordedHook((rows) => told.push(rows.map((r) => r.id)));
    try {
      const rows = await recordPrFact({ workerIds: ['w1', 'w2'] }, { kind: 'ci', status: 'ci_failed' }, { exec, scope: deferring('kernel_owned(w)') });
      expect(rows).toEqual([
        { id: 'w1', taskId: 't1', workspaceId: 'ws', previousStatus: 'ci_green', deferred: true },
        { id: 'w2', taskId: 't2', workspaceId: 'ws', previousStatus: 'pr_open', deferred: false },
      ]);
      expect(told).toEqual([['w2']]);
      expect(q).toContain('kernel_owned(w) AS deferred');
    } finally {
      setPrFactsRecordedHook(null);
    }
  });

  test('a terminal fact never defers: its scope keeps the row out instead', async () => {
    let q = '';
    const exec = async (s: Parameters<PgDialect['sqlToQuery']>[0]) => { q = render(s).sql; return { rows: [] }; };
    await recordPrFact({ workerId: 'w1' }, { kind: 'closed' }, { exec, scope: { ...deferring('kernel_owned(w)'), where: () => sql.raw('NOT agrees(w)') } });
    expect(q).toContain('NOT agrees(w)');
    expect(q).not.toContain('deferred');
  });

  test('an unscoped scope defers nothing', () => {
    expect(unscopedPrFactScope('test').defers?.('ci') ?? null).toBeNull();
  });

  test("the kernel transition's live projection: the delivery's own reading at its current head", () => {
    const { sql: text } = render(prLiveProjectionSql({ from: sql.raw('d'), where: sql.raw('carries(d, w)') }));
    expect(text).toContain("WHEN d.mergeable = 'dirty' AND d.mergeable_head_sha = d.current_head_sha THEN 'conflict'");
    expect(text).toContain("WHEN d.ci = 'red' AND d.ci_head_sha = d.current_head_sha THEN 'ci_failed'");
    expect(text).toContain("WHEN d.ci = 'green' AND d.ci_head_sha = d.current_head_sha THEN 'ci_green'");
    expect(text).toContain("ELSE 'pr_open'");
    expect(text).toContain('conflict_detected_at = CASE WHEN');
    // Terminal wins: a merged row is never moved back, and a terminal or closed delivery projects nothing here (T17 / T18 do).
    expect(text).toContain("w.merged_at IS NULL AND w.pr_lifecycle_status IS DISTINCT FROM 'merged'");
    expect(text).toContain('d.state NOT IN (');
    expect(text).toContain('w.pr_lifecycle_status IS DISTINCT FROM');
    expect(text).toContain('RETURNING w.id');
  });
});

describe('pr-fact-sql: the guard and the assignments render on their own', () => {
  test('guardSql: a merge applies unless the row already holds one; a close never over a merge', () => {
    expect(render(guardSql({ kind: 'merged', mergedAt: new Date() })).sql).toBe("(w.merged_at IS NULL OR w.pr_lifecycle_status IS DISTINCT FROM 'merged')");
    const closed = render(guardSql({ kind: 'closed' }));
    expect(closed.sql).toContain('w.merged_at IS NULL AND (w.pr_lifecycle_status IS NULL OR w.pr_lifecycle_status NOT IN ($1::text, $2::text))');
    expect(closed.params).toEqual(['merged', 'closed']);
  });

  test('setSql: the merge keeps the first instant; bookkeeping rides along', () => {
    const { sql: text, params } = render(setSql({ kind: 'merged', mergedAt: '2026-10-01T00:00:00Z' }, { prIsDraft: false }));
    expect(text).toBe("updated_at = now(), pr_lifecycle_status = 'merged', merged_at = COALESCE(w.merged_at, $1::timestamptz), pr_is_draft = $2::boolean");
    expect(params).toEqual(['2026-10-01T00:00:00.000Z', false]);
  });
});
