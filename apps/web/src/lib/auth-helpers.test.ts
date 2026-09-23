import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuth = mock(() => Promise.resolve(null as any));
const mockAuthenticateApiKey = mock(() => Promise.resolve(null as any));
const mockUsersFindFirst = mock(() => Promise.resolve(null as any));
const mockTeamMembersFindFirst = mock(() => Promise.resolve(null as any));

mock.module('@/auth', () => ({ auth: mockAuth }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      users: { findFirst: mockUsersFindFirst },
      teamMembers: { findFirst: mockTeamMembersFindFirst },
    },
  },
}));

const helpers: any = await import('./auth-helpers');

const keyAccount = { id: 'acct-1', name: 'CI key', teamId: 'team-1', level: 'worker' };
const reqWithKey = () =>
  new NextRequest('http://localhost:3000/api/x', { headers: { authorization: 'Bearer bld_test' } });
const reqNoAuth = () => new NextRequest('http://localhost:3000/api/x');

describe('getRequestPrincipal — an API key acts as its own account', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockAuth.mockReset();
    mockAuth.mockResolvedValue(null);
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockUsersFindFirst.mockReset();
    mockTeamMembersFindFirst.mockReset();
    mockTeamMembersFindFirst.mockResolvedValue({ user: { id: 'owner-user' } });
  });

  it('returns the key account identity and level, not a team user', async () => {
    mockAuthenticateApiKey.mockResolvedValue(keyAccount);
    const principal = await helpers.getRequestPrincipal(reqWithKey());
    expect(principal).toEqual({
      kind: 'api_key',
      account: { id: 'acct-1', name: 'CI key', teamId: 'team-1', level: 'worker' },
    });
    expect(mockTeamMembersFindFirst).not.toHaveBeenCalled();
  });

  it('returns the signed-in user for a session', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockUsersFindFirst.mockResolvedValue({ id: 'user-1', email: 'a@example.test', name: null, image: null, timezone: null });
    const principal = await helpers.getRequestPrincipal(reqNoAuth());
    expect(principal.kind).toBe('session');
    expect(principal.user.id).toBe('user-1');
  });

  it('returns null when unauthenticated', async () => {
    expect(await helpers.getRequestPrincipal(reqNoAuth())).toBeNull();
  });

  it('no longer exports a helper that maps a key to a team user', () => {
    expect(helpers.getUserFromRequest).toBeUndefined();
  });
});

describe('requireSessionUser — team administration requires a signed-in session', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockAuth.mockReset();
    mockAuth.mockResolvedValue(null);
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockUsersFindFirst.mockReset();
  });

  it('refuses an API key with 403 and a plain message, whatever its level', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ ...keyAccount, level: 'admin' });
    const result = await helpers.requireSessionUser(reqWithKey());
    expect(result.user).toBeUndefined();
    expect(result.response.status).toBe(403);
    const body = await result.response.json();
    expect(body.error).toContain('signed-in session');
  });

  it('returns 401 when unauthenticated', async () => {
    const result = await helpers.requireSessionUser(reqNoAuth());
    expect(result.response.status).toBe(401);
  });

  it('returns the user for a session', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockUsersFindFirst.mockResolvedValue({ id: 'user-1', email: 'a@example.test', name: null, image: null, timezone: null });
    const result = await helpers.requireSessionUser(reqNoAuth());
    expect(result.response).toBeUndefined();
    expect(result.user.id).toBe('user-1');
  });
});
