import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuth = mock(() => Promise.resolve({ user: { id: 'user-1', email: 'u@example.test' } } as any));
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockGetUserDefaultTeamId = mock(() => Promise.resolve('team-1' as string | null));
const mockGetUserTeamRole = mock(() => Promise.resolve('member' as string | null));
const mockAccountsFindFirst = mock(() => null as any);
const mockUpdate = mock(() => ({ set: () => ({ where: () => ({ returning: () => [] }) }) }));
let inserted: any[] = [];

mock.module('@/auth', () => ({ auth: mockAuth }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  getUserDefaultTeamId: mockGetUserDefaultTeamId,
  getUserTeamRole: mockGetUserTeamRole,
}));
mock.module('@/lib/api-auth', () => ({
  hashApiKey: (k: string) => `hashed_${k}`,
  extractApiKeyPrefix: (k: string) => k.substring(0, 12),
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { accounts: { findFirst: mockAccountsFindFirst } },
    insert: () => ({
      values: (vals: any) => {
        inserted.push(vals);
        return { returning: () => [{ id: 'acct-new', ...vals }] };
      },
    }),
    update: mockUpdate,
  },
}));

import { GET } from './route';

function cliReq(params: Record<string, string>) {
  const qs = new URLSearchParams({ callback: 'http://localhost:9876/callback', ...params });
  return new NextRequest(`http://localhost:3000/api/auth/cli?${qs.toString()}`);
}

function redirectParams(res: Response): URLSearchParams {
  return new URL(res.headers.get('location')!).searchParams;
}

describe("GET /api/auth/cli — key level follows the signed-in user's team role", () => {
  beforeEach(() => {
    inserted = [];
    mockAuth.mockReset();
    mockAuth.mockResolvedValue({ user: { id: 'user-1', email: 'u@example.test' } });
    mockGetUserTeamIds.mockReset();
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockGetUserDefaultTeamId.mockReset();
    mockGetUserDefaultTeamId.mockResolvedValue('team-1');
    mockGetUserTeamRole.mockReset();
    mockAccountsFindFirst.mockReset();
    mockAccountsFindFirst.mockResolvedValue(null);
    mockUpdate.mockClear();
  });

  it('caps a team member at worker level even when admin is requested', async () => {
    mockGetUserTeamRole.mockResolvedValue('member');
    const res = await GET(cliReq({ client: 'cli', level: 'admin' }));
    expect(redirectParams(res).get('token')).toStartWith('bld_');
    expect(inserted).toHaveLength(1);
    expect(inserted[0].level).toBe('worker');
    expect(redirectParams(res).get('level')).toBe('worker');
  });

  it('caps the admin-by-default CLI client for a member', async () => {
    mockGetUserTeamRole.mockResolvedValue('member');
    await GET(cliReq({ client: 'mcp' }));
    expect(inserted[0].level).toBe('worker');
  });

  it('keeps admin level for a team owner', async () => {
    mockGetUserTeamRole.mockResolvedValue('owner');
    await GET(cliReq({ client: 'cli' }));
    expect(inserted[0].level).toBe('admin');
  });

  it('ignores an unknown level and uses the client default', async () => {
    mockGetUserTeamRole.mockResolvedValue('owner');
    await GET(cliReq({ client: 'runner', level: 'superuser' }));
    expect(inserted[0].level).toBe('worker');
  });

  it('creates a new key rather than rotating an existing account with the same name', async () => {
    mockGetUserTeamRole.mockResolvedValue('owner');
    mockAccountsFindFirst.mockResolvedValue({ id: 'acct-existing', name: 'CLI', teamId: 'team-1', level: 'admin' });
    const res = await GET(cliReq({ client: 'cli' }));
    expect(redirectParams(res).get('token')).toStartWith('bld_');
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
  });

  it('refuses when the user has no role on the target team', async () => {
    mockGetUserTeamRole.mockResolvedValue(null);
    const res = await GET(cliReq({ client: 'cli' }));
    expect(redirectParams(res).get('error')).toBeTruthy();
    expect(redirectParams(res).get('token')).toBeNull();
    expect(inserted).toHaveLength(0);
  });
});
