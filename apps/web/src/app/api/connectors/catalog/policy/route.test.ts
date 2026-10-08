import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest, NextResponse } from 'next/server';

let caller: any = { teamId: 't1', canManage: true, accountId: null };
const upserts: any[] = [];
const mockLoad = mock(async (_t: string) => [
  { slug: 'neon', name: 'Neon', url: 'https://mcp.neon.tech/mcp', authMode: 'oauth', policy: 'available', source: 'builtin', id: null },
] as any[]);
const mockPreinstall = mock(async (..._a: any[]) => ({ id: 'conn-1' }));

mock.module('@/lib/connector-team-auth', () => ({
  resolveConnectorTeam: async () => caller,
  forbidden: () => NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
}));
mock.module('@/lib/connector-catalog-store', () => ({ loadTeamCatalog: mockLoad }));
mock.module('@/lib/connector-provision', () => ({ preinstallForTeam: mockPreinstall }));
mock.module('@buildd/core/db/schema', () => ({ connectorCatalogTeamPolicies: { teamId: 'p.team_id', slug: 'p.slug' } }));
mock.module('@buildd/core/db', () => ({
  db: { insert: () => ({ values: (v: any) => ({ onConflictDoUpdate: async (c: any) => { upserts.push({ v, c }); } }) }) },
}));

const { PUT } = await import('./route');
const put = (body: unknown) => PUT(new NextRequest('http://localhost:3000/api/connectors/catalog/policy', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

beforeEach(() => { caller = { teamId: 't1', canManage: true, accountId: null }; upserts.length = 0; mockPreinstall.mockClear(); });

describe('PUT /api/connectors/catalog/policy', () => {
  it('403 for a team member without manage_connectors', async () => {
    caller = { ...caller, canManage: false };
    expect((await put({ slug: 'neon', policy: 'blocked' })).status).toBe(403);
    expect(upserts).toHaveLength(0);
  });

  it('400 for an unknown policy, 404 for an unknown slug', async () => {
    expect((await put({ slug: 'neon', policy: 'sometimes' })).status).toBe(400);
    expect((await put({ slug: 'nope', policy: 'blocked' })).status).toBe(404);
  });

  it('records blocked for the caller\'s team without provisioning', async () => {
    const res = await put({ slug: 'neon', policy: 'blocked' });
    expect(res.status).toBe(200);
    expect(mockPreinstall).not.toHaveBeenCalled();
    expect(upserts[0].v).toMatchObject({ teamId: 't1', slug: 'neon', policy: 'blocked' });
  });

  it('preinstalled provisions first, then records, and returns the connector', async () => {
    const res = await put({ slug: 'neon', policy: 'preinstalled' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: 'neon', policy: 'preinstalled', connectorId: 'conn-1' });
    expect(mockPreinstall).toHaveBeenCalledWith('t1', expect.objectContaining({ slug: 'neon' }), 'http://localhost:3000');
    expect(upserts[0].v.policy).toBe('preinstalled');
  });

  it('a provisioning failure returns 422 with the reason and leaves the policy unchanged', async () => {
    mockPreinstall.mockRejectedValueOnce(new Error('discovery 404'));
    const res = await put({ slug: 'neon', policy: 'preinstalled' });
    expect(res.status).toBe(422);
    expect((await res.json()).message).toContain('discovery 404');
    expect(upserts).toHaveLength(0);
  });
});
