import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockConsumeAuthCode = mock(() => ({ error: 'invalid_grant' }) as any);
const mockConsumeRefreshToken = mock(() => ({ error: 'invalid_grant' }) as any);
const mockCreateRefreshToken = mock(() => Promise.resolve('refresh-token'));
const mockSignAccessToken = mock(() => Promise.resolve({ token: 'access-token', expiresIn: 3600 }));
const mockUserHasWorkspaceMembership = mock(() => Promise.resolve(true));
const mockRevokeRefreshTokensForUserWorkspace = mock(() => Promise.resolve());

const mockWorkspacesFindFirst = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockUsersFindFirst = mock(() => null as any);
const mockAccountsInsert = mock(() => ({ values: mock(() => Promise.resolve()) }));

mock.module('@/lib/oauth/storage', () => ({
  consumeAuthCode: mockConsumeAuthCode,
  consumeRefreshToken: mockConsumeRefreshToken,
  createRefreshToken: mockCreateRefreshToken,
  userHasWorkspaceMembership: mockUserHasWorkspaceMembership,
  revokeRefreshTokensForUserWorkspace: mockRevokeRefreshTokensForUserWorkspace,
}));

const mockSignGrantAccessToken = mock(() => Promise.resolve({ token: 'grant-access-token', expiresIn: 3600 }));
const mockResolveGrant = mock(() => Promise.resolve(null as any));
const mockRevokeRefreshTokensForGrant = mock(() => Promise.resolve());

mock.module('@/lib/oauth/tokens', () => ({
  signAccessToken: mockSignAccessToken,
  signGrantAccessToken: mockSignGrantAccessToken,
}));

mock.module('@/lib/mcp-grants', () => ({
  resolveGrant: mockResolveGrant,
  revokeRefreshTokensForGrant: mockRevokeRefreshTokensForGrant,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      accounts: { findFirst: mockAccountsFindFirst },
      users: { findFirst: mockUsersFindFirst },
    },
    insert: (table: any) => mockAccountsInsert(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  isNull: (a: any) => ({ type: 'isNull', a }),
}));

mock.module('@buildd/core/db/schema', () => ({
  accounts: { teamId: 'teamId', type: 'type' },
  workspaces: { id: 'id', teamId: 'teamId' },
  users: { id: 'id' },
  oauthCodes: {},
  oauthRefreshTokens: {},
}));

mock.module('@/lib/api-auth', () => ({
  hashApiKey: (key: string) => `hashed_${key}`,
  extractApiKeyPrefix: (key: string) => key.substring(0, 12),
}));

import { POST } from './route';

function makeRequest(body: Record<string, string>, contentType = 'application/x-www-form-urlencoded') {
  const encoded = new URLSearchParams(body).toString();
  return new NextRequest('http://localhost/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: encoded,
  });
}

