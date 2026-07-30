import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

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
    releaseConfig: {
      enabled: true,
      strategy: 'workflow_dispatch',
      workflowFile: 'release.yml',
      ref: 'dev',
    },
    defaultBranch: 'dev',
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

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/github', () => ({ isGitHubAppConfigured: mockIsGitHubAppConfigured }));
mock.module('@/lib/release/target', () => ({ resolveReleaseTarget: mockResolveReleaseTarget }));
mock.module('@buildd/core/release-strategy', () => ({
  resolveReleaseStrategy: mockResolveReleaseStrategy,
}));
mock.module('@/lib/release/dispatch', () => ({
  dispatchWorkflowRelease: mockDispatchWorkflowRelease,
  // Include other dispatch exports so this mock is complete even when status/route.test.ts
  // ran first in the same Bun worker (Bun may share module caches across test files).
  releasePreflight: mock(async () => ({
    ref: 'dev',
    prodBranch: 'main',
    aheadBy: 0,
    shippableCommits: [],
    failingChecks: [],
  })),
  classifyCheckRuns: mock(() => ({ ciState: 'unknown', failingChecks: [] })),
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
        owner: 'buildd-ai',
        name: 'buildd',
        repoFullName: 'buildd-ai/buildd',
        installationId: 12345,
        releaseConfig: {
          enabled: true,
          strategy: 'workflow_dispatch',
          workflowFile: 'release.yml',
          ref: 'dev',
        },
        defaultBranch: 'dev',
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

  it('dispatches configured workflow and returns run metadata', async () => {
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'admin' }));
    const { POST } = await import('./route');
    const res = await POST(makeRequest('bld_adminkey', { workspaceId: 'ws-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.strategy).toBe('workflow_dispatch');
    expect(body.runId).toBe(42);
    expect(body.runUrl).toContain('github.com');
  });

  it('passes workflow_id=release.yml and ref=dev to dispatch', async () => {
    mockAuthenticateApiKey.mockImplementation(() => ({ id: 'acc-1', level: 'admin' }));
    const { POST } = await import('./route');
    await POST(makeRequest('bld_adminkey', { workspaceId: 'ws-1' }));
    expect(mockDispatchWorkflowRelease.mock.calls.length).toBe(1);
    const [, , , opts] = mockDispatchWorkflowRelease.mock.calls[0];
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
    // Must never be an empty body — status 502 must always carry a JSON error
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
    // Body must be parseable JSON with an error field (not an empty body)
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('accepts session auth (OAuth owner)', async () => {
    mockGetCurrentUser.mockImplementation(() => ({ id: 'user-1' }));
    const { POST } = await import('./route');
    const res = await POST(makeRequest(undefined, { workspaceId: 'ws-1' }));
    expect(res.status).toBe(200);
  });
});
