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
let executed: any[] = [];
let executeRows: any[] = [];
let updateError: unknown = null;

function chain(c: Captured): any {
  const p: any = {
    from: () => p, leftJoin: () => p, orderBy: () => p,
    where: (w: any) => { c.where = w; return p; },
    set: (s: any) => { c.set = s; return p; },
    values: (v: any) => { c.values = v; return p; },
    limit: () => p,
    returning: () => (c.op === 'update' && updateError ? Promise.reject(updateError) : Promise.resolve(returning)),
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
    execute: async (q: any) => { executed.push(q); return { rows: executeRows }; },
  },
}));

const store = await import('./directives-store');

const whereSql = (c: Captured) => {
  const q = dialect.sqlToQuery(c.where);
  return { sql: norm(q.sql), params: q.params };
};

beforeEach(() => { calls.length = 0; returning = []; selectRows = []; executed = []; executeRows = []; updateError = null; });

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

  it('create is one conditional insert: capped per caller, a duplicate is a no-op', async () => {
    executeRows = [{ id: 'd-9' }];
    selectRows = [[{ id: 'd-9', userId: 'u-1', text: 'Always x' }]];
    const r = await store.createDirective({ userId: 'u-1', text: 'Always x', workspaceId: null, source: 'chat' });
    expect(r).toMatchObject({ ok: true, existed: false, row: { id: 'd-9' } });
    const q = dialect.sqlToQuery(executed[0]);
    const text = norm(q.sql);
    expect(text).toContain('insert into chat_directives');
    expect(text).toContain('where (select count(*) from chat_directives where user_id = $6::uuid) < $7');
    expect(text).toContain('on conflict do nothing');
    expect(q.params).toEqual(['u-1', null, 'Always x', 'chat', null, 'u-1', 50]);
    // The row is read back for the caller only.
    expect(whereSql(calls[0]).params).toEqual(['d-9', 'u-1']);
  });

  it('nothing inserted and a copy exists: the copy wins (a double tap)', async () => {
    executeRows = [];
    selectRows = [[{ id: 'd-1', text: 'Always x' }]];
    const r = await store.createDirective({ userId: 'u-1', text: 'Always x', workspaceId: 'ws-1', source: 'chat' });
    expect(r).toMatchObject({ ok: true, existed: true, row: { id: 'd-1' } });
    const dedupe = whereSql(calls[0]);
    expect(dedupe.sql).toContain('"chat_directives"."user_id" = $1');
    expect(dedupe.sql).toContain('"chat_directives"."workspace_id" = $3');
  });

  it('nothing inserted and no copy: the cap refused it', async () => {
    executeRows = [];
    selectRows = [[]];
    expect(await store.createDirective({ userId: 'u-1', text: 'x', workspaceId: null, source: 'settings' })).toEqual({ ok: false, reason: 'limit' });
  });

  it('an edit into an existing copy is refused as a duplicate, not a 500', async () => {
    updateError = Object.assign(new Error('Failed query'), { cause: { code: '23505', constraint: 'chat_directives_user_scope_text_unique' } });
    expect(await store.updateDirective('u-1', 'd-1', { text: 'Always x' })).toBe('duplicate');
    updateError = Object.assign(new Error('boom'), { cause: { code: '57014' } });
    await expect(store.updateDirective('u-1', 'd-1', { text: 'y' })).rejects.toThrow('boom');
  });

  it('loads the card on one assistant message of that conversation', async () => {
    selectRows = [[{ parts: [{ type: 'text', text: 'ok' }, { type: 'data-buildd-directive', data: { text: 'Always x', conversationId: 'c-1' } }] }]];
    expect(await store.loadDirectiveCard('c-1', 'm-1')).toMatchObject({ text: 'Always x' });
    const w = whereSql(calls[0]);
    expect(w.params).toEqual(['m-1', 'c-1', 'assistant']);
    selectRows = [[]];
    expect(await store.loadDirectiveCard('c-1', 'm-2')).toBeNull();
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
