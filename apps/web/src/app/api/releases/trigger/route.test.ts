import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockIsGitHubAppConfigured = mock(() => true);
const mockResolveReleaseTarget = mock(() => ({
  ok: true,
  target: {
    workspaceId: 'ws-1',
    workspaceName: 'My Project',
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
    gitConfig: { defaultBranch: 'dev', requiresPR: true, branchingStrategy: 'feature', commitStyle: 'conventional', autoCreatePR: true, useClaudeMd: true },
  },
}) as any);
const mockResolveReleaseStrategy = mock(() => ({
  ok: true,
  strategy: { kind: 'workflow_dispatch', workflowFile: 'release.yml', ref: 'dev', inputs: {} },
}) as any);
const mockDispatchWorkflowRelease = mock(
  async () =>
    ({
      dispatched: true,
      workflowFile: 'release.yml',
      ref: 'dev',
      inputs: {},
      runId: 42,
      runStatus: 'queued',
      runConclusion: null,
      runUrl: 'https://github.com/buildd-ai/buildd/actions/runs/42',
      runsUrl: 'https://github.com/buildd-ai/buildd/actions/workflows/release.yml',
    }) as any,
);
const mockReleasePreflight = mock(async () => ({
  ref: 'dev',
  prodBranch: 'main',
  aheadBy: 3,
  shippableCommits: [],
  failingChecks: [],
  refHeadSha: 'abc123sha',
  previousSha: 'def456sha',
  ciState: 'passing',
}));
const mockDetectArchetype = mock(() => 'gated' as any);
const mockAttributeRelease = mock(async () => ({ attributed: 1, skipped: 0 }));

// DB mock: chainable insert().values().returning(), update().set().where(), query.releases.findFirst()
const mockReturning = mock(async () => [{ id: 'release-uuid-1' }]);
const mockInsertWhere = mock(async () => []);
const mockInsert = mock(() => ({
  values: mock(() => ({ returning: mockReturning })),
}));
const mockUpdateSet = mock(() => ({ where: mockInsertWhere }));
const mockUpdate = mock(() => ({ set: mockUpdateSet }));
const mockReleaseFindFirst = mock(async () => null);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/github', () => ({ isGitHubAppConfigured: mockIsGitHubAppConfigured }));
mock.module('@/lib/release/target', () => ({ resolveReleaseTarget: mockResolveReleaseTarget }));
mock.module('@buildd/core/release-strategy', () => ({
  resolveReleaseStrategy: mockResolveReleaseStrategy,
}));
mock.module('@/lib/release/dispatch', () => ({
  dispatchWorkflowRelease: mockDispatchWorkflowRelease,
  releasePreflight: mockReleasePreflight,
  classifyCheckRuns: mock(() => ({ ciState: 'unknown', failingChecks: [] })),
}));
mock.module('@buildd/core/release-archetype', () => ({ detectArchetype: mockDetectArchetype }));
mock.module('@buildd/core/release-attribution', () => ({ attributeRelease: mockAttributeRelease }));
mock.module('@buildd/core/db', () => ({
  db: {
    insert: mockInsert,
    update: mockUpdate,
    query: { releases: { findFirst: mockReleaseFindFirst } },
  },
}));
mock.module('@buildd/core/db/schema', () => ({ releases: 'releases' }));
mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => args,
  inArray: (a: any, b: any) => ({ a, b, op: 'inArray' }),
}));

function makeRequest(token?: string, body?: object): NextRequest {
  const url = 'https://buildd.dev/api/releases/trigger';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  return new NextRequest(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? { workspaceId: 'ws-1' }),
  });
}

