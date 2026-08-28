// Ensure test mode — routes short-circuit in development
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Save original NODE_ENV to restore later
const originalNodeEnv = process.env.NODE_ENV;

// Mock functions
const mockAuthenticateApiKey = mock(() => null as any);
const mockGithubApi = mock(() => null as any);
const mockMergePullRequest = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockWorkersFindMany = mock(() => [] as any[]);
const mockGithubReposFindFirst = mock(() => null as any);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockGetTeamWorkspaceIds = mock(() => [] as string[]);
const mockWorkersUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));

// Mock api-auth
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

// Mock github
mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
  mergePullRequest: mockMergePullRequest,
}));

// Mock team-access
mock.module('@/lib/team-access', () => ({
  getTeamWorkspaceIds: mockGetTeamWorkspaceIds,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: {
        findFirst: mockWorkersFindFirst,
        findMany: mockWorkersFindMany,
      },
      githubRepos: { findFirst: mockGithubReposFindFirst },
      workspaces: { findMany: mockWorkspacesFindMany },
    },
    update: () => mockWorkersUpdate(),
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
  isNull: (field: any) => ({ field, type: 'isNull' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  workers: { id: 'id', accountId: 'accountId', taskId: 'taskId', prUrl: 'prUrl', prNumber: 'prNumber', workspaceId: 'workspaceId', updatedAt: 'updatedAt', mergedAt: 'mergedAt', prLifecycleStatus: 'prLifecycleStatus', lastCommitSha: 'lastCommitSha' },
  githubRepos: { id: 'id', fullName: 'fullName', defaultBranch: 'defaultBranch' },
  missions: { id: 'id', primaryPrNumber: 'primaryPrNumber', primaryPrUrl: 'primaryPrUrl', updatedAt: 'updatedAt' },
  workspaces: { id: 'id', name: 'name', repo: 'repo' },
}));

// Import handler AFTER mocks
import { POST, PATCH, PUT, GET } from './route';

// Shared account + workspace defaults for most tests (same team → access granted)
const ACCOUNT = { id: 'account-1', teamId: 'team-1' };
const WORKSPACE_OK = { teamId: 'team-1', githubRepoId: 'repo-1', githubInstallationId: 'inst-1' };
const WORKSPACE_OTHER_TEAM = { teamId: 'team-2', githubRepoId: 'repo-1', githubInstallationId: 'inst-1' };
const REPO = { id: 'repo-1', fullName: 'owner/repo', defaultBranch: 'main', installation: { installationId: 12345 } };

// Helper to create mock NextRequest
function createMockRequest(options: {
  headers?: Record<string, string>;
  body?: any;
} = {}): NextRequest {
  const { headers = {}, body } = options;
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers(headers),
  };
  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Headers).set('content-type', 'application/json');
  }
  return new NextRequest('http://localhost:3000/api/github/pr', init);
}

