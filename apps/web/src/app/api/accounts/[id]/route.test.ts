import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1']));
const mockAccountsFindFirst = mock(() => null as any);
const mockAccountsDelete = mock(() => ({
  where: mock(() => Promise.resolve()),
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: mockAccountsFindFirst },
    },
    delete: () => mockAccountsDelete(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  accounts: { id: 'id', teamId: 'teamId' },
}));

const originalNodeEnv = process.env.NODE_ENV;

import { GET, DELETE } from './route';

const mockParams = Promise.resolve({ id: 'account-1' });

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

  it('returns account when found', async () => {
    const mockAccount = { id: 'account-1', name: 'Test Account', type: 'user' };
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
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1' });

    const req = new NextRequest('http://localhost:3000/api/accounts/account-1', { method: 'DELETE' });
    const res = await DELETE(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});
