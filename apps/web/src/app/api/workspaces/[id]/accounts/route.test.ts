/**
 * /api/workspaces/[id]/accounts — who may read and change a workspace's
 * account connections.
 *
 * Auth runs through the REAL getCurrentUser (only next-auth `auth()` and the DB
 * are stubbed), so these tests pin what the helper accepts, not what a mock of
 * it returns: a next-auth session whose user row exists, nothing else. An
 * `Authorization: Bearer bld_…` header is never consulted.
 */
import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const saved = {
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL,
  DEV_USER_EMAIL: process.env.DEV_USER_EMAIL,
};

const USERS = [
  { id: 'user-a', email: 'a@example.test', name: 'A', image: null, timezone: null },
  { id: 'user-b', email: 'b@example.test', name: 'B', image: null, timezone: null },
];

const mockAuth = mock(async () => null as any);
const mockAuthenticateApiKey = mock(async () => ({ id: 'acct-key', name: 'k', teamId: 't', level: 'admin' }) as any);
const mockUsersFindFirst = mock(async ({ where }: any) => USERS.find((u) => (u as any)[where.field] === where.value) ?? null);
const mockVerifyWorkspaceAccess = mock(async (userId: string, wsId: string) =>
  userId === 'user-a' && wsId === 'ws-a' ? ({ teamId: 'team-a' } as any) : null,
);
const mockConnectionsFindMany = mock(async () => [
  { accountId: 'acct-1', canClaim: true, canCreate: false, account: { name: 'Runner', type: 'user' } },
]);
const mockWorkspacesFindFirst = mock(async () => ({ id: 'ws-a' }) as any);
const mockAccountsFindFirst = mock(async () => ({ id: 'acct-1' }) as any);
const mockConnectionFindFirst = mock(async () => null as any);
const mockInsert = mock(() => ({ values: async () => undefined }));
const mockUpdate = mock(() => ({ set: () => ({ where: async () => undefined }) }));
const mockDelete = mock(() => ({ where: async () => undefined }));
const mockInvalidate = mock(() => {});

mock.module('@/auth', () => ({ auth: mockAuth }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: mockVerifyWorkspaceAccess }));
mock.module('@/lib/account-workspace-cache', () => ({ invalidateAccountWorkspaceCache: mockInvalidate }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      users: { findFirst: mockUsersFindFirst },
      accountWorkspaces: { findMany: mockConnectionsFindMany, findFirst: mockConnectionFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      accounts: { findFirst: mockAccountsFindFirst },
    },
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
  },
}));
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
}));
mock.module('@buildd/core/db/schema', () => ({
  users: { id: 'id', email: 'email' },
  accounts: { id: 'id' },
  accountWorkspaces: { accountId: 'accountId', workspaceId: 'workspaceId' },
  workspaces: { id: 'id' },
}));

const { GET, POST, DELETE } = await import('./route');

const URL_BASE = 'http://localhost:3000/api/workspaces/ws-a/accounts';
const params = (id = 'ws-a') => ({ params: Promise.resolve({ id }) });
const get = (headers: Record<string, string> = {}) => new NextRequest(URL_BASE, { headers });
const post = () =>
  new NextRequest(URL_BASE, { method: 'POST', body: JSON.stringify({ accountId: 'acct-1' }) });
const del = () => new NextRequest(`${URL_BASE}?accountId=acct-1`, { method: 'DELETE' });

function setEnv(nodeEnv: string, opts: { db?: boolean; devUser?: string } = {}) {
  process.env.NODE_ENV = nodeEnv;
  if (opts.db) process.env.DATABASE_URL = 'postgres://example.test/db';
  else delete process.env.DATABASE_URL;
  if (opts.devUser) process.env.DEV_USER_EMAIL = opts.devUser;
  else delete process.env.DEV_USER_EMAIL;
}