describe('POST /api/github/pr', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockAuthenticateApiKey.mockReset();
    mockGithubApi.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkersFindMany.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockGetTeamWorkspaceIds.mockReset();

    // Restore default chain mock for update
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when not authenticated', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest({
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Invalid API key');
  });

  it('returns 400 when workerId is missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('workerId required');
  });

  it('returns 400 when title is missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('title and head branch required');
  });

  it('returns 400 when head is missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR' },
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('title and head branch required');
  });

  it('returns 404 when worker not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue(null);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'nonexistent', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Worker not found');
  });

  it('returns 403 when workspace team does not match account team', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-runner',
      name: 'test-worker',
      workspace: WORKSPACE_OTHER_TEAM,
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Worker belongs to different account');
  });

  // Test (a): account A's token + worker created under a different accountId but same workspace team → 200
  it('allows worker from runner account when workspace team matches authenticated account team', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValueOnce({
      id: 'w-1',
      accountId: 'account-runner',  // different accountId — runner's account
      taskId: null,
      name: 'test-worker',
      workspace: WORKSPACE_OK,  // same team → access granted
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValueOnce([]); // dedup check: no existing PRs
    mockGithubApi.mockResolvedValueOnce({
      number: 42,
      html_url: 'https://github.com/owner/repo/pull/42',
      state: 'open',
      title: 'My PR',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.pr.number).toBe(42);
  });

  // Test (b): token with no access to the workspace (different team) → 403
  it('rejects cross-team workspace access', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',  // same accountId, but wrong team
      name: 'test-worker',
      workspace: WORKSPACE_OTHER_TEAM,
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Worker belongs to different account');
  });

  it('returns 400 when workspace not linked to GitHub repo', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: { teamId: 'team-1', githubRepoId: null, githubInstallationId: null },
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Workspace not linked to GitHub repo');
  });

  it('returns 404 when GitHub repo not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(null);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('GitHub repo not found');
  });

  it('returns 404 when GitHub repo has no installation', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue({
      id: 'repo-1',
      fullName: 'owner/repo',
      defaultBranch: 'main',
      installation: null,
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('GitHub repo not found');
  });

  it('creates PR successfully and returns PR data', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValue({
      number: 42,
      html_url: 'https://github.com/owner/repo/pull/42',
      state: 'open',
      title: 'My PR',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch', body: 'PR description' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.pr.number).toBe(42);
    expect(data.pr.url).toBe('https://github.com/owner/repo/pull/42');
    expect(data.pr.state).toBe('open');
    expect(data.pr.title).toBe('My PR');
  });

  it('updates worker with PR URL after creation', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValue({
      number: 42,
      html_url: 'https://github.com/owner/repo/pull/42',
      state: 'open',
      title: 'My PR',
    });

    let capturedSetData: any = null;
    const mockWhere = mock(() => Promise.resolve());
    const mockSet = mock((data: any) => {
      capturedSetData = data;
      return { where: mockWhere };
    });
    mockWorkersUpdate.mockReturnValue({ set: mockSet });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(capturedSetData).not.toBeNull();
    expect(capturedSetData.prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(capturedSetData.prNumber).toBe(42);
    expect(capturedSetData.updatedAt).toBeInstanceOf(Date);
  });

  it('calls githubApi with correct parameters', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: { ...WORKSPACE_OK },
    });
    mockGithubReposFindFirst.mockResolvedValue({
      ...REPO,
      defaultBranch: 'develop',
    });
    mockGithubApi.mockResolvedValue({
      number: 10,
      html_url: 'https://github.com/owner/repo/pull/10',
      state: 'open',
      title: 'Test PR',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: {
        workerId: 'w-1',
        title: 'Test PR',
        head: 'feature-branch',
        base: 'staging',
        draft: true,
        body: 'Custom body',
      },
    });
    await POST(req);

    // First call is the dedup check, second call is the PR creation
    expect(mockGithubApi).toHaveBeenCalledTimes(2);
    const [installId, path, options] = mockGithubApi.mock.calls[1];
    expect(installId).toBe(12345);
    expect(path).toBe('/repos/owner/repo/pulls');
    expect(options.method).toBe('POST');

    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.title).toBe('Test PR');
    expect(parsedBody.head).toBe('feature-branch');
    expect(parsedBody.base).toBe('staging');
    expect(parsedBody.draft).toBe(true);
    expect(parsedBody.body).toBe('Custom body');
  });

  it('uses workspace gitConfig.targetBranch when base not provided', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: { ...WORKSPACE_OK, gitConfig: { targetBranch: 'dev' } },
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValue({
      number: 10,
      html_url: 'https://github.com/owner/repo/pull/10',
      state: 'open',
      title: 'Test PR',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'Test PR', head: 'feature-branch' },
    });
    await POST(req);

    const [, , options] = mockGithubApi.mock.calls[1];
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.base).toBe('dev');
  });

  it('ignores task context baseBranch when it matches the PR head', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: { ...WORKSPACE_OK, gitConfig: { targetBranch: 'dev' } },
      task: {
        context: { baseBranch: 'feature-branch' },
      },
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValue({
      number: 10,
      html_url: 'https://github.com/owner/repo/pull/10',
      state: 'open',
      title: 'Test PR',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'Test PR', head: 'feature-branch' },
    });
    await POST(req);

    const [, , options] = mockGithubApi.mock.calls[1];
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.base).toBe('dev');
  });

  it('falls back to repo defaultBranch when no gitConfig.targetBranch', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue({
      ...REPO,
      defaultBranch: 'develop',
    });
    mockGithubApi.mockResolvedValue({
      number: 10,
      html_url: 'https://github.com/owner/repo/pull/10',
      state: 'open',
      title: 'Test PR',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'Test PR', head: 'feature-branch' },
    });
    await POST(req);

    const [, , options] = mockGithubApi.mock.calls[1];
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.base).toBe('develop');
  });

  it('falls back to main when no gitConfig and no repo defaultBranch', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue({
      ...REPO,
      defaultBranch: null,
    });
    mockGithubApi.mockResolvedValue({
      number: 10,
      html_url: 'https://github.com/owner/repo/pull/10',
      state: 'open',
      title: 'Test PR',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'Test PR', head: 'feature-branch' },
    });
    await POST(req);

    const [, , options] = mockGithubApi.mock.calls[1];
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.base).toBe('main');
  });

  it('uses task context targetBranch over workspace gitConfig', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: { ...WORKSPACE_OK, gitConfig: { targetBranch: 'dev' } },
      task: {
        context: { targetBranch: 'release/1.0' },
      },
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValue({
      number: 10,
      html_url: 'https://github.com/owner/repo/pull/10',
      state: 'open',
      title: 'Test PR',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'Test PR', head: 'feature-branch' },
    });
    await POST(req);

    const [, , options] = mockGithubApi.mock.calls[1];
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.base).toBe('release/1.0');
  });

  it('explicit base param overrides task context targetBranch', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: { ...WORKSPACE_OK, gitConfig: { targetBranch: 'dev' } },
      task: {
        context: { targetBranch: 'release/1.0' },
      },
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValue({
      number: 10,
      html_url: 'https://github.com/owner/repo/pull/10',
      state: 'open',
      title: 'Test PR',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'Test PR', head: 'feature-branch', base: 'hotfix' },
    });
    await POST(req);

    const [, , options] = mockGithubApi.mock.calls[1];
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.base).toBe('hotfix');
  });

  it('uses default body text when prBody not provided', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValue({
      number: 10,
      html_url: 'https://github.com/owner/repo/pull/10',
      state: 'open',
      title: 'Test PR',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'Test PR', head: 'feature-branch' },
    });
    await POST(req);

    const [, , options] = mockGithubApi.mock.calls[1];
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.body).toBe('Created by buildd worker test-worker');
  });

  it('deduplicates when worker already has a PR', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      prUrl: 'https://github.com/owner/repo/pull/99',
      prNumber: 99,
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);

    let capturedSetData: any = null;
    mockWorkersUpdate.mockReturnValue({
      set: mock((data: any) => {
        capturedSetData = data;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.deduplicated).toBe(true);
    expect(data.pr.number).toBe(99);
    expect(data.pr.url).toBe('https://github.com/owner/repo/pull/99');
    expect(capturedSetData?.updatedAt).toBeInstanceOf(Date);
    // Should NOT have called githubApi to create a new PR
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('deduplicates when GitHub already has an open PR for the head branch', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      prUrl: null,
      prNumber: null,
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);

    // First call: list existing PRs (returns one match)
    // Second call: fetch individual PR detail for diff stats
    mockGithubApi.mockResolvedValueOnce([
      {
        number: 42,
        html_url: 'https://github.com/owner/repo/pull/42',
        state: 'open',
        title: 'Existing PR',
      },
    ]);
    mockGithubApi.mockResolvedValueOnce({
      number: 42,
      html_url: 'https://github.com/owner/repo/pull/42',
      state: 'open',
      title: 'Existing PR',
      additions: 807,
      deletions: 12,
      changed_files: 5,
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.deduplicated).toBe(true);
    expect(data.pr.number).toBe(42);
    expect(data.pr.url).toBe('https://github.com/owner/repo/pull/42');
    // Should have called githubApi twice: list check + individual PR fetch for stats
    expect(mockGithubApi).toHaveBeenCalledTimes(2);
  });

  it('stores diff stats from GitHub response when creating PR', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    // List check returns empty, then create returns PR with diff stats
    mockGithubApi.mockResolvedValueOnce([]);
    mockGithubApi.mockResolvedValueOnce({
      number: 42,
      html_url: 'https://github.com/owner/repo/pull/42',
      state: 'open',
      title: 'My PR',
      additions: 807,
      deletions: 23,
      changed_files: 14,
    });

    let capturedSetData: any = null;
    const mockWhere = mock(() => Promise.resolve());
    const mockSet = mock((data: any) => {
      capturedSetData = data;
      return { where: mockWhere };
    });
    mockWorkersUpdate.mockReturnValue({ set: mockSet });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(capturedSetData).not.toBeNull();
    expect(capturedSetData.linesAdded).toBe(807);
    expect(capturedSetData.linesRemoved).toBe(23);
    expect(capturedSetData.filesChanged).toBe(14);
  });

  it('stores diff stats from GitHub response when deduplicating via existing PR', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      prUrl: null,
      prNumber: null,
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValueOnce([
      { number: 55, html_url: 'https://github.com/owner/repo/pull/55', state: 'open', title: 'Existing' },
    ]);
    mockGithubApi.mockResolvedValueOnce({
      number: 55, html_url: 'https://github.com/owner/repo/pull/55', state: 'open', title: 'Existing',
      additions: 150, deletions: 8, changed_files: 3,
    });

    let capturedSetData: any = null;
    const mockWhere = mock(() => Promise.resolve());
    const mockSet = mock((data: any) => {
      capturedSetData = data;
      return { where: mockWhere };
    });
    mockWorkersUpdate.mockReturnValue({ set: mockSet });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    await POST(req);

    expect(capturedSetData.linesAdded).toBe(150);
    expect(capturedSetData.linesRemoved).toBe(8);
    expect(capturedSetData.filesChanged).toBe(3);
  });

  it('deduplicates when a sibling worker on the same task already has a PR', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);

    // First call: get current worker (no PR yet)
    mockWorkersFindFirst.mockResolvedValueOnce({
      id: 'w-new',
      accountId: 'account-1',
      taskId: 'task-shared',
      prUrl: null,
      prNumber: null,
      name: 'worker-retry',
      workspace: WORKSPACE_OK,
    });
    // Second call: find sibling worker with PR
    mockWorkersFindFirst.mockResolvedValueOnce({
      id: 'w-original',
      prUrl: 'https://github.com/owner/repo/pull/77',
      prNumber: 77,
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-new', title: 'My PR', head: 'buildd/taskshare-fix' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.deduplicated).toBe(true);
    expect(data.pr.number).toBe(77);
    expect(data.pr.url).toBe('https://github.com/owner/repo/pull/77');
    // Must NOT call GitHub API to create a duplicate PR
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('mirrors sibling PR onto current worker when deduplicating by task', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);

    mockWorkersFindFirst.mockResolvedValueOnce({
      id: 'w-new',
      accountId: 'account-1',
      taskId: 'task-shared',
      prUrl: null,
      prNumber: null,
      name: 'worker-retry',
      workspace: WORKSPACE_OK,
    });
    mockWorkersFindFirst.mockResolvedValueOnce({
      id: 'w-original',
      prUrl: 'https://github.com/owner/repo/pull/77',
      prNumber: 77,
    });

    let capturedSetData: any = null;
    const mockWhere = mock(() => Promise.resolve());
    const mockSet = mock((data: any) => {
      capturedSetData = data;
      return { where: mockWhere };
    });
    mockWorkersUpdate.mockReturnValue({ set: mockSet });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-new', title: 'My PR', head: 'buildd/taskshare-fix' },
    });
    await POST(req);

    // The current worker should be updated with the sibling's PR info
    expect(capturedSetData).not.toBeNull();
    expect(capturedSetData.prUrl).toBe('https://github.com/owner/repo/pull/77');
    expect(capturedSetData.prNumber).toBe(77);
  });

  it('returns 500 when githubApi throws an error', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockRejectedValue(new Error('GitHub API rate limit exceeded'));

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('GitHub API rate limit exceeded');
  });
});

