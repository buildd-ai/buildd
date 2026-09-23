import { describe, it, expect, beforeEach, afterAll, mock, type Mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1']));
const mockGetUserDefaultTeamId = mock(() => Promise.resolve('team-1'));
const mockGetUserTeamRole = mock(() => Promise.resolve('owner' as string | null));
const mockAccountsFindMany = mock(() => [] as any[]);
const mockAccountsInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() => [{ id: 'account-new', name: 'New Account', apiKey: 'hashed' }]),
  })),
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  getUserDefaultTeamId: mockGetUserDefaultTeamId,
  getUserTeamRole: mockGetUserTeamRole,
}));

mock.module('@/lib/api-auth', () => ({
  hashApiKey: (key: string) => `hashed_${key}`,
  extractApiKeyPrefix: (key: string) => key.substring(0, 12),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findMany: mockAccountsFindMany },
    },
    insert: () => mockAccountsInsert(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  desc: (field: any) => ({ field, type: 'desc' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  accounts: { teamId: 'teamId', createdAt: 'createdAt' },
  accountWorkspaces: {},
}));

const mockSetOAuthToken = mock(() => Promise.resolve());
mock.module('@buildd/core/secrets', () => ({
  setOAuthToken: mockSetOAuthToken,
}));

const originalNodeEnv = process.env.NODE_ENV;

import { GET, POST } from './route';

describe('GET /api/accounts', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindMany.mockReset();
    mockGetUserTeamIds.mockReset();
    mockGetUserDefaultTeamId.mockReset();
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockGetUserDefaultTeamId.mockResolvedValue('team-1');
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/accounts');
    const res = await GET();

    expect(res.status).toBe(401);
  });

  it('returns accounts for authenticated user', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAccountsFindMany.mockResolvedValue([
      { id: 'acc-1', name: 'My Runner', type: 'user' },
      { id: 'acc-2', name: 'Service', type: 'service' },
    ]);

    const res = await GET();

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.accounts).toHaveLength(2);
  });
});

describe('POST /api/accounts', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsInsert.mockReset();
    mockGetUserTeamIds.mockReset();
    mockGetUserDefaultTeamId.mockReset();
    mockSetOAuthToken.mockReset();
    mockGetUserTeamRole.mockReset();
    mockGetUserTeamRole.mockResolvedValue('owner');
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockGetUserDefaultTeamId.mockResolvedValue('team-1');
    process.env.NODE_ENV = 'production';

    mockAccountsInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(() => [{ id: 'account-new', name: 'New Account', apiKey: 'hashed' }]),
      })),
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const req = new NextRequest('http://localhost:3000/api/accounts', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Test', type: 'user' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(401);
  });

  it('returns 400 when name or type missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/accounts', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Test' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Name and type are required');
  });

  it('creates account and returns plaintext key', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    const req = new NextRequest('http://localhost:3000/api/accounts', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'My Runner', type: 'user' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    // Should return plaintext key (starts with bld_)
    expect(data.apiKey).toBeDefined();
  });

  it('does not write oauthToken to accounts table or secrets when provided', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });

    let capturedValues: any;
    mockAccountsInsert.mockReturnValue({
      values: mock((vals: any) => {
        capturedValues = vals;
        return {
          returning: mock(() => [{ id: 'account-new', name: 'OAuth Account', apiKey: 'hashed' }]),
        };
      }),
    });

    const req = new NextRequest('http://localhost:3000/api/accounts', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'OAuth Account', type: 'user', authType: 'oauth', oauthToken: 'secret-token' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    // oauthToken must not be written to the accounts column
    expect(capturedValues?.oauthToken).toBeUndefined();
    // setOAuthToken must not be called — credentials belong in Agent Backends, not here
    expect((mockSetOAuthToken as Mock<any>).mock.calls.length).toBe(0);
  });
});

describe("POST /api/accounts — key level is capped by the creator's team role", () => {
  let capturedValues: any;

  function createReq(body: Record<string, unknown>) {
    return new NextRequest('http://localhost:3000/api/accounts', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Key', type: 'service', authType: 'api', ...body }),
    });
  }

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    capturedValues = undefined;
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockReset();
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockGetUserDefaultTeamId.mockReset();
    mockGetUserDefaultTeamId.mockResolvedValue('team-1');
    mockGetUserTeamRole.mockReset();
    mockAccountsInsert.mockReset();
    mockAccountsInsert.mockReturnValue({
      values: mock((vals: any) => {
        capturedValues = vals;
        return { returning: mock(() => [{ id: 'account-new', name: 'Key', apiKey: 'hashed' }]) };
      }),
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('refuses an admin-level key for a team member with 403 and creates nothing', async () => {
    mockGetUserTeamRole.mockResolvedValue('member');
    const res = await POST(createReq({ level: 'admin' }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain('worker');
    expect(capturedValues).toBeUndefined();
  });

  it('lets a team member create a worker-level key', async () => {
    mockGetUserTeamRole.mockResolvedValue('member');
    const res = await POST(createReq({ level: 'worker' }));
    expect(res.status).toBe(200);
    expect(capturedValues.level).toBe('worker');
  });

  it('lets a team admin create an admin-level key', async () => {
    mockGetUserTeamRole.mockResolvedValue('admin');
    const res = await POST(createReq({ level: 'admin' }));
    expect(res.status).toBe(200);
    expect(capturedValues.level).toBe('admin');
  });

  it('defaults to worker level when none is requested', async () => {
    mockGetUserTeamRole.mockResolvedValue('member');
    const res = await POST(createReq({}));
    expect(res.status).toBe(200);
    expect(capturedValues.level).toBe('worker');
  });

  it('rejects an unknown level with 400', async () => {
    mockGetUserTeamRole.mockResolvedValue('owner');
    const res = await POST(createReq({ level: 'superuser' }));
    expect(res.status).toBe(400);
    expect(capturedValues).toBeUndefined();
  });

  it('checks the role on the team the key is created in', async () => {
    mockGetUserTeamIds.mockResolvedValue(['team-1', 'team-2']);
    mockGetUserTeamRole.mockImplementation(async (_u: string, teamId: string) =>
      teamId === 'team-2' ? 'member' : 'owner');
    const res = await POST(createReq({ level: 'admin', teamId: 'team-2' }));
    expect(res.status).toBe(403);
    expect(mockGetUserTeamRole).toHaveBeenCalledWith('user-1', 'team-2');
  });
});
