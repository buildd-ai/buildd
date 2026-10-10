import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1']));
const mockGetUserTeamRole = mock(() => Promise.resolve('owner'));
const mockAccountsFindFirst = mock(() => null as any);
const mockAccountsDelete = mock(() => ({
  where: mock(() => Promise.resolve()),
}));
const mockInvalidateAccountCacheByHash = mock(() => {});
let lastMaxConcurrentWorkers = 10;
const mockReturning = mock(() => Promise.resolve([{ id: '11111111-1111-4111-8111-111111111111', maxConcurrentWorkers: lastMaxConcurrentWorkers }]));
const mockWhere = mock(() => ({ returning: mockReturning }));
const mockUpdateSet = mock((v: any) => {
  if (v && typeof v === 'object' && 'maxConcurrentWorkers' in v) {
    lastMaxConcurrentWorkers = v.maxConcurrentWorkers;
  }
  return { where: mockWhere };
});
const mockUpdate = mock(() => ({
  set: mockUpdateSet,
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  getUserTeamRole: mockGetUserTeamRole,
}));

mock.module('@/lib/key-level-policy', () => ({
  canAdministerTeamKeys: (role: string | null) => role === 'owner' || role === 'admin',
}));

mock.module('@/lib/api-auth', () => ({
  invalidateAccountCacheByHash: mockInvalidateAccountCacheByHash,
  invalidateAccountWorkspaceCache: mock(() => {}),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: { teams: { findFirst: async () => null },
      accounts: { findFirst: mockAccountsFindFirst },
    },
    update: mockUpdate,
    delete: () => mockAccountsDelete(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({ teams: { id: 'teams.id', permissionOverrides: 'teams.permission_overrides' },
  accounts: { id: 'id', teamId: 'teamId' },
}));

const originalNodeEnv = process.env.NODE_ENV;

import { GET, DELETE, PATCH } from './route';

const mockParams = Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' });

describe('GET /api/accounts/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockGetUserTeamIds.mockReset();
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/accounts/account-1');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when account not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAccountsFindFirst.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/accounts/account-1');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Account not found');
  });

  it('returns 404 for a non-UUID id (e.g. a short 8-hex id) without querying the db', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/accounts/a1b2c3d4');
    const res = await GET(req, { params: Promise.resolve({ id: 'a1b2c3d4' }) });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('UUID');
    expect(mockAccountsFindFirst).not.toHaveBeenCalled();
  });

  it('returns account when found', async () => {
    const mockAccount = { id: '11111111-1111-4111-8111-111111111111', name: 'Test Account', type: 'user' };
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAccountsFindFirst.mockResolvedValue(mockAccount);

    const req = new NextRequest('http://localhost:3000/api/accounts/account-1');
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.account.name).toBe('Test Account');
  });
});

describe('DELETE /api/accounts/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockAccountsDelete.mockReset();
    mockGetUserTeamIds.mockReset();
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockGetUserTeamRole.mockReset();
    mockGetUserTeamRole.mockResolvedValue('owner');
    mockInvalidateAccountCacheByHash.mockClear();
    process.env.NODE_ENV = 'production';

    mockAccountsDelete.mockReturnValue({
      where: mock(() => Promise.resolve()),
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/accounts/account-1', { method: 'DELETE' });
    const res = await DELETE(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when account not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAccountsFindFirst.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/accounts/account-1', { method: 'DELETE' });
    const res = await DELETE(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('deletes account successfully', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAccountsFindFirst.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', teamId: 'team-1' });

    const req = new NextRequest('http://localhost:3000/api/accounts/account-1', { method: 'DELETE' });
    const res = await DELETE(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(mockAccountsDelete).toHaveBeenCalled();
  });

  // Deleting an API key requires manage_team_keys, like editing or regenerating it.
  for (const [role, label] of [['member', 'a plain member'], [null, 'a user with no role in the key\'s team']] as const) {
    it(`refuses ${label} with 403 and deletes nothing`, async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockGetUserTeamRole.mockResolvedValue(role as any);
      mockAccountsFindFirst.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', teamId: 'team-1', apiKey: 'bld_test123' });

      const req = new NextRequest('http://localhost:3000/api/accounts/account-1', { method: 'DELETE' });
      const res = await DELETE(req, { params: mockParams });

      expect(res.status).toBe(403);
      expect(mockAccountsDelete).not.toHaveBeenCalled();
      expect(mockInvalidateAccountCacheByHash).not.toHaveBeenCalled();
    });
  }

  for (const role of ['admin', 'owner']) {
    it(`lets a team ${role} delete the key`, async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockGetUserTeamRole.mockResolvedValue(role);
      mockAccountsFindFirst.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', teamId: 'team-1', apiKey: 'bld_test123' });

      const req = new NextRequest('http://localhost:3000/api/accounts/account-1', { method: 'DELETE' });
      const res = await DELETE(req, { params: mockParams });

      expect(res.status).toBe(200);
      expect(mockAccountsDelete).toHaveBeenCalled();
      expect(mockGetUserTeamRole).toHaveBeenCalledWith('user-1', 'team-1');
    });
  }

  // A key you minted yourself is yours to delete, whatever your role.
  it('lets a plain member delete a key they created', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamRole.mockResolvedValue('member');
    mockAccountsFindFirst.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', teamId: 'team-1', apiKey: 'bld_mine', createdByUserId: 'user-1' });

    const res = await DELETE(new NextRequest('http://localhost:3000/api/accounts/account-1', { method: 'DELETE' }), { params: mockParams });

    expect(res.status).toBe(200);
    expect(mockAccountsDelete).toHaveBeenCalled();
    expect(mockInvalidateAccountCacheByHash).toHaveBeenCalledWith('bld_mine');
  });

  for (const [createdByUserId, label] of [['user-2', "someone else's key"], [null, 'a key with no recorded creator']] as const) {
    it(`refuses a plain member deleting ${label}`, async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockGetUserTeamRole.mockResolvedValue('member');
      mockAccountsFindFirst.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', teamId: 'team-1', apiKey: 'bld_theirs', createdByUserId });

      const res = await DELETE(new NextRequest('http://localhost:3000/api/accounts/account-1', { method: 'DELETE' }), { params: mockParams });

      expect(res.status).toBe(403);
      expect(mockAccountsDelete).not.toHaveBeenCalled();
      expect(mockInvalidateAccountCacheByHash).not.toHaveBeenCalled();
    });
  }
});