function createPatchRequest(options: {
  headers?: Record<string, string>;
  body?: any;
} = {}): NextRequest {
  const { headers = {}, body } = options;
  const init: RequestInit = {
    method: 'PATCH',
    headers: new Headers(headers),
  };
  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Headers).set('content-type', 'application/json');
  }
  return new NextRequest('http://localhost:3000/api/github/pr', init);
}

describe('PATCH /api/github/pr', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockAuthenticateApiKey.mockReset();
    mockGithubApi.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkersFindMany.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockGetTeamWorkspaceIds.mockReset();
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({ where: mock(() => Promise.resolve()) })),
    });
  });

  it('returns 401 when not authenticated', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const req = createPatchRequest({ body: { workerId: 'w-1', prNumber: 42 } });
    const res = await PATCH(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Invalid API key');
  });

  it('returns 400 when workerId is missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    const req = createPatchRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { prNumber: 42 },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('workerId required');
  });

  it('returns 400 when prNumber is missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    const req = createPatchRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1' },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('prNumber required');
  });

  it('returns 404 when worker not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue(null);
    const req = createPatchRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'nonexistent', prNumber: 42 },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Worker not found');
  });

  it('returns 403 when workspace team does not match account team', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-runner',
      workspace: WORKSPACE_OTHER_TEAM,
    });
    const req = createPatchRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', prNumber: 42 },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Worker belongs to different account');
  });

  it('returns 400 when workspace not linked to GitHub repo', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      workspace: { teamId: 'team-1', githubRepoId: null, githubInstallationId: null },
    });
    const req = createPatchRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', prNumber: 42 },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Workspace not linked to GitHub repo');
  });

  it('returns 404 when GitHub repo not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(null);
    const req = createPatchRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', prNumber: 42 },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('GitHub repo not found');
  });

  it('closes PR successfully and returns closed PR data', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValue({
      number: 42,
      html_url: 'https://github.com/owner/repo/pull/42',
      state: 'closed',
      title: 'Old feature PR',
    });

    const req = createPatchRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', prNumber: 42 },
    });
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.pr.number).toBe(42);
    expect(data.pr.state).toBe('closed');
    expect(data.pr.url).toBe('https://github.com/owner/repo/pull/42');
  });

  it('calls githubApi with PATCH and state: closed', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValue({
      number: 71,
      html_url: 'https://github.com/owner/repo/pull/71',
      state: 'closed',
      title: 'Superseded PR',
    });

    const req = createPatchRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', prNumber: 71 },
    });
    await PATCH(req);

    expect(mockGithubApi).toHaveBeenCalledTimes(1);
    const [installId, path, options] = mockGithubApi.mock.calls[0];
    expect(installId).toBe(12345);
    expect(path).toBe('/repos/owner/repo/pulls/71');
    expect(options.method).toBe('PATCH');
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.state).toBe('closed');
  });

  it('returns 500 when githubApi throws', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockRejectedValue(new Error('GitHub API error: 403 Resource not accessible by integration'));

    const req = createPatchRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', prNumber: 42 },
    });
    const res = await PATCH(req);

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('403');
  });
});