describe('POST /api/oauth/token — account auto-creation', () => {
  beforeEach(() => {
    mockConsumeAuthCode.mockReset();
    mockConsumeRefreshToken.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockAccountsFindFirst.mockReset();
    mockUsersFindFirst.mockReset();
    mockAccountsInsert.mockReset();
    mockSignAccessToken.mockReset();
    mockCreateRefreshToken.mockReset();
    mockSignAccessToken.mockResolvedValue({ token: 'access-token', expiresIn: 3600 });
    mockCreateRefreshToken.mockResolvedValue('refresh-token');
    mockAccountsInsert.mockReturnValue({ values: mock(() => Promise.resolve()) });
    mockUserHasWorkspaceMembership.mockReset();
    mockUserHasWorkspaceMembership.mockResolvedValue(true);
    mockRevokeRefreshTokensForUserWorkspace.mockReset();
    mockRevokeRefreshTokensForUserWorkspace.mockResolvedValue(undefined);
  });

  describe('authorization_code grant', () => {
    it('creates a type="user" account when none exists for the workspace team', async () => {
      mockConsumeAuthCode.mockResolvedValue({ userId: 'user-1', workspaceId: 'ws-1', scope: 'mcp' });
      mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
      mockAccountsFindFirst.mockResolvedValue(null); // no existing account
      mockUsersFindFirst.mockResolvedValue({ name: 'Alice', email: 'alice@example.com' });

      const req = makeRequest({
        grant_type: 'authorization_code',
        code: 'code-123',
        client_id: 'c_1',
        redirect_uri: 'https://example.com/callback',
        code_verifier: 'verifier',
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(mockAccountsInsert).toHaveBeenCalledTimes(1);
    });

    it('skips account creation when a type="user" account already exists', async () => {
      mockConsumeAuthCode.mockResolvedValue({ userId: 'user-1', workspaceId: 'ws-1', scope: 'mcp' });
      mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
      mockAccountsFindFirst.mockResolvedValue({ id: 'acct-1', type: 'user', teamId: 'team-1' });

      const req = makeRequest({
        grant_type: 'authorization_code',
        code: 'code-123',
        client_id: 'c_1',
        redirect_uri: 'https://example.com/callback',
        code_verifier: 'verifier',
      });

      await POST(req);
      expect(mockAccountsInsert).not.toHaveBeenCalled();
    });

    it('skips account creation when workspace is not found', async () => {
      mockConsumeAuthCode.mockResolvedValue({ userId: 'user-1', workspaceId: 'ws-missing', scope: 'mcp' });
      mockWorkspacesFindFirst.mockResolvedValue(null);

      const req = makeRequest({
        grant_type: 'authorization_code',
        code: 'code-123',
        client_id: 'c_1',
        redirect_uri: 'https://example.com/callback',
        code_verifier: 'verifier',
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(mockAccountsInsert).not.toHaveBeenCalled();
    });

    it('uses user name for the new account name', async () => {
      const insertValuesMock = mock(() => Promise.resolve());
      mockAccountsInsert.mockReturnValue({ values: insertValuesMock });

      mockConsumeAuthCode.mockResolvedValue({ userId: 'user-1', workspaceId: 'ws-1', scope: 'mcp' });
      mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
      mockAccountsFindFirst.mockResolvedValue(null);
      mockUsersFindFirst.mockResolvedValue({ name: 'Bob Smith', email: 'bob@example.com' });

      const req = makeRequest({
        grant_type: 'authorization_code',
        code: 'code-123',
        client_id: 'c_1',
        redirect_uri: 'https://example.com/callback',
        code_verifier: 'verifier',
      });

      await POST(req);
      expect(insertValuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Bob Smith's Account",
          type: 'user',
          teamId: 'team-1',
        }),
      );
    });

    it('falls back to email when user has no name', async () => {
      const insertValuesMock = mock(() => Promise.resolve());
      mockAccountsInsert.mockReturnValue({ values: insertValuesMock });

      mockConsumeAuthCode.mockResolvedValue({ userId: 'user-1', workspaceId: 'ws-1', scope: 'mcp' });
      mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
      mockAccountsFindFirst.mockResolvedValue(null);
      mockUsersFindFirst.mockResolvedValue({ name: null, email: 'noname@example.com' });

      const req = makeRequest({
        grant_type: 'authorization_code',
        code: 'code-123',
        client_id: 'c_1',
        redirect_uri: 'https://example.com/callback',
        code_verifier: 'verifier',
      });

      await POST(req);
      expect(insertValuesMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: "noname@example.com's Account" }),
      );
    });
  });

  describe('refresh_token grant', () => {
    it('creates a type="user" account when none exists', async () => {
      mockConsumeRefreshToken.mockResolvedValue({ userId: 'user-1', workspaceId: 'ws-1', scope: 'mcp' });
      mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
      mockAccountsFindFirst.mockResolvedValue(null);
      mockUsersFindFirst.mockResolvedValue({ name: 'Carol', email: 'carol@example.com' });

      const req = makeRequest({
        grant_type: 'refresh_token',
        refresh_token: 'old-refresh',
        client_id: 'c_1',
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(mockAccountsInsert).toHaveBeenCalledTimes(1);
    });
  });
});

describe('POST /api/oauth/token — team membership is re-checked', () => {
  beforeEach(() => {
    mockConsumeAuthCode.mockReset();
    mockConsumeRefreshToken.mockReset();
    mockSignAccessToken.mockReset();
    mockCreateRefreshToken.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockAccountsFindFirst.mockReset();
    mockSignAccessToken.mockResolvedValue({ token: 'access-token', expiresIn: 3600 });
    mockCreateRefreshToken.mockResolvedValue('refresh-token');
    mockUserHasWorkspaceMembership.mockReset();
    mockRevokeRefreshTokensForUserWorkspace.mockReset();
    mockRevokeRefreshTokensForUserWorkspace.mockResolvedValue(undefined);
  });

  it('refresh: a user who is no longer on the team gets invalid_grant, and their refresh tokens are revoked', async () => {
    mockConsumeRefreshToken.mockResolvedValue({ userId: 'user-1', workspaceId: 'ws-1', scope: 'mcp' });
    mockUserHasWorkspaceMembership.mockResolvedValue(false);

    const res = await POST(makeRequest({ grant_type: 'refresh_token', refresh_token: 'old', client_id: 'c_1' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
    expect(mockUserHasWorkspaceMembership).toHaveBeenCalledWith('user-1', 'ws-1');
    expect(mockRevokeRefreshTokensForUserWorkspace).toHaveBeenCalledWith('user-1', 'ws-1');
    expect(mockSignAccessToken).not.toHaveBeenCalled();
    expect(mockCreateRefreshToken).not.toHaveBeenCalled();
  });

  it('refresh: a current member still gets a new token pair', async () => {
    mockConsumeRefreshToken.mockResolvedValue({ userId: 'user-1', workspaceId: 'ws-1', scope: 'mcp' });
    mockUserHasWorkspaceMembership.mockResolvedValue(true);

    const res = await POST(makeRequest({ grant_type: 'refresh_token', refresh_token: 'old', client_id: 'c_1' }));
    expect(res.status).toBe(200);
    expect(mockRevokeRefreshTokensForUserWorkspace).not.toHaveBeenCalled();
  });

  it('authorization_code: a user who is no longer on the team gets invalid_grant', async () => {
    mockConsumeAuthCode.mockResolvedValue({ userId: 'user-1', workspaceId: 'ws-1', scope: 'mcp' });
    mockUserHasWorkspaceMembership.mockResolvedValue(false);

    const res = await POST(makeRequest({
      grant_type: 'authorization_code', code: 'c', client_id: 'c_1',
      redirect_uri: 'https://example.com/callback', code_verifier: 'v',
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
    expect(mockSignAccessToken).not.toHaveBeenCalled();
  });
});

// Restore module mocks so they don't leak into other test files in the same run.
afterAll(() => mock.restore());

describe('POST /api/oauth/token — grant-bound refresh', () => {
  const GRANT = '11111111-2222-4333-8444-555555555555';
  beforeEach(() => {
    mockConsumeRefreshToken.mockReset();
    mockResolveGrant.mockReset();
    mockRevokeRefreshTokensForGrant.mockReset();
    mockRevokeRefreshTokensForGrant.mockResolvedValue(undefined);
    mockCreateRefreshToken.mockReset();
    mockCreateRefreshToken.mockResolvedValue('refresh-token');
    mockSignGrantAccessToken.mockReset();
    mockSignGrantAccessToken.mockResolvedValue({ token: 'grant-access-token', expiresIn: 3600 });
    mockWorkspacesFindFirst.mockResolvedValue(null);
  });

  it('a grant that no longer resolves is refused, its family revoked, and no id is echoed', async () => {
    mockConsumeRefreshToken.mockResolvedValue({ userId: 'user-1', grantId: GRANT, scope: 'mcp' });
    mockResolveGrant.mockResolvedValue(null);
    const res = await POST(makeRequest({ grant_type: 'refresh_token', refresh_token: 'rt', client_id: 'c_1' }));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text).error).toBe('invalid_grant');
    expect(text).not.toContain(GRANT);
    expect(mockRevokeRefreshTokensForGrant).toHaveBeenCalledWith(GRANT);
    expect(mockCreateRefreshToken).not.toHaveBeenCalled();
  });

  it('a live grant mints a grant token and a refresh token bound to the same grant', async () => {
    mockConsumeRefreshToken.mockResolvedValue({ userId: 'user-1', grantId: GRANT, scope: 'mcp' });
    mockResolveGrant.mockResolvedValue({ grantId: GRANT, userId: 'user-1', clientId: 'c_1', actsAs: 'agent', scopes: ['read'], workspaces: [{ workspaceId: 'ws-1', teamId: 't-1', role: 'member' }] });
    const res = await POST(makeRequest({ grant_type: 'refresh_token', refresh_token: 'rt', client_id: 'c_1' }));
    expect(res.status).toBe(200);
    expect(mockResolveGrant).toHaveBeenCalledWith(GRANT, 'user-1', 'c_1');
    expect(mockSignGrantAccessToken).toHaveBeenCalledWith({ userId: 'user-1', grantId: GRANT, clientId: 'c_1', scope: 'mcp' });
    expect(mockCreateRefreshToken).toHaveBeenCalledWith({ clientId: 'c_1', userId: 'user-1', grantId: GRANT, scope: 'mcp' });
  });
});
