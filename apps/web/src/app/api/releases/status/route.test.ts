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
    // Include ref + prodBranch so the same-branch guard is not triggered in
    // auth/plumbing tests that aren't about branch resolution.
    releaseConfig: {
      enabled: true,
      strategy: 'workflow_dispatch',
      workflowFile: 'release.yml',
      ref: 'dev',
      prodBranch: 'main',
    },
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
  // Include other dispatch exports so this mock is complete when trigger/route.test.ts
  // runs in the same Bun worker (Bun may share module caches across test files).
  dispatchWorkflowRelease: mock(async () => ({ dispatched: true, workflowFile: '', ref: '', inputs: {}, runsUrl: '' })),
  classifyCheckRuns: mock(() => ({ ciState: 'unknown', failingChecks: [] })),
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

  it('returns 400 (not 500) when workspaceId is a name instead of a UUID', async () => {
    // Regression: resolveReleaseTarget validates UUID format and returns 400 instead
    // of letting Postgres throw "invalid input syntax for type uuid" which caused a
    // bare 500 with empty body.
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'admin' }));
    mockResolveReleaseTarget.mockImplementationOnce(() => ({
      ok: false,
      status: 400,
      error: 'workspaceId must be a UUID — pass the workspace UUID or use the repo param instead (got "buildd")',
    }));
    const { GET } = await import('./route');
    const res = await GET(makeRequest('bld_adminkey', { workspaceId: 'buildd' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/workspaceId must be a UUID/i);
  });
});

describe('GET /api/releases/status — prodBranch resolution', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockImplementation(() => null);
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'admin' }));
    mockIsGitHubAppConfigured.mockReset();
    mockIsGitHubAppConfigured.mockImplementation(() => true);
  });

  it('resolves prodBranch from releaseConfig.prodBranch when strategy is workflow_dispatch', async () => {
    // Regression: a workflow_dispatch workspace with releaseConfig.prodBranch="main"
    // and gitConfig.defaultBranch="dev" was previously returning dev→dev (0 commits)
    // because prodBranch fell through to defaultBranch for non-branch_merge strategies.
    mockResolveReleaseTarget.mockImplementationOnce(() => ({
      ok: true,
      target: {
        workspaceId: 'ws-buildd',
        owner: 'buildd-ai',
        name: 'buildd',
        repoFullName: 'buildd-ai/buildd',
        installationId: 12345,
        releaseConfig: {
          enabled: true,
          strategy: 'workflow_dispatch',
          workflowFile: 'release.yml',
          ref: 'dev',
          prodBranch: 'main',
        },
        defaultBranch: 'dev',
      },
    }));
    // Echo back the opts so the response body carries the resolved ref/prodBranch.
    mockReleasePreflight.mockImplementationOnce(async (_id: any, _owner: any, _name: any, opts: any) => ({
      ref: opts.ref,
      prodBranch: opts.prodBranch,
      aheadBy: 14,
      shippableCommits: [{ sha: 'abc1234', message: 'feat: something' }],
      ciState: 'failing',
      failingChecks: ['build', 'auto-fix'],
      openReleasePr: { number: 1690, url: 'https://github.com/buildd-ai/buildd/pull/1690', title: 'Release v1.2.3' },
    }));

    const { GET } = await import('./route');
    const res = await GET(makeRequest('bld_adminkey'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Must use releaseConfig.ref and releaseConfig.prodBranch, not defaultBranch for both.
    expect(body.ref).toBe('dev');
    expect(body.prodBranch).toBe('main');
    expect(body.aheadBy).toBe(14);
  });

  it('returns 422 with a descriptive error when ref and prodBranch resolve to the same branch', async () => {
    // This fires when releaseConfig is absent — both ref and prodBranch fall to
    // defaultBranch, producing a dev→dev comparison that always shows 0 commits ahead.
    mockResolveReleaseTarget.mockImplementationOnce(() => ({
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
    }));

    const { GET } = await import('./route');
    const res = await GET(makeRequest('bld_adminkey'));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/ref and prodBranch both resolved to "dev"/);
    expect(body.error).toMatch(/releaseConfig\.prodBranch/);
    expect(body.ref).toBe('dev');
    expect(body.prodBranch).toBe('dev');
  });

  it('explicit prodBranch param overrides releaseConfig', async () => {
    // When the caller passes prodBranch explicitly, it wins over releaseConfig.prodBranch.
    mockResolveReleaseTarget.mockImplementationOnce(() => ({
      ok: true,
      target: {
        workspaceId: 'ws-1',
        owner: 'buildd-ai',
        name: 'buildd',
        repoFullName: 'buildd-ai/buildd',
        installationId: 12345,
        releaseConfig: {
          enabled: true,
          strategy: 'workflow_dispatch',
          workflowFile: 'release.yml',
          ref: 'dev',
          prodBranch: 'main',
        },
        defaultBranch: 'dev',
      },
    }));
    mockReleasePreflight.mockImplementationOnce(async (_id: any, _owner: any, _name: any, opts: any) => ({
      ref: opts.ref,
      prodBranch: opts.prodBranch,
      aheadBy: 0,
      shippableCommits: [],
      ciState: 'passing',
      failingChecks: [],
      openReleasePr: null,
    }));

    const { GET } = await import('./route');
    const res = await GET(makeRequest('bld_adminkey', { prodBranch: 'release/1.2' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prodBranch).toBe('release/1.2');
  });
});