describe('PATCH /api/accounts/[id] — maxConcurrentWorkers (team owners and admins only)', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockReset();
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockGetUserTeamRole.mockReset();
    mockGetUserTeamRole.mockResolvedValue('owner');
    mockAccountsFindFirst.mockReset();
    mockAccountsFindFirst.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', teamId: 'team-1', apiKey: 'bld_test123' });
    mockUpdateSet.mockClear();
    mockInvalidateAccountCacheByHash.mockClear();
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 without a session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const req = new NextRequest('http://localhost:3000/api/accounts/account-1', {
      method: 'PATCH',
      body: JSON.stringify({ maxConcurrentWorkers: 5 }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(401);
  });

  it('refuses a team member with 403', async () => {
    mockGetUserTeamRole.mockResolvedValue('member');
    const req = new NextRequest('http://localhost:3000/api/accounts/account-1', {
      method: 'PATCH',
      body: JSON.stringify({ maxConcurrentWorkers: 5 }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(403);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('returns 404 for an account outside the caller\'s teams', async () => {
    mockAccountsFindFirst.mockResolvedValue(null);
    const req = new NextRequest('http://localhost:3000/api/accounts/account-1', {
      method: 'PATCH',
      body: JSON.stringify({ maxConcurrentWorkers: 5 }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(404);
  });

  it('validates maxConcurrentWorkers is an integer between 1 and 50', async () => {
    const req = (value: any) => new NextRequest('http://localhost:3000/api/accounts/account-1', {
      method: 'PATCH',
      body: JSON.stringify({ maxConcurrentWorkers: value }),
    });

    // Too low
    let res = await PATCH(req(0), { params: mockParams });
    expect(res.status).toBe(400);

    // Too high
    res = await PATCH(req(51), { params: mockParams });
    expect(res.status).toBe(400);

    // Not an integer
    res = await PATCH(req(5.5), { params: mockParams });
    expect(res.status).toBe(400);

    // Not a number
    res = await PATCH(req('five'), { params: mockParams });
    expect(res.status).toBe(400);

    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('lets a team admin update maxConcurrentWorkers and invalidates the cache', async () => {
    mockGetUserTeamRole.mockResolvedValue('admin');
    const req = new NextRequest('http://localhost:3000/api/accounts/account-1', {
      method: 'PATCH',
      body: JSON.stringify({ maxConcurrentWorkers: 10 }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.maxConcurrentWorkers).toBe(10);
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    expect(mockInvalidateAccountCacheByHash).toHaveBeenCalledWith('bld_test123');
  });

  it('lets a team owner update maxConcurrentWorkers and invalidates the cache', async () => {
    const req = new NextRequest('http://localhost:3000/api/accounts/account-1', {
      method: 'PATCH',
      body: JSON.stringify({ maxConcurrentWorkers: 3 }),
    });
    const res = await PATCH(req, { params: mockParams });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.maxConcurrentWorkers).toBe(3);
    expect(mockInvalidateAccountCacheByHash).toHaveBeenCalledWith('bld_test123');
  });
});