// ── PUT /api/github/pr (merge) ────────────────────────────────────────────────

function createPutRequest(options: {
  headers?: Record<string, string>;
  body?: any;
} = {}): NextRequest {
  const { headers = {}, body } = options;
  const init: RequestInit = {
    method: 'PUT',
    headers: new Headers(headers),
  };
  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Headers).set('content-type', 'application/json');
  }
  return new NextRequest('http://localhost:3000/api/github/pr', init);
}

describe('PUT /api/github/pr', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockAuthenticateApiKey.mockReset();
    mockMergePullRequest.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkersFindMany.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockGetTeamWorkspaceIds.mockReset();
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({ where: mock(() => Promise.resolve()) })),
    });
  });

  it('returns 401 when not authenticated', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const req = createPutRequest({ body: { workerId: 'w-1', prNumber: 42 } });
    const res = await PUT(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Invalid API key');
  });

  it('returns 400 when prNumber is missing (workerId also absent)', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    const req = createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: {},
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('prNumber required');
  });

  it('returns 400 when prNumber is missing even when workerId is provided', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    const req = createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1' },
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('prNumber required');
  });

  it('returns 404 when worker not found (workerId path)', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue(null);
    const req = createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'nonexistent', prNumber: 42 },
    });
    const res = await PUT(req);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Worker not found');
  });

  it('returns 403 when workspace team does not match account team', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-runner',
      workspace: WORKSPACE_OTHER_TEAM,
    });
    const req = createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', prNumber: 42 },
    });
    const res = await PUT(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Worker belongs to different account');
  });

  it('returns 400 when workspace not linked to GitHub repo', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      workspace: { teamId: 'team-1', githubRepoId: null, githubInstallationId: null },
    });
    const req = createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', prNumber: 42 },
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Workspace not linked to GitHub repo');
  });

  it('returns 404 when GitHub repo not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(null);
    const req = createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', prNumber: 42 },
    });
    const res = await PUT(req);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('GitHub repo not found');
  });

  it('merges PR successfully and stamps worker mergedAt', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      prUrl: 'https://github.com/owner/repo/pull/42',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockMergePullRequest.mockResolvedValue({ merged: true, message: 'Pull request successfully merged' });

    let capturedSetData: any = null;
    const mockWhere = mock(() => Promise.resolve());
    const mockSet = mock((data: any) => {
      capturedSetData = data;
      return { where: mockWhere };
    });
    mockWorkersUpdate.mockReturnValue({ set: mockSet });

    const req = createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', prNumber: 42 },
    });
    const res = await PUT(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.merged).toBe(true);
    expect(data.pr.number).toBe(42);
    expect(capturedSetData.mergedAt).toBeInstanceOf(Date);
    expect(capturedSetData.prLifecycleStatus).toBe('merged');
    expect(mockMergePullRequest).toHaveBeenCalledWith(12345, 'owner/repo', 42, 'squash');
  });

  it('uses mergeMethod param when provided', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      prUrl: null,
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockMergePullRequest.mockResolvedValue({ merged: true, message: 'Pull request successfully merged' });

    const req = createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', prNumber: 42, mergeMethod: 'rebase' },
    });
    await PUT(req);

    expect(mockMergePullRequest).toHaveBeenCalledWith(12345, 'owner/repo', 42, 'rebase');
  });

  it('returns 403 with hint when GitHub App lacks contents:write permission', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      prUrl: null,
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockMergePullRequest.mockResolvedValue({ merged: false, message: 'Resource not accessible by integration' });

    const req = createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', prNumber: 42 },
    });
    const res = await PUT(req);

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain('Resource not accessible by integration');
    expect(data.hint).toContain('contents:write');
  });

  it('returns {ok: false} when merge is blocked (not a permission error)', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      prUrl: null,
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockMergePullRequest.mockResolvedValue({ merged: false, message: 'Required status check "CI" is expected.' });

    const req = createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', prNumber: 42 },
    });
    const res = await PUT(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.merged).toBe(false);
    expect(data.message).toContain('Required status check');
  });

  // Test (c): merge_pr with prNumber only (no workerId) → resolves and merges
  it('resolves worker from prNumber when workerId is absent and merges successfully', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockGetTeamWorkspaceIds.mockResolvedValue(['workspace-1']);
    mockWorkersFindMany.mockResolvedValue([{
      id: 'w-resolved',
      taskId: 'task-1',
      workspaceId: 'workspace-1',
      prUrl: 'https://github.com/owner/repo/pull/1732',
      prNumber: 1732,
      prLifecycleStatus: null,
      lastCommitSha: null,
      workspace: WORKSPACE_OK,
    }]);
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockMergePullRequest.mockResolvedValue({ merged: true, message: 'Pull request successfully merged' });

    let capturedWorkerId: any = null;
    const mockWhere = mock((cond: any) => {
      capturedWorkerId = cond;
      return Promise.resolve();
    });
    const mockSet = mock(() => ({ where: mockWhere }));
    mockWorkersUpdate.mockReturnValue({ set: mockSet });

    const req = createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { prNumber: 1732 },  // no workerId
    });
    const res = await PUT(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.merged).toBe(true);
    expect(mockGetTeamWorkspaceIds).toHaveBeenCalledWith('team-1');
    expect(mockMergePullRequest).toHaveBeenCalledWith(12345, 'owner/repo', 1732, 'squash');
  });

  // Test (d): ambiguous prNumber across two workspaces → 409
  it('returns 409 when prNumber matches workers in multiple workspaces', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockGetTeamWorkspaceIds.mockResolvedValue(['ws-1', 'ws-2']);
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'w-a',
        taskId: 't-1',
        workspaceId: 'ws-1',
        prUrl: 'https://github.com/org/repo-a/pull/42',
        prNumber: 42,
        workspace: { ...WORKSPACE_OK, githubRepoId: 'repo-a' },
      },
      {
        id: 'w-b',
        taskId: 't-2',
        workspaceId: 'ws-2',
        prUrl: 'https://github.com/org/repo-b/pull/42',
        prNumber: 42,
        workspace: { ...WORKSPACE_OK, githubRepoId: 'repo-b' },
      },
    ]);

    const req = createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { prNumber: 42 },
    });
    const res = await PUT(req);

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain('multiple workspaces');
    expect(data.candidates).toEqual(expect.arrayContaining(['ws-1', 'ws-2']));
  });

  // Test (e): mergedAt stamped on resolve-by-prNumber merges
  it('stamps mergedAt on the resolved worker when merging by prNumber', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockGetTeamWorkspaceIds.mockResolvedValue(['workspace-1']);
    mockWorkersFindMany.mockResolvedValue([{
      id: 'w-resolved',
      taskId: 'task-1',
      workspaceId: 'workspace-1',
      prUrl: 'https://github.com/owner/repo/pull/42',
      prNumber: 42,
      prLifecycleStatus: null,
      lastCommitSha: null,
      workspace: WORKSPACE_OK,
    }]);
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockMergePullRequest.mockResolvedValue({ merged: true, message: 'Pull request successfully merged' });

    let capturedSetData: any = null;
    const mockWhere = mock(() => Promise.resolve());
    const mockSet = mock((data: any) => {
      capturedSetData = data;
      return { where: mockWhere };
    });
    mockWorkersUpdate.mockReturnValue({ set: mockSet });

    const req = createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { prNumber: 42 },
    });
    const res = await PUT(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.merged).toBe(true);
    // mergedAt must be stamped on the resolved worker
    expect(capturedSetData.mergedAt).toBeInstanceOf(Date);
    expect(capturedSetData.prLifecycleStatus).toBe('merged');
  });

  it('returns 404 when prNumber-only resolve finds no matching worker', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockGetTeamWorkspaceIds.mockResolvedValue(['workspace-1']);
    mockWorkersFindMany.mockResolvedValue([]);  // no match

    const req = createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { prNumber: 9999 },
    });
    const res = await PUT(req);

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('PR not found or already merged');
  });
});

