import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockGetUserTeamRole = mock(() => Promise.resolve('owner' as string | null));
const mockAccountsFindFirst = mock(() => null as any);
const mockUpdateSet = mock((_v: any) => ({ where: () => Promise.resolve() }));
const mockInvalidate = mock(() => {});

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  getUserTeamRole: mockGetUserTeamRole,
}));
mock.module('@/lib/api-auth', () => ({
  hashApiKey: (k: string) => `hashed_${k}`,
  extractApiKeyPrefix: (k: string) => k.substring(0, 12),
  invalidateAccountCacheByHash: mockInvalidate,
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { accounts: { findFirst: mockAccountsFindFirst } },
    update: () => ({ set: mockUpdateSet }),
  },
}));

const originalNodeEnv = process.env.NODE_ENV;

import { POST } from './route';

const ctx = { params: Promise.resolve({ id: 'acct-1' }) };
const req = () => new NextRequest('http://localhost:3000/api/accounts/acct-1/regenerate-key', { method: 'POST' });

describe('POST /api/accounts/[id]/regenerate-key — team owners and admins only', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockReset();
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockGetUserTeamRole.mockReset();
    mockAccountsFindFirst.mockReset();
    mockAccountsFindFirst.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', apiKey: 'old-hash' });
    mockUpdateSet.mockClear();
    mockInvalidate.mockClear();
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 without a session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(401);
  });

  it('refuses a team member with 403 and leaves the key unchanged', async () => {
    mockGetUserTeamRole.mockResolvedValue('member');
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("checks the caller's role on the account's own team", async () => {
    mockGetUserTeamIds.mockResolvedValue(['team-1', 'team-2']);
    mockAccountsFindFirst.mockResolvedValue({ id: 'acct-1', teamId: 'team-2', apiKey: 'old-hash' });
    mockGetUserTeamRole.mockImplementation(async (_u: string, teamId: string) =>
      teamId === 'team-2' ? 'member' : 'owner');
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
    expect(mockGetUserTeamRole).toHaveBeenCalledWith('user-1', 'team-2');
  });

  it('returns 404 for an account outside the caller\'s teams', async () => {
    mockAccountsFindFirst.mockResolvedValue(null);
    mockGetUserTeamRole.mockResolvedValue('owner');
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
  });

  it('lets a team admin regenerate and returns the new key once', async () => {
    mockGetUserTeamRole.mockResolvedValue('admin');
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.apiKey).toStartWith('bld_');
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
  });
});
