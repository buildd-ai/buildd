import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest, NextResponse } from 'next/server';

let authorized = true;
const inserts: any[] = [];
mock.module('@/lib/platform-admin', () => ({
  authorizePlatformAdmin: async () => authorized
    ? { account: { id: 'platform-acct' } }
    : { response: NextResponse.json({ error: 'Requires a platform admin API key' }, { status: 403 }) },
}));
mock.module('@/lib/mcp-oauth', () => ({ discoverOAuthMetadata: async () => ({ authMode: 'oauth' }) }));
mock.module('@/lib/connector-icon', () => ({ resolveConnectorIcon: async () => null }));
mock.module('drizzle-orm', () => ({ isNull: (a: any) => ({ op: 'isNull', a }) }));
mock.module('@buildd/core/db/schema', () => ({ connectorCatalogEntries: { teamId: 'teamId' } }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { connectorCatalogEntries: { findMany: async ({ where }: any) => (where.op === 'isNull' ? [{ slug: 'grafana', teamId: null }] : []) } },
    insert: () => ({ values: (v: any) => { inserts.push(v); return { onConflictDoNothing: () => ({ returning: async () => [{ id: 'p1', ...v }] }) }; } }),
  },
}));

const { GET, POST } = await import('./route');
const req = (method: string, body?: unknown) => new NextRequest('http://localhost:3000/api/admin/connector-catalog', {
  method, headers: { 'content-type': 'application/json', authorization: 'Bearer bld_x' }, body: body === undefined ? undefined : JSON.stringify(body),
});

beforeEach(() => { authorized = true; inserts.length = 0; });

describe('/api/admin/connector-catalog', () => {
  it('refuses anyone but a platform admin', async () => {
    authorized = false;
    expect((await GET(req('GET'))).status).toBe(403);
    expect((await POST(req('POST', { name: 'Grafana', url: 'https://mcp.grafana.example/mcp' }))).status).toBe(403);
    expect(inserts).toHaveLength(0);
  });

  it('lists built-ins and platform rows only', async () => {
    const data = await (await GET(req('GET'))).json();
    expect(data.builtins.length).toBeGreaterThan(0);
    expect(data.entries).toEqual([{ slug: 'grafana', teamId: null }]);
  });

  it('creates a platform-wide entry (team_id NULL)', async () => {
    const res = await POST(req('POST', { name: 'Grafana', url: 'https://mcp.grafana.example/mcp', category: 'observability' }));
    expect(res.status).toBe(201);
    expect(inserts[0]).toMatchObject({ teamId: null, slug: 'grafana', category: 'observability', createdByAccountId: 'platform-acct' });
  });
});
