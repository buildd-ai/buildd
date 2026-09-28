/**
 * The store's ownership rule is its WHERE clauses, so they are rendered to SQL
 * and read, not assumed: a mocked db alone would pass with no predicate at all.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

type Captured = { op: string; where?: any; set?: any; values?: any };
const calls: Captured[] = [];
let returning: any[] = [];
let selectRows: any[][] = [];

function chain(c: Captured): any {
  const p: any = {
    from: () => p, leftJoin: () => p, orderBy: () => p,
    where: (w: any) => { c.where = w; return p; },
    set: (s: any) => { c.set = s; return p; },
    values: (v: any) => { c.values = v; return p; },
    limit: () => p,
    returning: () => Promise.resolve(returning),
    then: (res: any, rej: any) => Promise.resolve(selectRows.shift() ?? []).then(res, rej),
  };
  return p;
}

mock.module('@buildd/core/db', () => ({
  db: {
    select: () => { const c = { op: 'select' }; calls.push(c); return chain(c); },
    update: () => { const c = { op: 'update' }; calls.push(c); return chain(c); },
    delete: () => { const c = { op: 'delete' }; calls.push(c); return chain(c); },
    insert: () => { const c = { op: 'insert' }; calls.push(c); return chain(c); },
  },
}));

const store = await import('./directives-store');

const whereSql = (c: Captured) => {
  const q = dialect.sqlToQuery(c.where);
  return { sql: norm(q.sql), params: q.params };
};

beforeEach(() => { calls.length = 0; returning = []; selectRows = []; });

describe('directives store: every query is keyed by the caller', () => {
  it('list and turn load filter by user id', async () => {
    await store.listDirectives('u-1');
    await store.loadStandingRules('u-1');
    for (const c of calls) {
      const w = whereSql(c);
      expect(w.sql).toContain('"chat_directives"."user_id" = $1');
      expect(w.params).toEqual(['u-1']);
    }
  });

  it('update and delete need both the id and the caller', async () => {
    await store.updateDirective('u-1', 'd-1', { text: 'x' });
    await store.deleteDirective('u-1', 'd-1');
    for (const c of calls) {
      const w = whereSql(c);
      expect(w.sql).toContain('"chat_directives"."id" = $1');
      expect(w.sql).toContain('"chat_directives"."user_id" = $2');
      expect(w.params).toEqual(['d-1', 'u-1']);
    }
  });

  it('create dedupes within the caller and scope, then inserts for the caller', async () => {
    selectRows = [[], [{ n: 0 }]];
    returning = [{ id: 'd-9' }];
    const r = await store.createDirective({ userId: 'u-1', text: 'Always x', workspaceId: null, source: 'chat' });
    expect(r).toMatchObject({ ok: true, existed: false });
    const dedupe = whereSql(calls[0]);
    expect(dedupe.sql).toContain('"chat_directives"."user_id" = $1');
    expect(dedupe.sql).toContain('"chat_directives"."workspace_id" is null');
    expect(whereSql(calls[1]).params).toEqual(['u-1']);
    expect(calls[2]).toMatchObject({ op: 'insert', values: { userId: 'u-1', workspaceId: null, text: 'Always x' } });
  });

  it('create refuses past the per-person cap', async () => {
    selectRows = [[], [{ n: 50 }]];
    expect(await store.createDirective({ userId: 'u-1', text: 'x', workspaceId: null, source: 'settings' })).toEqual({ ok: false, reason: 'limit' });
    expect(calls.some(c => c.op === 'insert')).toBe(false);
  });

  it('marking a card touches only that assistant message in that conversation', async () => {
    returning = [{ id: 'm-1' }];
    expect(await store.markDirectiveCard('c-1', 'm-1', { status: 'dismissed' })).toBe(true);
    const w = whereSql(calls[0]);
    expect(w.sql).toContain('"conversation_messages"."id" = $1');
    expect(w.sql).toContain('"conversation_messages"."conversation_id" = $2');
    expect(w.sql).toContain('"conversation_messages"."role" = $3');
    expect(w.params.slice(0, 3)).toEqual(['m-1', 'c-1', 'assistant']);
  });
});