function expectNoWrites() {
  expect(mockInsert).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(mockDelete).not.toHaveBeenCalled();
  expect(mockInvalidate).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const m of [
    mockAuth, mockAuthenticateApiKey, mockUsersFindFirst, mockVerifyWorkspaceAccess, mockConnectionsFindMany,
    mockWorkspacesFindFirst, mockAccountsFindFirst, mockConnectionFindFirst, mockInsert, mockUpdate, mockDelete, mockInvalidate,
  ]) m.mockClear();
  mockAuth.mockImplementation(async () => null);
  setEnv('production');
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('GET — production', () => {
  it('401 with no session', async () => {
    const res = await GET(get(), params());
    expect(res.status).toBe(401);
    expect(mockConnectionsFindMany).not.toHaveBeenCalled();
  });

  it('401 for an API key with no session — bearer credentials are not accepted here', async () => {
    const res = await GET(get({ authorization: 'Bearer bld_example' }), params());
    expect(res.status).toBe(401);
    expect(mockAuthenticateApiKey).not.toHaveBeenCalled();
  });

  it('401 for a session whose user no longer exists', async () => {
    mockAuth.mockImplementation(async () => ({ user: { id: 'user-gone' } }));
    const res = await GET(get(), params());
    expect(res.status).toBe(401);
  });

  it("a session for user A reads A's workspace, access-checked as A", async () => {
    mockAuth.mockImplementation(async () => ({ user: { id: 'user-a' } }));
    const res = await GET(get(), params());
    expect(res.status).toBe(200);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith('user-a', 'ws-a');
    expect((await res.json()).accounts).toEqual([
      { accountId: 'acct-1', accountName: 'Runner', accountType: 'user', canClaim: true, canCreate: false },
    ]);
  });

  it("a session for user B gets 404 on A's workspace", async () => {
    mockAuth.mockImplementation(async () => ({ user: { id: 'user-b' } }));
    const res = await GET(get(), params());
    expect(res.status).toBe(404);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith('user-b', 'ws-a');
    expect(mockConnectionsFindMany).not.toHaveBeenCalled();
  });
});

describe('GET — development', () => {
  it('keeps the placeholder without a DATABASE_URL', async () => {
    setEnv('development', { devUser: 'a@example.test' });
    const res = await GET(get(), params());
    expect(await res.json()).toEqual({ accounts: [] });
    expect(mockUsersFindFirst).not.toHaveBeenCalled();
  });

  it('keeps the placeholder without a DEV_USER_EMAIL', async () => {
    setEnv('development', { db: true });
    const res = await GET(get(), params());
    expect(await res.json()).toEqual({ accounts: [] });
    expect(mockConnectionsFindMany).not.toHaveBeenCalled();
  });

  it('serves real data as DEV_USER_EMAIL, scoped to that user, without writing', async () => {
    setEnv('development', { db: true, devUser: 'a@example.test' });
    const res = await GET(get(), params());
    expect(res.status).toBe(200);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith('user-a', 'ws-a');
    expect((await res.json()).accounts).toHaveLength(1);
    expectNoWrites();
  });

  it('DEV_USER_EMAIL for user B still cannot read A\'s workspace', async () => {
    setEnv('development', { db: true, devUser: 'b@example.test' });
    const res = await GET(get(), params());
    expect(res.status).toBe(404);
  });
});

describe('POST / DELETE', () => {
  it('production: 401 with no session, including for an API key', async () => {
    expect((await POST(post(), params())).status).toBe(401);
    const withKey = new NextRequest(URL_BASE, {
      method: 'DELETE',
      headers: { authorization: 'Bearer bld_example' },
    });
    expect((await DELETE(withKey, params())).status).toBe(401);
    expect(mockAuthenticateApiKey).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("production: user B cannot change A's workspace", async () => {
    mockAuth.mockImplementation(async () => ({ user: { id: 'user-b' } }));
    expect((await POST(post(), params())).status).toBe(404);
    expect((await DELETE(del(), params())).status).toBe(404);
    expectNoWrites();
  });

  it('production: user A connects and disconnects', async () => {
    mockAuth.mockImplementation(async () => ({ user: { id: 'user-a' } }));
    expect((await POST(post(), params())).status).toBe(200);
    expect(mockInsert).toHaveBeenCalled();
    expect((await DELETE(del(), params())).status).toBe(200);
    expect(mockDelete).toHaveBeenCalled();
  });

  it('development: never writes, even with a DATABASE_URL and DEV_USER_EMAIL', async () => {
    setEnv('development', { db: true, devUser: 'a@example.test' });
    expect(await (await POST(post(), params())).json()).toEqual({ success: true });
    expect(await (await DELETE(del(), params())).json()).toEqual({ success: true });
    expectNoWrites();
    expect(mockUsersFindFirst).not.toHaveBeenCalled();
  });
});
