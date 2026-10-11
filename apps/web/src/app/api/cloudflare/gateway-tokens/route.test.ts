import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = '11111111-1111-4111-8111-111111111111';
const mockGetUserTeamIds = mock(async () => [TEAM] as string[]);
let roles: Record<string, string> = {};
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamMembers: { findMany: async () => Object.entries(roles).map(([teamId, role]) => ({ teamId, role })) },
      teams: { findFirst: async () => ({ id: 'not-a-personal-team', permissionOverrides: null }) },
    },
  },
}));
mock.module('@/lib/auth-helpers', () => ({ requireSessionUser: async () => ({ user: { id: 'u-1', email: 'person@example.com' } }) }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockGetUserTeamIds }));
const mockCreate = mock(async (input: any) => ({ ok: true, token: { scope: input.scope, tokenHint: '…abcd' } }) as any);
const mockDelete = mock(async (_input: any) => ({ ok: true, deleted: true }) as any);
mock.module('@/lib/cloudflare-gateway-tokens', () => ({
  listGatewayTokens: async () => ({ personal: null, team: null }),
  createGatewayToken: mockCreate,
  deleteGatewayToken: mockDelete,
}));

const { GET, POST, DELETE } = await import('./route');
const url = (qs = '') => `http://localhost:3000/api/cloudflare/gateway-tokens${qs}`;
const post = (body: unknown) => new NextRequest(url(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => { roles = { [TEAM]: 'member' }; mockCreate.mockClear(); mockDelete.mockClear(); mockGetUserTeamIds.mockResolvedValue([TEAM]); });

describe('/api/cloudflare/gateway-tokens', () => {
  it('any member reads, no-store, and is told whether they may manage the team token', async () => {
    const res = await GET(new NextRequest(url(`?teamId=${TEAM}`)));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ personal: null, team: null, canManageTeam: false });
  });

  it('any member creates their own token, named for them', async () => {
    const res = await POST(post({ teamId: TEAM, scope: 'personal' }));
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith({ teamId: TEAM, userId: 'u-1', scope: 'personal', label: 'buildd: person@example.com' });
  });

  it('only an owner or admin creates or removes the team token', async () => {
    expect((await POST(post({ teamId: TEAM, scope: 'team' }))).status).toBe(403);
    expect((await DELETE(new NextRequest(url(`?teamId=${TEAM}&scope=team`), { method: 'DELETE' }))).status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
    roles = { [TEAM]: 'admin' };
    expect((await POST(post({ teamId: TEAM, scope: 'team' }))).status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ scope: 'team', label: 'buildd: agents' }));
  });

  it('refuses another team, and an unknown scope', async () => {
    mockGetUserTeamIds.mockResolvedValue([]);
    expect((await POST(post({ teamId: TEAM, scope: 'personal' }))).status).toBe(404);
    expect((await POST(post({ teamId: TEAM, scope: 'everyone' }))).status).toBe(400);
  });
});
