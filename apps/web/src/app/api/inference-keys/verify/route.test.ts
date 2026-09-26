import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockRequireSessionUser = mock(async () => ({ user: { id: 'u-1' } }) as any);
const mockGetUserAdminTeamIds = mock(async () => [] as string[]);
const mockReverify = mock(async (_input: any) => ({ id: 's-1', last4: 'abcd', health: 'healthy' }) as any);

mock.module('@/lib/auth-helpers', () => ({ requireSessionUser: mockRequireSessionUser }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async () => ['t-1'],
  getUserAdminTeamIds: mockGetUserAdminTeamIds,
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
  mockGetUserAdminTeamIds.mockResolvedValue([]);
});

describe('POST /api/inference-keys/verify', () => {
  it('re-checks the caller\'s own key', async () => {
    const res = await post({ teamId: 't-1', provider: 'openai', scope: 'user' });
    expect(res.status).toBe(200);
    expect(mockReverify).toHaveBeenCalledWith({ teamId: 't-1', userId: 'u-1', provider: 'openai', scope: 'user' });
  });

  it('team scope needs an admin', async () => {
    expect((await post({ teamId: 't-1', provider: 'openai', scope: 'team' })).status).toBe(403);
    mockGetUserAdminTeamIds.mockResolvedValue(['t-1']);
    expect((await post({ teamId: 't-1', provider: 'openai', scope: 'team' })).status).toBe(200);
  });

  it('404s when nothing is stored, and a team the caller is not in', async () => {
    mockReverify.mockResolvedValueOnce(null);
    expect((await post({ teamId: 't-1', provider: 'openai', scope: 'user' })).status).toBe(404);
    expect((await post({ teamId: 't-x', provider: 'openai', scope: 'user' })).status).toBe(404);
  });

  it('rejects an unknown provider', async () => {
    expect((await post({ teamId: 't-1', provider: 'nope', scope: 'user' })).status).toBe(400);
  });
});
