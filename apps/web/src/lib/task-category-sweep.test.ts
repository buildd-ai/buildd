import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * The sweep: which rows it picks (the WHERE is rendered to SQL, since a mocked
 * db would hide it), how it infers a caller-set category, and its time budget.
 * `categorizeTask` is injected; nothing reaches the network.
 */

const dialect = new PgDialect();
const render = (where: any) => dialect.sqlToQuery(where);

let rows: any[] = [];
const seen: { where?: any; limit?: number } = {};
const chain: any = {
  select: () => chain, from: () => chain, innerJoin: () => chain,
  where: (w: any) => { seen.where = w; return chain; },
  orderBy: () => chain,
  limit: async (n: number) => { seen.limit = n; return rows; },
};
mock.module('@buildd/core/db', () => ({ db: chain }));

const { sweepTaskCategories } = await import('./task-category-sweep');

const row = (over: Record<string, unknown>) => ({
  id: 't', title: 'Fix crash when saving', description: 'It throws.', category: null, workspaceId: 'ws',
  accountId: null, teamId: 'team', gitConfig: null, ...over,
});

beforeEach(() => { rows = []; seen.where = undefined; });

describe('sweepTaskCategories', () => {
  it('picks rows no look has been recorded for, inside the window', async () => {
    await sweepTaskCategories({ since: new Date('2026-09-25T00:00:00Z'), categorize: async () => ({ outcome: 'kept' }) });
    const q = render(seen.where);
    expect(q.sql).toContain('"tasks"."category_decision" is null');
    expect(q.sql).toContain('"tasks"."created_at" >=');
    expect(q.sql).not.toContain('unconfigured');
  });

  it('the backfill re-asks rows skipped for want of a key, over all time', async () => {
    await sweepTaskCategories({ retryUnconfigured: true, categorize: async () => ({ outcome: 'kept' }) });
    const q = render(seen.where);
    expect(q.sql).toContain("->>'skipped' = 'unconfigured'");
    expect(q.sql).not.toContain('created_at');
  });

  it('a category the keyword rules would not give is the caller\'s; one they would give is theirs', async () => {
    rows = [
      row({ id: 'kw', category: 'bug' }),      // "Fix crash" → the rules say bug
      row({ id: 'caller', category: 'docs' }), // the rules would not say docs
      row({ id: 'blank', category: null }),
    ];
    const got: Record<string, boolean> = {};
    const counts = await sweepTaskCategories({
      categorize: async (i) => { got[i.taskId] = i.callerSet; return { outcome: 'applied' }; },
    });
    expect(got).toEqual({ kw: false, caller: true, blank: false });
    expect(counts).toMatchObject({ looked: 3, applied: 3 });
  });

  it('stops starting looks once its budget is spent', async () => {
    rows = Array.from({ length: 10 }, (_, i) => row({ id: `t${i}` }));
    const counts = await sweepTaskCategories({
      budgetMs: 30, concurrency: 1,
      categorize: async () => { await new Promise(r => setTimeout(r, 20)); return { outcome: 'kept' }; },
    });
    expect(counts.looked).toBeLessThan(10);
    expect(counts.looked).toBeGreaterThan(0);
  });
});