// ── GET /api/github/pr (read PR details) ──────────────────────────────────────

function createGetRequest(workerId: string | null, prNumber?: number, workspaceId?: string): NextRequest {
  const url = new URL('http://localhost:3000/api/github/pr');
  if (workerId) url.searchParams.set('workerId', workerId);
  if (prNumber !== undefined) url.searchParams.set('prNumber', String(prNumber));
  if (workspaceId) url.searchParams.set('workspaceId', workspaceId);
  return new NextRequest(url.toString(), {
    method: 'GET',
    headers: new Headers({ Authorization: 'Bearer bld_test' }),
  });
}

describe('GET /api/github/pr', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockAuthenticateApiKey.mockReset();
    mockGithubApi.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkersFindMany.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockGetTeamWorkspaceIds.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const req = new NextRequest('http://localhost:3000/api/github/pr?workerId=w-1', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Invalid API key');
  });

  it('returns 400 when both workerId and prNumber are missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    const req = new NextRequest('http://localhost:3000/api/github/pr', {
      method: 'GET',
      headers: new Headers({ Authorization: 'Bearer bld_test' }),
    });
    const res = await GET(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('workerId or prNumber required');
  });

  it('returns 404 when worker not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue(null);
    const res = await GET(createGetRequest('nonexistent', 42));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Worker not found');
  });

  it('returns 403 when workspace team does not match account team', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-runner',
      workspace: WORKSPACE_OTHER_TEAM,
    });
    const res = await GET(createGetRequest('w-1', 42));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Worker belongs to different account');
  });

  it('returns 400 when workspace not linked to GitHub repo', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      workspace: { teamId: 'team-1', githubRepoId: null, githubInstallationId: null },
    });
    const res = await GET(createGetRequest('w-1', 42));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Workspace not linked to GitHub repo');
  });

  it('returns 404 when GitHub repo not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      prNumber: 42,
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(null);
    const res = await GET(createGetRequest('w-1', 42));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('GitHub repo not found');
  });

  it('returns 400 when prNumber cannot be resolved', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      prNumber: null,
      lastCommitSha: null,
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    // No prNumber in query and worker.prNumber is null
    const req = new NextRequest('http://localhost:3000/api/github/pr?workerId=w-1', {
      method: 'GET',
      headers: new Headers({ Authorization: 'Bearer bld_test' }),
    });
    const res = await GET(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('prNumber required');
  });

  it('returns PR details with CI and review summaries', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      lastCommitSha: null,
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);

    // Call 1: PR details
    mockGithubApi.mockResolvedValueOnce({
      number: 42,
      title: 'feat: add merge_pr action',
      body: 'This PR adds merge_pr and get_pr MCP actions.',
      state: 'open',
      mergeable: true,
      mergeable_state: 'clean',
      html_url: 'https://github.com/owner/repo/pull/42',
      head: { sha: 'abc123' },
      additions: 200,
      deletions: 10,
      changed_files: 5,
    });
    // Call 2: check-runs
    mockGithubApi.mockResolvedValueOnce({
      check_runs: [
        { status: 'completed', conclusion: 'success', name: 'CI' },
        { status: 'completed', conclusion: 'success', name: 'Typecheck' },
      ],
    });
    // Call 3: reviews
    mockGithubApi.mockResolvedValueOnce([
      { user: { login: 'alice' }, state: 'APPROVED' },
    ]);

    const res = await GET(createGetRequest('w-1', 42));
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.ok).toBe(true);
    expect(data.pr.number).toBe(42);
    expect(data.pr.title).toBe('feat: add merge_pr action');
    expect(data.pr.mergeable).toBe(true);
    expect(data.pr.mergeableState).toBe('clean');
    expect(data.pr.additions).toBe(200);
    expect(data.pr.changedFiles).toBe(5);
    expect(data.checks.state).toBe('success');
    expect(data.checks.passed).toBe(2);
    expect(data.reviews.approved).toBe(1);
    expect(data.reviews.changesRequested).toBe(0);
  });

  it('COMMENTED review after APPROVED does not erase approval', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      lastCommitSha: null,
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);

    // PR details
    mockGithubApi.mockResolvedValueOnce({
      number: 42, title: 'test', body: null, state: 'open',
      mergeable: true, mergeable_state: 'clean',
      html_url: 'https://github.com/owner/repo/pull/42',
      head: { sha: 'abc123' }, additions: 1, deletions: 0, changed_files: 1,
    });
    // check-runs: empty
    mockGithubApi.mockResolvedValueOnce({ check_runs: [] });
    // reviews: alice approved, then posted a follow-up comment
    mockGithubApi.mockResolvedValueOnce([
      { user: { login: 'alice' }, state: 'APPROVED' },
      { user: { login: 'alice' }, state: 'COMMENTED' },
    ]);

    const res = await GET(createGetRequest('w-1', 42));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.reviews.approved).toBe(1);
    expect(data.reviews.changesRequested).toBe(0);
  });

  it('auto-resolves prNumber from worker when not provided in query', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      prNumber: 99,
      prUrl: 'https://github.com/owner/repo/pull/99',
      lastCommitSha: 'def456',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);

    mockGithubApi.mockResolvedValueOnce({
      number: 99,
      title: 'Test PR',
      body: null,
      state: 'open',
      mergeable: null,
      mergeable_state: 'unknown',
      html_url: 'https://github.com/owner/repo/pull/99',
      head: { sha: 'def456' },
      additions: 5,
      deletions: 1,
      changed_files: 2,
    });
    mockGithubApi.mockResolvedValueOnce({ check_runs: [] });
    mockGithubApi.mockResolvedValueOnce([]);

    // No prNumber in query — resolved from worker
    const req = new NextRequest('http://localhost:3000/api/github/pr?workerId=w-1', {
      method: 'GET',
      headers: new Headers({ Authorization: 'Bearer bld_test' }),
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.pr.number).toBe(99);
    expect(data.checks.state).toBe('none');
    expect(data.checks.total).toBe(0);
  });

  // Test: GET resolves worker by prNumber when workerId is absent
  it('resolves PR details by prNumber when workerId is not provided', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockGetTeamWorkspaceIds.mockResolvedValue(['workspace-1']);
    mockWorkersFindMany.mockResolvedValue([{
      id: 'w-resolved',
      taskId: 'task-1',
      workspaceId: 'workspace-1',
      prUrl: 'https://github.com/owner/repo/pull/1732',
      prNumber: 1732,
      prLifecycleStatus: null,
      lastCommitSha: null,
      workspace: WORKSPACE_OK,
    }]);
    mockGithubReposFindFirst.mockResolvedValue(REPO);

    mockGithubApi.mockResolvedValueOnce({
      number: 1732,
      title: 'feat: fix 403 on own team',
      body: 'Fixes the auth boundary bug.',
      state: 'open',
      mergeable: true,
      mergeable_state: 'clean',
      html_url: 'https://github.com/owner/repo/pull/1732',
      head: { sha: 'abc999' },
      additions: 100,
      deletions: 5,
      changed_files: 3,
    });
    mockGithubApi.mockResolvedValueOnce({ check_runs: [{ status: 'completed', conclusion: 'success', name: 'CI' }] });
    mockGithubApi.mockResolvedValueOnce([{ user: { login: 'bob' }, state: 'APPROVED' }]);

    // No workerId — only prNumber
    const res = await GET(createGetRequest(null, 1732));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.pr.number).toBe(1732);
    expect(data.pr.title).toBe('feat: fix 403 on own team');
    expect(data.checks.state).toBe('success');
    expect(data.reviews.approved).toBe(1);
    expect(mockGetTeamWorkspaceIds).toHaveBeenCalledWith('team-1');
  });

  it('returns 409 when prNumber is ambiguous across workspaces in GET', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockGetTeamWorkspaceIds.mockResolvedValue(['ws-1', 'ws-2']);
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w-a', workspaceId: 'ws-1', prUrl: 'https://g.com/a/pull/42', prNumber: 42, workspace: WORKSPACE_OK },
      { id: 'w-b', workspaceId: 'ws-2', prUrl: 'https://g.com/b/pull/42', prNumber: 42, workspace: WORKSPACE_OK },
    ]);

    const res = await GET(createGetRequest(null, 42));

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain('multiple workspaces');
    expect(data.candidates).toEqual(expect.arrayContaining(['ws-1', 'ws-2']));
  });

  // Regression: worker rows returned by Drizzle always include error: null and status: 'idle'/'completed'.
  // The old discriminant ('error' in resolved) was always true for DB rows, causing
  // NextResponse.json({}, { status: 'idle' }) to throw — the real error eaten by the outer catch.
  it('returns 200 when worker row has error:null (Drizzle column always present)', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockGetTeamWorkspaceIds.mockResolvedValue(['workspace-1']);
    // Simulate a full Drizzle row: error column is null, status is text ('completed')
    mockWorkersFindMany.mockResolvedValue([{
      id: 'w-drizzle',
      taskId: 'task-1',
      workspaceId: 'workspace-1',
      prUrl: 'https://github.com/owner/repo/pull/149',
      prNumber: 149,
      prLifecycleStatus: null,
      lastCommitSha: null,
      error: null,        // ← Drizzle always includes this column
      status: 'completed', // ← Drizzle always includes this column (text, not an HTTP status)
      workspace: WORKSPACE_OK,
    }]);
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValueOnce({
      number: 149, title: 'fix: sibling-app theme', body: null, state: 'open',
      mergeable: true, mergeable_state: 'clean',
      html_url: 'https://github.com/owner/repo/pull/149',
      head: { sha: 'sha149' }, additions: 50, deletions: 5, changed_files: 3,
    });
    mockGithubApi.mockResolvedValueOnce({ check_runs: [] });
    mockGithubApi.mockResolvedValueOnce([]);

    const res = await GET(createGetRequest(null, 149));

    // Must NOT be 500 — if discriminant fires on the worker row, status would be
    // 'completed' (a string), Response constructor throws, catch returns 500.
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.pr.number).toBe(149);
  });

  it('returns 200 when worker row has error set to a string (error column non-null)', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockGetTeamWorkspaceIds.mockResolvedValue(['workspace-1']);
    mockWorkersFindMany.mockResolvedValue([{
      id: 'w-drizzle-err',
      taskId: 'task-2',
      workspaceId: 'workspace-1',
      prUrl: 'https://github.com/owner/repo/pull/149',
      prNumber: 149,
      prLifecycleStatus: null,
      lastCommitSha: null,
      error: 'Previous run failed with exit code 1', // ← error column set
      status: 'failed', // ← text status
      workspace: WORKSPACE_OK,
    }]);
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValueOnce({
      number: 149, title: 'fix: sibling-app theme', body: null, state: 'open',
      mergeable: null, mergeable_state: 'unknown',
      html_url: 'https://github.com/owner/repo/pull/149',
      head: { sha: 'sha149' }, additions: 50, deletions: 5, changed_files: 3,
    });
    mockGithubApi.mockResolvedValueOnce({ check_runs: [] });
    mockGithubApi.mockResolvedValueOnce([]);

    const res = await GET(createGetRequest(null, 149));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.pr.number).toBe(149);
  });

  it('resolves by workspace name when workspaceId is a name (not UUID)', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockGetTeamWorkspaceIds.mockResolvedValue(['uuid-ws-1', 'uuid-ws-2']);
    // Workspace name resolution: "sibling-app" maps to uuid-ws-1
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'uuid-ws-1', name: 'sibling-app', repo: 'acme/sibling-app' },
      { id: 'uuid-ws-2', name: 'other', repo: 'acme/other' },
    ]);
    // With workspaceId narrowed to uuid-ws-1, only return that workspace's worker
    mockWorkersFindMany.mockResolvedValue([{
      id: 'w-moa',
      taskId: 'task-moa',
      workspaceId: 'uuid-ws-1',
      prUrl: 'https://github.com/acme/sibling-app/pull/149',
      prNumber: 149,
      prLifecycleStatus: null,
      lastCommitSha: null,
      error: null,
      status: 'completed',
      workspace: WORKSPACE_OK,
    }]);
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValueOnce({
      number: 149, title: 'fix: sibling-app theme', body: null, state: 'open',
      mergeable: true, mergeable_state: 'clean',
      html_url: 'https://github.com/acme/sibling-app/pull/149',
      head: { sha: 'shaMoa' }, additions: 10, deletions: 2, changed_files: 1,
    });
    mockGithubApi.mockResolvedValueOnce({ check_runs: [] });
    mockGithubApi.mockResolvedValueOnce([]);

    const res = await GET(createGetRequest(null, 149, 'sibling-app'));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.pr.number).toBe(149);
    // workspace name resolution must have been called
    expect(mockWorkspacesFindMany).toHaveBeenCalled();
  });
});
