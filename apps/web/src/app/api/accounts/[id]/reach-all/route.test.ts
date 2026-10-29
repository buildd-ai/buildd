import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => Promise.resolve(null as any));
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1']));
const mockGetUserTeamRole = mock(() => Promise.resolve('owner' as any));
const mockAccountsFindFirst = mock(() => Promise.resolve(null as any));
const mockUpdateSet = mock((_v: Record<string, unknown>) => ({ where: () => Promise.resolve() }));
const mockInvalidate = mock((_hash: string) => {});

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  getUserTeamRole: mockGetUserTeamRole,
}));
mock.module('@/lib/api-auth', () => ({ invalidateAccountCacheByHash: mockInvalidate }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { teams: { findFirst: async () => null }, accounts: { findFirst: mockAccountsFindFirst } },
    update: () => ({ set: mockUpdateSet }),
  },
}));
mock.module('@buildd/core/db/schema', () => ({ teams: { id: 'teams.id' }, accounts: { id: 'id', teamId: 'teamId' } }));
mock.module('drizzle-orm', () => ({
  eq: (f: unknown, v: unknown) => ({ f, v }),
  and: (...a: unknown[]) => ({ a }),
  inArray: (f: unknown, v: unknown) => ({ f, v }),
}));

import { PUT } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const params = Promise.resolve({ id: ID });

function req(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/accounts/${ID}/reach-all`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PUT /api/accounts/[id]/reach-all', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserTeamRole.mockReset();
    mockAccountsFindFirst.mockReset();
    mockUpdateSet.mockClear();
    mockInvalidate.mockClear();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamRole.mockResolvedValue('owner');
    mockAccountsFindFirst.mockResolvedValue({ id: ID, teamId: 'team-1', apiKey: 'hash-1', createdByUserId: 'user-1' });
  });

  it('lets an owner turn it on, clears the key list and drops it from the auth cache', async () => {
    const res = await PUT(req({ reachAll: true }), { params });
    expect(res.status).toBe(200);
    expect(mockUpdateSet).toHaveBeenCalledWith({ reachAllWorkspaces: true, workspaceIds: null });
    expect(mockInvalidate).toHaveBeenCalledWith('hash-1');
  });

  it('turns it off without touching the list', async () => {
    expect((await PUT(req({ reachAll: false }), { params })).status).toBe(200);
    expect(mockUpdateSet).toHaveBeenCalledWith({ reachAllWorkspaces: false });
  });

  it('refuses a key with no recorded creator', async () => {
    mockAccountsFindFirst.mockResolvedValue({ id: ID, teamId: 'team-1', apiKey: 'hash-1', createdByUserId: null });
    expect((await PUT(req({ reachAll: true }), { params })).status).toBe(409);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('refuses a team member who is not an owner or admin', async () => {
    mockGetUserTeamRole.mockResolvedValue('member');
    const res = await PUT(req({ reachAll: true }), { params });
    expect(res.status).toBe(403);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('requires a signed-in user (no API keys)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await PUT(req({ reachAll: true }), { params })).status).toBe(401);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("answers 404 for another team's account", async () => {
    mockAccountsFindFirst.mockResolvedValue(null);
    expect((await PUT(req({ reachAll: true }), { params })).status).toBe(404);
  });

  it('requires a boolean', async () => {
    expect((await PUT(req({ reachAll: 'yes' }), { params })).status).toBe(400);
  });
});