describe('POST /api/releases/trigger', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockImplementation(() => null);
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockImplementation(() => null);
    mockIsGitHubAppConfigured.mockReset();
    mockIsGitHubAppConfigured.mockImplementation(() => true);
    mockResolveReleaseTarget.mockReset();
    mockResolveReleaseTarget.mockImplementation(() => ({
      ok: true,
      target: {
        workspaceId: 'ws-1',
        workspaceName: 'My Project',
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
        gitConfig: { defaultBranch: 'dev', requiresPR: true, branchingStrategy: 'feature', commitStyle: 'conventional', autoCreatePR: true, useClaudeMd: true },
      },
    }));
    mockResolveReleaseStrategy.mockReset();
    mockResolveReleaseStrategy.mockImplementation(() => ({
      ok: true,
      strategy: { kind: 'workflow_dispatch', workflowFile: 'release.yml', ref: 'dev', inputs: {} },
    }));
    mockDispatchWorkflowRelease.mockReset();
    mockDispatchWorkflowRelease.mockImplementation(async () => ({
      dispatched: true,
      workflowFile: 'release.yml',
      ref: 'dev',
      inputs: {},
      runId: 42,
      runStatus: 'queued',
      runConclusion: null,
      runUrl: 'https://github.com/buildd-ai/buildd/actions/runs/42',
      runsUrl: 'https://github.com/buildd-ai/buildd/actions/workflows/release.yml',
    }));
    mockReleasePreflight.mockReset();
    mockReleasePreflight.mockImplementation(async () => ({
      ref: 'dev',
      prodBranch: 'main',
      aheadBy: 3,
      shippableCommits: [],
      failingChecks: [],
      refHeadSha: 'abc123sha',
      previousSha: 'def456sha',
      ciState: 'passing',
    }));
    mockDetectArchetype.mockReset();
    mockDetectArchetype.mockImplementation(() => 'gated');
    mockAttributeRelease.mockReset();
    mockAttributeRelease.mockImplementation(async () => ({ attributed: 1, skipped: 0 }));
    mockReleaseFindFirst.mockReset();
    mockReleaseFindFirst.mockImplementation(async () => null);
    mockReturning.mockReset();
    mockReturning.mockImplementation(async () => [{ id: 'release-uuid-1' }]);
    mockInsertWhere.mockReset();
    mockInsertWhere.mockImplementation(async () => []);
  });

  it('returns 401 when no token and no session', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 401 for non-admin API key', async () => {
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'worker' }));
    const { POST } = await import('./route');
    const res = await POST(makeRequest('bld_workerkey'));
    expect(res.status).toBe(401);
  });

  it('returns 500 when GitHub App is not configured', async () => {
    mockIsGitHubAppConfigured.mockImplementation(() => false);
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'admin' }));
    const { POST } = await import('./route');
    const res = await POST(makeRequest('bld_adminkey'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });

  it('happy path: row inserted, runUrl populated, releaseId in response', async () => {
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'admin' }));
    const { POST } = await import('./route');
    const res = await POST(makeRequest('bld_adminkey', { workspaceId: 'ws-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.strategy).toBe('workflow_dispatch');
    expect(body.runId).toBe(42);
    expect(body.runUrl).toContain('github.com');
    expect(body.releaseId).toBe('release-uuid-1');
    // Verify insert was called
    expect(mockInsert.mock.calls.length).toBeGreaterThan(0);
  });

  it('none archetype: no row inserted, returns skipped', async () => {
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'admin' }));
    mockDetectArchetype.mockImplementation(() => 'none');
    const insertCallsBefore = mockInsert.mock.calls.length;
    const { POST } = await import('./route');
    const res = await POST(makeRequest('bld_adminkey', { workspaceId: 'ws-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('skipped');
    expect(body.reason).toBe('none archetype');
    // No new insert should have been made
    expect(mockInsert.mock.calls.length).toBe(insertCallsBefore);
  });

  it('dedup: second dispatch with same headSha returns existing row without double-insert', async () => {
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'admin' }));
    mockReleaseFindFirst.mockImplementation(async () => ({
      id: 'existing-release-id',
      workspaceId: 'ws-1',
      headSha: 'abc123sha',
      state: 'dispatched',
    }));
    const insertCallsBefore = mockInsert.mock.calls.length;
    const dispatchCallsBefore = mockDispatchWorkflowRelease.mock.calls.length;
    const { POST } = await import('./route');
    const res = await POST(makeRequest('bld_adminkey', { workspaceId: 'ws-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.releaseId).toBe('existing-release-id');
    expect(body.deduped).toBe(true);
    // No new insert or dispatch
    expect(mockInsert.mock.calls.length).toBe(insertCallsBefore);
    expect(mockDispatchWorkflowRelease.mock.calls.length).toBe(dispatchCallsBefore);
  });

  it('attribution job called once on happy path', async () => {
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'admin' }));
    mockAttributeRelease.mockReset();
    mockAttributeRelease.mockImplementation(async () => ({ attributed: 1, skipped: 0 }));
    const { POST } = await import('./route');
    await POST(makeRequest('bld_adminkey', { workspaceId: 'ws-1' }));
    // Allow microtasks to flush for the void attribution call
    await new Promise((r) => setTimeout(r, 10));
    expect(mockAttributeRelease.mock.calls.length).toBe(1);
    const [attrs] = mockAttributeRelease.mock.calls[0] as any[];
    expect(attrs.releaseId).toBe('release-uuid-1');
    expect(attrs.previousSha).toBe('def456sha');
    expect(attrs.headSha).toBe('abc123sha');
  });

  it('passes workflow_id=release.yml and ref=dev to dispatch', async () => {
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'admin' }));
    const { POST } = await import('./route');
    await POST(makeRequest('bld_adminkey', { workspaceId: 'ws-1' }));
    expect(mockDispatchWorkflowRelease.mock.calls.length).toBeGreaterThan(0);
    const [, , , opts] = mockDispatchWorkflowRelease.mock.calls[mockDispatchWorkflowRelease.mock.calls.length - 1];
    expect(opts.workflowFile).toBe('release.yml');
    expect(opts.ref).toBe('dev');
  });

  it('returns 422 for unconfigured workspace (not_configured)', async () => {
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'admin' }));
    mockResolveReleaseStrategy.mockImplementation(() => ({
      ok: false,
      reason: 'not_configured',
      message: 'Workspace has no release config',
    }));
    const { POST } = await import('./route');
    const res = await POST(makeRequest('bld_adminkey', { workspaceId: 'ws-1' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
  });

  it('returns 409 for disabled workspace', async () => {
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'admin' }));
    mockResolveReleaseStrategy.mockImplementation(() => ({
      ok: false,
      reason: 'disabled',
      message: 'Release config is disabled',
    }));
    const { POST } = await import('./route');
    const res = await POST(makeRequest('bld_adminkey', { workspaceId: 'ws-1' }));
    expect(res.status).toBe(409);
  });

  it('returns 502 with GitHub error message when dispatch throws', async () => {
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'admin' }));
    mockDispatchWorkflowRelease.mockImplementation(async () => {
      throw new Error('GitHub API error: 403 Resource not accessible by integration');
    });
    const { POST } = await import('./route');
    const res = await POST(makeRequest('bld_adminkey', { workspaceId: 'ws-1' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('GitHub API error');
  });

  it('returns 502 with detail when GitHub returns 404 (missing workflow)', async () => {
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'admin' }));
    mockDispatchWorkflowRelease.mockImplementation(async () => {
      throw new Error('GitHub API error: 404 Not Found');
    });
    const { POST } = await import('./route');
    const res = await POST(makeRequest('bld_adminkey', { workspaceId: 'ws-1' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('returns 500 JSON (not empty body) when resolveReleaseTarget throws', async () => {
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'admin' }));
    mockResolveReleaseTarget.mockImplementation(() => {
      throw new Error('invalid input syntax for type uuid: "buildd"');
    });
    const { POST } = await import('./route');
    const res = await POST(makeRequest('bld_adminkey', { workspaceId: 'buildd' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('accepts session auth (OAuth owner), sets triggeredBy=user', async () => {
    mockGetCurrentUser.mockImplementation(() => ({ id: 'user-1' }));
    const { POST } = await import('./route');
    const res = await POST(makeRequest(undefined, { workspaceId: 'ws-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('proceeds without T1 data when preflight throws', async () => {
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'admin' }));
    mockReleasePreflight.mockImplementation(async () => { throw new Error('network failure'); });
    const { POST } = await import('./route');
    const res = await POST(makeRequest('bld_adminkey', { workspaceId: 'ws-1' }));
    // Should still succeed — preflight failure is non-fatal
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.releaseId).toBe('release-uuid-1');
  });
});
