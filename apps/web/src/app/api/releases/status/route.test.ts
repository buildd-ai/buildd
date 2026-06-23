import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/**
 * Regression test: OAuth tokens must be authorized on the release_status
 * endpoint. Prior to the fix, isAdmin() called db.query.accounts.findFirst
 * with a hashed API key — OAuth JWTs are not stored there, so they always
 * returned undefined and the endpoint responded 401. The fix delegates to
 * authenticateApiKey() which handles both key types.
 */

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockIsGitHubAppConfigured = mock(() => true);
const mockResolveReleaseTarget = mock(() => ({
  ok: true,
  target: {
    workspaceId: 'ws-1',
    owner: 'buildd-ai',
    name: 'buildd',
    repoFullName: 'buildd-ai/buildd',
    installationId: 12345,
    releaseConfig: null,
    defaultBranch: 'dev',
  },
}) as any);
const mockResolveReleaseStrategy = mock(() => ({
  ok: false,
  reason: 'not_configured',
  message: 'no strategy',
}) as any);
const mockReleasePreflight = mock(() => ({
  aheadBy: 3,
  ciState: 'passing',
  shippableCommits: [],
  openReleasePr: null,
}) as any);

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/github', () => ({
  isGitHubAppConfigured: mockIsGitHubAppConfigured,
}));

mock.module('@/lib/release/target', () => ({
  resolveReleaseTarget: mockResolveReleaseTarget,
}));

mock.module('@buildd/core/release-strategy', () => ({
  resolveReleaseStrategy: mockResolveReleaseStrategy,
}));

mock.module('@/lib/release/dispatch', () => ({
  releasePreflight: mockReleasePreflight,
}));

function makeRequest(token?: string, params?: Record<string, string>): NextRequest {
  const sp = new URLSearchParams({ workspaceId: 'ws-1', ...params });
  const url = `https://buildd.dev/api/releases/status?${sp.toString()}`;
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  return new NextRequest(url, { headers });
}

describe('GET /api/releases/status', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockImplementation(() => null);
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockImplementation(() => null);
    mockIsGitHubAppConfigured.mockReset();
    mockIsGitHubAppConfigured.mockImplementation(() => true);
  });

  it('returns 401 when no token is provided and no session', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 401 for a non-admin API key', async () => {
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'worker' }));
    const { GET } = await import('./route');
    const res = await GET(makeRequest('bld_workerkey'));
    expect(res.status).toBe(401);
  });

  it('allows an admin API key', async () => {
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'admin' }));
    const { GET } = await import('./route');
    const res = await GET(makeRequest('bld_adminkey'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('allows an OAuth JWT token (owner-level access)', async () => {
    // authenticateApiKey() resolves OAuth JWTs to an account with level='admin'
    mockAuthenticateApiKey.mockImplementation((key: string) => {
      if (key.startsWith('eyJ')) return { id: 'acc-owner', level: 'admin', authType: 'oauth' };
      return null;
    });
    const { GET } = await import('./route');
    const res = await GET(makeRequest('eyJhbGciOiJSUzI1NiJ9.fakeJwt'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('falls back to session auth when no Authorization header', async () => {
    mockGetCurrentUser.mockImplementation(() => ({ id: 'user-1' }));
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
  });

  it('returns 500 when GitHub App is not configured', async () => {
    mockIsGitHubAppConfigured.mockImplementation(() => false);
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'admin' }));
    const { GET } = await import('./route');
    const res = await GET(makeRequest('bld_adminkey'));
    expect(res.status).toBe(500);
  });
});
