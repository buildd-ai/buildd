import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockRequireSessionUser = mock(async () => ({ user: { id: 'u-1' } }) as any);
// The caller's team roles and the team's permission overrides, read by the
// real permission check (lib/permissions.ts) through this db mock.
let roles: Record<string, string> = {};
let overrides: Record<string, unknown> | null = null;
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamMembers: { findMany: async () => Object.entries(roles).map(([teamId, role]) => ({ teamId, role })) },
      teams: { findFirst: async () => ({ id: 'not-a-personal-team', permissionOverrides: overrides }) },
    },
  },
}));
const mockReverify = mock(async (_input: any) => ({ id: 's-1', last4: 'abcd', health: 'healthy' }) as any);

mock.module('@/lib/auth-helpers', () => ({ requireSessionUser: mockRequireSessionUser }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async () => ['t-1'],
  resolveActiveTeamId: async () => 't-1',
}));
mock.module('@/lib/provider-keys', () => ({ reverifyProviderKey: mockReverify }));

const { POST } = await import('./route');

const post = (body: unknown) => POST(new NextRequest('http://localhost:3000/api/inference-keys/verify', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}));

beforeEach(() => {
  mockReverify.mockClear();
  roles = {}; overrides = null;
});

describe('POST /api/inference-keys/verify', () => {
  it('re-checks the caller\'s own key', async () => {
    const res = await post({ teamId: 't-1', provider: 'openai', scope: 'user' });
    expect(res.status).toBe(200);
    expect(mockReverify).toHaveBeenCalledWith({ teamId: 't-1', userId: 'u-1', provider: 'openai', scope: 'user' });
  });

  it('team scope needs an admin', async () => {
    expect((await post({ teamId: 't-1', provider: 'openai', scope: 'team' })).status).toBe(403);
    roles = { ['t-1']: 'admin' };
    expect((await post({ teamId: 't-1', provider: 'openai', scope: 'team' })).status).toBe(200);
  });

  it('404s when nothing is stored, and a team the caller is not in', async () => {
    mockReverify.mockResolvedValueOnce(null);
    expect((await post({ teamId: 't-1', provider: 'openai', scope: 'user' })).status).toBe(404);
    expect((await post({ teamId: 't-x', provider: 'openai', scope: 'user' })).status).toBe(404);
  });

  it('team scope follows the team permission overrides for manage_inference_providers', async () => {
    roles = { ['t-1']: 'admin' };
    overrides = { manage_inference_providers: ['owner'] };
    expect((await post({ teamId: 't-1', provider: 'openai', scope: 'team' })).status).toBe(403);
    expect(mockReverify).not.toHaveBeenCalled();
    roles = { ['t-1']: 'member' };
    overrides = { manage_inference_providers: ['owner', 'admin', 'member'] };
    expect((await post({ teamId: 't-1', provider: 'openai', scope: 'team' })).status).toBe(200);
    expect(mockReverify).toHaveBeenCalledWith({ teamId: 't-1', userId: 'u-1', provider: 'openai', scope: 'team' });
  });

  it('rejects an unknown provider', async () => {
    expect((await post({ teamId: 't-1', provider: 'nope', scope: 'user' })).status).toBe(400);
  });
});
