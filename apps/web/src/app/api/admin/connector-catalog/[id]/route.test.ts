import { describe, it, expect, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const rows = [
  { id: '33333333-3333-4333-8333-333333333333', teamId: null, slug: 'grafana', url: 'https://mcp.g.example/mcp', authMode: 'oauth', iconUrl: null },
  { id: '11111111-1111-4111-8111-111111111111', teamId: 't1', slug: 'mine', url: 'https://mcp.m.example/mcp', authMode: 'oauth', iconUrl: null },
];
const matches = (w: any, r: any): boolean =>
  w.op === 'and' ? w.args.every((x: any) => matches(x, r)) : w.op === 'eq' ? r[w.a] === w.b : w.op === 'isNull' ? r[w.a] === null : false;

mock.module('@/lib/platform-admin', () => ({ authorizePlatformAdmin: async () => ({ account: { id: 'platform-acct' } }) }));
mock.module('@/lib/mcp-oauth', () => ({ discoverOAuthMetadata: async () => ({ authMode: 'oauth' }) }));
mock.module('@/lib/connector-icon', () => ({ resolveConnectorIcon: async () => null }));
mock.module('drizzle-orm', () => ({ eq: (a: any, b: any) => ({ op: 'eq', a, b }), and: (...args: any[]) => ({ op: 'and', args }), isNull: (a: any) => ({ op: 'isNull', a }) }));
mock.module('@buildd/core/db/schema', () => ({ connectorCatalogEntries: { id: 'id', teamId: 'teamId' } }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { connectorCatalogEntries: { findFirst: async ({ where }: any) => rows.find(r => matches(where, r)) ?? null } },
    update: () => ({ set: (s: any) => ({ where: (w: any) => ({ returning: async () => rows.filter(x => matches(w, x)).map(x => ({ ...x, ...s })) }) }) }),
    delete: () => ({ where: (w: any) => ({ returning: async () => rows.filter(x => matches(w, x)).map(x => ({ id: x.id })) }) }),
  },
}));

const { PATCH, DELETE } = await import('./route');
const call = (fn: any, id: string, body?: unknown) => fn(
  new NextRequest(`http://localhost:3000/api/admin/connector-catalog/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);

describe('/api/admin/connector-catalog/[id]', () => {
  it('disables a platform entry for everyone', async () => {
    const res = await call(PATCH, rows[0].id, { enabled: false });
    expect(res.status).toBe(200);
    expect((await res.json()).entry.enabled).toBe(false);
  });

  it('never touches a team-private entry', async () => {
    expect((await call(PATCH, rows[1].id, { enabled: false })).status).toBe(404);
    expect((await call(DELETE, rows[1].id)).status).toBe(404);
  });
});
