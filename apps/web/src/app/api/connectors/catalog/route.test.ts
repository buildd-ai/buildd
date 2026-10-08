import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest, NextResponse } from 'next/server';

let caller: any = { teamId: 't1', canManage: true, accountId: 'acct-1' };
const inserts: any[] = [];
let insertReturns: any[] | undefined;
const mockDiscover = mock(async (_u: string) => ({ authMode: 'oauth', authorizationServer: {} } as any));

mock.module('@/lib/connector-team-auth', () => ({
  resolveConnectorTeam: async () => caller,
  forbidden: () => NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
}));
mock.module('@/lib/connector-catalog-store', () => ({
  loadTeamCatalog: async () => [
    { slug: 'vercel', policy: 'available' }, { slug: 'neon', policy: 'blocked' }, { slug: 'axiom', policy: 'preinstalled' },
  ],
}));
// Real parser/verifier; only the network edges are stubbed.
mock.module('@/lib/mcp-oauth', () => ({ discoverOAuthMetadata: mockDiscover }));
mock.module('@/lib/connector-icon', () => ({ resolveConnectorIcon: async () => 'https://i/x.png' }));
mock.module('@buildd/core/db/schema', () => ({ connectorCatalogEntries: {} }));
mock.module('@buildd/core/db', () => ({
  db: { insert: () => ({ values: (v: any) => { inserts.push(v); return { onConflictDoNothing: () => ({ returning: async () => insertReturns ?? [{ id: 'e1', ...v }] }) }; } }) },
}));

const { GET, POST } = await import('./route');
const req = (method: string, body?: unknown) => new NextRequest('http://localhost:3000/api/connectors/catalog', {
  method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

beforeEach(() => { caller = { teamId: 't1', canManage: true, accountId: 'acct-1' }; inserts.length = 0; insertReturns = undefined; });

describe('GET /api/connectors/catalog', () => {
  it('admins see every entry including blocked', async () => {
    const data = await (await GET(req('GET'))).json();
    expect(data.canManage).toBe(true);
    expect(data.entries.map((e: any) => e.slug)).toEqual(['vercel', 'neon', 'axiom']);
  });

  it('members never see blocked entries', async () => {
    caller = { ...caller, canManage: false };
    const data = await (await GET(req('GET'))).json();
    expect(data.entries.map((e: any) => e.slug)).toEqual(['vercel', 'axiom']);
  });
});

describe('POST /api/connectors/catalog', () => {
  it('403 for members', async () => {
    caller = { ...caller, canManage: false };
    expect((await POST(req('POST', { name: 'X', url: 'https://mcp.x.dev' }))).status).toBe(403);
  });

  it('creates an entry scoped to the caller\'s team with the verified auth mode and icon', async () => {
    const res = await POST(req('POST', { name: 'Internal Tools', url: 'https://mcp.internal.example/mcp' }));
    expect(res.status).toBe(201);
    expect(inserts[0]).toMatchObject({ teamId: 't1', slug: 'internal-tools', authMode: 'oauth', iconUrl: 'https://i/x.png', createdByAccountId: 'acct-1' });
  });

  it('400 with a message for a non-https url', async () => {
    const res = await POST(req('POST', { name: 'X', url: 'ttps://mcp.x.dev' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_url');
  });

  it('422 when the server fails discovery, nothing written', async () => {
    mockDiscover.mockRejectedValueOnce(new Error('nope'));
    expect((await POST(req('POST', { name: 'X', url: 'https://mcp.x.dev' }))).status).toBe(422);
    expect(inserts).toHaveLength(0);
  });

  it('409 when the team already has that slug', async () => {
    insertReturns = [];
    expect((await POST(req('POST', { name: 'X', url: 'https://mcp.x.dev' }))).status).toBe(409);
  });
});
