import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest, NextResponse } from 'next/server';

let caller: any = { teamId: 't1', canManage: true, accountId: null };
const rows = [
  { id: '11111111-1111-4111-8111-111111111111', teamId: 't1', slug: 'mine', url: 'https://mcp.mine.example/mcp', authMode: 'oauth', iconUrl: null },
  { id: '22222222-2222-4222-8222-222222222222', teamId: 't2', slug: 'theirs', url: 'https://mcp.t2.example/mcp', authMode: 'oauth', iconUrl: null },
  { id: '33333333-3333-4333-8333-333333333333', teamId: null, slug: 'platform', url: 'https://mcp.p.example/mcp', authMode: 'oauth', iconUrl: null },
];
// Evaluate the route's WHERE against the rows, so scoping is observable.
const matches = (w: any, r: any): boolean =>
  w.op === 'and' ? w.args.every((x: any) => matches(x, r)) : w.op === 'eq' ? r[w.a] === w.b : false;
const updates: any[] = [];
const deletes: any[] = [];

mock.module('@/lib/connector-team-auth', () => ({
  resolveConnectorTeam: async () => caller,
  forbidden: () => NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
}));
mock.module('@/lib/mcp-oauth', () => ({ discoverOAuthMetadata: async () => ({ authMode: 'oauth' }) }));
mock.module('@/lib/connector-icon', () => ({ resolveConnectorIcon: async () => 'https://icon/new.png', resolveConnectorIconData: async () => null }));
mock.module('drizzle-orm', () => ({ eq: (a: any, b: any) => ({ op: 'eq', a, b }), and: (...args: any[]) => ({ op: 'and', args }) }));
mock.module('@buildd/core/db/schema', () => ({ connectorCatalogEntries: { id: 'id', teamId: 'teamId' } }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { connectorCatalogEntries: { findFirst: async ({ where }: any) => rows.find(r => matches(where, r)) ?? null } },
    update: () => ({ set: (s: any) => ({ where: (w: any) => ({ returning: async () => { const r = rows.filter(x => matches(w, x)); updates.push({ s, r }); return r.map(x => ({ ...x, ...s })); } }) }) }),
    delete: () => ({ where: (w: any) => ({ returning: async () => { const r = rows.filter(x => matches(w, x)); deletes.push(...r); return r.map(x => ({ id: x.id })); } }) }),
  },
}));

const { PATCH, DELETE } = await import('./route');
const call = (fn: any, id: string, body?: unknown) => fn(
  new NextRequest(`http://localhost:3000/api/connectors/catalog/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);

beforeEach(() => { caller = { teamId: 't1', canManage: true, accountId: null }; updates.length = 0; deletes.length = 0; });

describe('PATCH /api/connectors/catalog/[id]', () => {
  it('updates the team\'s own entry; slug is immutable', async () => {
    const res = await call(PATCH, rows[0].id, { description: 'Ours', slug: 'renamed', enabled: false });
    expect(res.status).toBe(200);
    expect(updates[0].s).toMatchObject({ description: 'Ours', enabled: false });
    expect(updates[0].s.slug).toBeUndefined();
  });

  it('404 for another team\'s entry and for a platform entry', async () => {
    expect((await call(PATCH, rows[1].id, { description: 'x' })).status).toBe(404);
    expect((await call(PATCH, rows[2].id, { description: 'x' })).status).toBe(404);
    expect(updates).toHaveLength(0);
  });

  it('re-verifies and refreshes the icon when the url changes', async () => {
    const res = await call(PATCH, rows[0].id, { url: 'https://mcp.moved.example/mcp' });
    expect(res.status).toBe(200);
    expect(updates[0].s).toMatchObject({ url: 'https://mcp.moved.example/mcp', authMode: 'oauth', iconUrl: 'https://icon/new.png' });
  });

  it('403 for members, 404 for a non-uuid id', async () => {
    expect((await call(PATCH, 'not-a-uuid', {})).status).toBe(404);
    caller = { ...caller, canManage: false };
    expect((await call(PATCH, rows[0].id, { description: 'x' })).status).toBe(403);
  });
});

describe('DELETE /api/connectors/catalog/[id]', () => {
  it('deletes only the team\'s own entry', async () => {
    expect((await call(DELETE, rows[1].id)).status).toBe(404);
    expect((await call(DELETE, rows[2].id)).status).toBe(404);
    expect((await call(DELETE, rows[0].id)).status).toBe(200);
    expect(deletes.map(d => d.slug)).toEqual(['mine']);
  });
});
