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
const mockMissionsFindFirst = mock(() => Promise.resolve(null) as any);
const mockTasksFindFirst = mock(() => Promise.resolve(null) as any);
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
      // `claimMissionPrimaryPr` reads the mission to check whether it opted
      // into an integration branch: under Option A′ only the mission's own PR
      // may take the slot, while for every other mission the column keeps its
      // legacy meaning. Null = not opted in, which is what these cases assert.
      missions: { findFirst: mockMissionsFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
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
  workers: { id: 'id', accountId: 'accountId', taskId: 'taskId', prUrl: 'prUrl', prNumber: 'prNumber', prBaseRef: 'prBaseRef', workspaceId: 'workspaceId', updatedAt: 'updatedAt', mergedAt: 'mergedAt', prLifecycleStatus: 'prLifecycleStatus', lastCommitSha: 'lastCommitSha' },
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

  // ── missions.primaryPrNumber may only be claimed by a mission-level PR (P2) ──
  //
  // The slot used to go to whichever PR under the mission arrived first, so under
  // the integration-branch model the first *task* PR steals it. Only a PR based
  // on the workspace trunk is the mission's PR.
  function captureUpdatePayloads(): any[] {
    const payloads: any[] = [];
    mockWorkersUpdate.mockImplementation(() => ({
      set: (data: any) => {
        payloads.push(data);
        return { where: () => Promise.resolve() };
      },
    }));
    return payloads;
  }

  const MISSION_WORKER = {
    id: 'w-1',
    accountId: 'account-1',
    name: 'test-worker',
    workspace: { ...WORKSPACE_OK, gitConfig: { defaultBranch: 'dev' } },
    task: { id: 't-1', missionId: 'obj-1' },
  };

  it('does not claim the mission PR slot for a task PR based on a mission integration branch', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue(MISSION_WORKER);
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValue({
      number: 42,
      html_url: 'https://github.com/owner/repo/pull/42',
      state: 'open',
      title: 'My PR',
      base: { ref: 'mission/checkout-arc-1a2b3c4d' },
    });
    const payloads = captureUpdatePayloads();

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'buildd/t-1-do-thing' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(payloads.some(p => 'primaryPrNumber' in p)).toBe(false);
  });

  it('claims the mission PR slot for a PR based on the workspace trunk', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue(MISSION_WORKER);
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValue({
      number: 42,
      html_url: 'https://github.com/owner/repo/pull/42',
      state: 'open',
      title: 'My PR',
      base: { ref: 'dev' },
    });
    const payloads = captureUpdatePayloads();

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'mission/checkout-arc-1a2b3c4d' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const missionPayload = payloads.find(p => 'primaryPrNumber' in p);
    expect(missionPayload).toBeDefined();
    expect(missionPayload.primaryPrNumber).toBe(42);
    expect(missionPayload.primaryPrUrl).toBe('https://github.com/owner/repo/pull/42');
  });

  it('does not claim the mission PR slot when the base ref is unknown', async () => {
    // The prUrl-registration path never talks to GitHub, so an unclassifiable PR
    // must not populate a slot that means "this is the mission's PR".
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue(MISSION_WORKER);
    const payloads = captureUpdatePayloads();

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: {
        workerId: 'w-1',
        title: 'My PR',
        head: 'buildd/t-1-do-thing',
        prUrl: 'https://github.com/owner/repo/pull/42',
      },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(payloads.some(p => 'primaryPrNumber' in p)).toBe(false);
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

  // ── prBaseRef recording (Option A' — mission integration branches) ────────
  // These assert the .set() payload, which the db mock passes through verbatim.
  // (The WHERE clause is NOT observable under this mock — a known trap — so
  // these tests are scoped to "what value do we write", not "to which row".)
  it("records prBaseRef from GitHub's own base.ref when creating a PR", async () => {
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
    mockGithubApi.mockResolvedValueOnce([]); // no existing PR for this head
    mockGithubApi.mockResolvedValueOnce({
      number: 42,
      html_url: 'https://github.com/owner/repo/pull/42',
      state: 'open',
      title: 'My PR',
      base: { ref: 'mission/example-slug-0a1b2c3d', sha: 'basesha1' },
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

    expect(capturedSetData).not.toBeNull();
    expect(capturedSetData.prBaseRef).toBe('mission/example-slug-0a1b2c3d');
  });

  it("prefers GitHub's base.ref over the base the caller asked for", async () => {
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
    mockGithubApi.mockResolvedValueOnce([]);
    mockGithubApi.mockResolvedValueOnce({
      number: 43,
      html_url: 'https://github.com/owner/repo/pull/43',
      state: 'open',
      title: 'My PR',
      base: { ref: 'dev', sha: 'basesha2' },
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
      // Caller claims a mission branch; GitHub says the PR actually points at dev.
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch', base: 'mission/example-slug-0a1b2c3d' },
    });
    await POST(req);

    expect(capturedSetData.prBaseRef).toBe('dev');
  });

  it('leaves prBaseRef unset when GitHub returns no base', async () => {
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
    mockGithubApi.mockResolvedValueOnce([]);
    mockGithubApi.mockResolvedValueOnce({
      number: 44,
      html_url: 'https://github.com/owner/repo/pull/44',
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
    await POST(req);

    // Absent, not null and not a guess — unknown must degrade to today's gate.
    expect('prBaseRef' in capturedSetData).toBe(false);
  });

  /**
   * Record every `db.update(workers)` call with BOTH halves — the values and
   * the predicate. A recorder that keeps only `set()` cannot see the guard at
   * all: a write and a guarded write look identical from the values alone,
   * which is how an unconditional overwrite hides in a green suite.
   */
  function recordWorkerUpdates(): Array<{ set: any; where: any }> {
    const calls: Array<{ set: any; where: any }> = [];
    mockWorkersUpdate.mockReturnValue({
      set: (data: any) => {
        const call = { set: data, where: null as any };
        calls.push(call);
        return {
          where: (cond: any) => {
            call.where = cond;
            const p: any = Promise.resolve([]);
            p.returning = () => Promise.resolve([{ id: 'w-1' }]);
            return p;
          },
        };
      },
    } as any);
    return calls;
  }

  /** Flatten the mocked drizzle predicate tree into its leaf descriptors. */
  function predicateLeaves(cond: any): any[] {
    if (!cond || typeof cond !== 'object') return [];
    if (Array.isArray(cond.conditions)) return cond.conditions.flatMap(predicateLeaves);
    return [cond];
  }

  function adoptedPrWithBase(baseRef: string) {
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValueOnce([
      { number: 55, html_url: 'https://github.com/owner/repo/pull/55', state: 'open', title: 'Existing' },
    ]);
    mockGithubApi.mockResolvedValueOnce({
      number: 55, html_url: 'https://github.com/owner/repo/pull/55', state: 'open', title: 'Existing',
      base: { ref: baseRef, sha: 'basesha3' },
    });
  }

  it('backfills prBaseRef when adopting an existing PR for the same head', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      prUrl: null,
      prNumber: null,
      prBaseRef: null,
      workspace: WORKSPACE_OK,
    });
    adoptedPrWithBase('mission/example-slug-0a1b2c3d');
    const updates = recordWorkerUpdates();

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    await POST(req);

    const baseRefWrite = updates.find(c => 'prBaseRef' in c.set);
    expect(baseRefWrite?.set.prBaseRef).toBe('mission/example-slug-0a1b2c3d');
  });

  it('guards the adopt-path prBaseRef write so it can only fill a NULL', async () => {
    // The value comes from a `GET /pulls/{n}` taken earlier in this request, so
    // it can already be older than what the `pull_request` webhook recorded —
    // and there is no ordering signal here to tell. An unguarded write can
    // therefore move prBaseRef BACKWARDS onto a mission integration branch that
    // a retarget already left, and handleCheckSuiteEvent then resolves the merge
    // policy from that stale value: the tier drops to auto-threshold and the PR
    // can auto-merge into trunk with the human gate removed. So the write is
    // restricted to the one case that cannot be wrong: filling an unknown.
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      prUrl: null,
      prNumber: null,
      prBaseRef: null,
      workspace: WORKSPACE_OK,
    });
    adoptedPrWithBase('mission/example-slug-0a1b2c3d');
    const updates = recordWorkerUpdates();

    await POST(createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    }));

    const baseRefWrite = updates.find(c => 'prBaseRef' in c.set);
    expect(baseRefWrite).toBeDefined();
    const leaves = predicateLeaves(baseRefWrite!.where);
    expect(leaves).toContainEqual({ field: 'prBaseRef', type: 'isNull' });
    expect(leaves).toContainEqual({ field: 'id', value: 'w-1', type: 'eq' });
  });

  it('does not write prBaseRef at all when the worker already has one', async () => {
    // A recorded value came from somewhere newer than our snapshot (the webhook,
    // or this route's own create path). Not writing is the safe direction:
    // leaving a correct value alone costs nothing, replacing it with a stale one
    // costs a review gate.
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      prUrl: null,
      prNumber: null,
      prBaseRef: 'trunk-branch', // already retargeted off the mission branch
      workspace: WORKSPACE_OK,
    });
    adoptedPrWithBase('mission/example-slug-0a1b2c3d');
    const updates = recordWorkerUpdates();

    await POST(createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    }));

    expect(updates.find(c => 'prBaseRef' in c.set)).toBeUndefined();
    // The rest of the adopt bookkeeping still happens.
    expect(updates.some(c => c.set.prNumber === 55)).toBe(true);
  });

  it('keeps prBaseRef out of the unconditional adopt write', async () => {
    // If it rides along in the eq(id)-only UPDATE, the guard above is dead code.
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      prUrl: null,
      prNumber: null,
      prBaseRef: null,
      workspace: WORKSPACE_OK,
    });
    adoptedPrWithBase('mission/example-slug-0a1b2c3d');
    const updates = recordWorkerUpdates();

    await POST(createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    }));

    const adoptWrite = updates.find(c => c.set.prNumber === 55);
    expect(adoptWrite).toBeDefined();
    expect('prBaseRef' in adoptWrite!.set).toBe(false);
  });

  it("copies the sibling's prBaseRef when mirroring a same-task PR", async () => {
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
      prBaseRef: 'mission/example-slug-0a1b2c3d',
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

    expect(capturedSetData.prBaseRef).toBe('mission/example-slug-0a1b2c3d');
  });

  it("does not invent a prBaseRef when the sibling has none", async () => {
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
      prBaseRef: null, // pre-migration sibling
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

    expect('prBaseRef' in capturedSetData).toBe(false);
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
    mockTasksFindFirst.mockReset();
    mockTasksFindFirst.mockResolvedValue(null);
    mockMissionsFindFirst.mockResolvedValue(null);
    // The merge-policy gate reads the PR, its check runs and its files. Model a
    // green, clean, small PR by default so each test states its own refusal
    // rather than inheriting one from a missing fixture.
    mockGithubApi.mockImplementation((_inst: number, path: string) => {
      if (/\/check-runs$/.test(path)) {
        return Promise.resolve({
          check_runs: [
            { name: 'typecheck', status: 'completed', conclusion: 'success' },
            { name: 'build', status: 'completed', conclusion: 'success' },
            { name: 'test', status: 'completed', conclusion: 'success' },
          ],
        });
      }
      if (/\/files/.test(path)) {
        return Promise.resolve([
          { filename: 'apps/web/src/lib/foo.ts', additions: 10, deletions: 2, status: 'modified' },
        ]);
      }
      return Promise.resolve({ number: 42, head: { sha: 'sha-42' }, base: { ref: 'dev' }, mergeable_state: 'clean' });
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

  describe('merge-policy gate', () => {
    function workerOk() {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue({
        id: 'w-1',
        accountId: 'account-1',
        taskId: 'task-1',
        prUrl: 'https://github.com/owner/repo/pull/42',
        workspace: WORKSPACE_OK,
      });
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      mockMergePullRequest.mockResolvedValue({ merged: true, message: 'Pull request successfully merged' });
    }

    const put = () => PUT(createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', prNumber: 42 },
    }));

    it("refuses under 'agent-review' — a self-merge routes around the reviewer", async () => {
      // The most important refusal: green CI does not substitute for the
      // verdict, so this cannot be satisfied by making the PR cleaner.
      workerOk();
      mockWorkersFindFirst.mockResolvedValue({
        id: 'w-1', accountId: 'account-1', taskId: 'task-1',
        workspace: { ...WORKSPACE_OK, gitConfig: { mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } } } },
      });

      const res = await put();

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.tier).toBe('agent-review');
      expect(data.error).toContain('cannot be self-merged');
      expect(data.hint).toContain('request_pr_review');
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it("refuses under 'human'", async () => {
      workerOk();
      mockWorkersFindFirst.mockResolvedValue({
        id: 'w-1', accountId: 'account-1', taskId: 'task-1',
        workspace: { ...WORKSPACE_OK, gitConfig: { mergePolicy: { tier: 'human' } } },
      });

      const res = await put();

      expect(res.status).toBe(403);
      expect((await res.json()).tier).toBe('human');
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it("refuses when the task itself requires review, whatever the workspace tier", async () => {
      workerOk();
      mockTasksFindFirst.mockResolvedValue({ id: 'task-1', requiresReview: true, missionId: null });

      const res = await put();

      expect(res.status).toBe(403);
      expect((await res.json()).tier).toBe('human');
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('refuses when CI is not green, naming the failing check', async () => {
      workerOk();
      mockGithubApi.mockImplementation((_inst: number, path: string) => {
        if (/\/check-runs$/.test(path)) {
          return Promise.resolve({
            check_runs: [{ name: 'build', status: 'completed', conclusion: 'failure' }],
          });
        }
        if (/\/files/.test(path)) return Promise.resolve([{ filename: 'a.ts', additions: 1, deletions: 0, status: 'modified' }]);
        return Promise.resolve({ number: 42, head: { sha: 'sha-42' }, base: { ref: 'dev' }, mergeable_state: 'clean' });
      });

      const res = await put();

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain('build');
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('refuses when the PR touches a configured deny path', async () => {
      workerOk();
      mockWorkersFindFirst.mockResolvedValue({
        id: 'w-1', accountId: 'account-1', taskId: 'task-1',
        workspace: {
          ...WORKSPACE_OK,
          gitConfig: { mergePolicy: { tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: ['packages/core/db/'] } } },
        },
      });
      mockGithubApi.mockImplementation((_inst: number, path: string) => {
        if (/\/check-runs$/.test(path)) {
          return Promise.resolve({ check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] });
        }
        if (/\/files/.test(path)) {
          return Promise.resolve([{ filename: 'packages/core/db/schema.ts', additions: 4, deletions: 0, status: 'modified' }]);
        }
        return Promise.resolve({ number: 42, head: { sha: 'sha-42' }, base: { ref: 'dev' }, mergeable_state: 'clean' });
      });

      const res = await put();

      expect(res.status).toBe(403);
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('refuses when the PR head cannot be read — fail closed', async () => {
      // This read identifies the commit the policy is evaluated against.
      // Merging without it is a merge with no policy, which is the hole.
      workerOk();
      mockGithubApi.mockImplementation(() => Promise.reject(new Error('502 Bad Gateway')));

      const res = await put();

      expect(res.status).toBe(403);
      expect((await res.json()).error).toContain('could not read the PR head');
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('merges under auto-threshold when the same safety check auto-merge uses passes', async () => {
      // The positive case. Without it, every refusal above would also pass on a
      // route that refused unconditionally.
      workerOk();

      const res = await put();

      expect(res.status).toBe(200);
      expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
    });

    it('rejects force from a worker-level token', async () => {
      workerOk();
      mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, level: 'worker' });

      const res = await PUT(createPutRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', prNumber: 42, force: true },
      }));

      expect(res.status).toBe(403);
      expect((await res.json()).error).toContain('admin token');
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('lets an admin token force past the policy', async () => {
      // A human-held admin token is the human. Refusing it would make the gate
      // unbypassable, which turns a stuck PR into a support ticket.
      workerOk();
      mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, level: 'admin' });
      mockWorkersFindFirst.mockResolvedValue({
        id: 'w-1', accountId: 'account-1', taskId: 'task-1',
        workspace: { ...WORKSPACE_OK, gitConfig: { mergePolicy: { tier: 'human' } } },
      });

      const res = await PUT(createPutRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', prNumber: 42, force: true },
      }));

      expect(res.status).toBe(200);
      expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
    });

    it('still reports an already-merged PR without evaluating policy', async () => {
      // Reporting an existing merge is not a merge; a `human` tier must not
      // turn idempotent success into a 403.
      workerOk();
      mockWorkersFindFirst.mockResolvedValue({
        id: 'w-1', accountId: 'account-1', taskId: 'task-1',
        mergedAt: new Date('2026-09-01T00:00:00Z'),
        prUrl: 'https://github.com/owner/repo/pull/42',
        workspace: { ...WORKSPACE_OK, gitConfig: { mergePolicy: { tier: 'human' } } },
      });

      const res = await put();

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.alreadyMerged).toBe(true);
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('merges a task PR based on a mission integration branch under auto-threshold, bypassing workspace agent-review tier', async () => {
      // Under Option A′, a task PR whose base is the mission's integration branch
      // should run auto-threshold (the tier applies to the mission PR into trunk,
      // not to task PRs that feed it). This requires the mission query to select
      // workingBranch and integrationBranchEnabled so resolvePolicy can tell
      // whether the PR is based on an integration branch.
      //
      // The buggy route selects only mergePolicy and requiresReview, missing the
      // two fields that isMissionIntegrationBase needs. This test mimics what
      // the database returns for those exact columns: only those two fields present.
      workerOk();
      const missionId = 'mission-123';
      const integrationBranch = 'mission/integration-0a1b2c3d';

      mockWorkersFindFirst.mockResolvedValue({
        id: 'w-1', accountId: 'account-1', taskId: 'task-1',
        prUrl: 'https://github.com/owner/repo/pull/42',
        workspace: { ...WORKSPACE_OK, gitConfig: { mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } } } },
      });
      mockTasksFindFirst.mockResolvedValue({
        id: 'task-1',
        requiresReview: false,
        missionId,
      });
      // The mission has integrationBranchEnabled: true with the matching workingBranch.
      // With the fix, the route query now selects these fields, so isMissionIntegrationBase
      // can properly recognize that the PR base matches the mission's integration branch.
      mockMissionsFindFirst.mockResolvedValue({
        mergePolicy: null,
        requiresReview: false,
        workingBranch: integrationBranch,
        integrationBranchEnabled: true,
      });
      mockGithubApi.mockImplementation((_inst: number, path: string) => {
        if (/\/check-runs$/.test(path)) {
          return Promise.resolve({
            check_runs: [
              { name: 'typecheck', status: 'completed', conclusion: 'success' },
              { name: 'build', status: 'completed', conclusion: 'success' },
              { name: 'test', status: 'completed', conclusion: 'success' },
            ],
          });
        }
        if (/\/files/.test(path)) {
          return Promise.resolve([
            { filename: 'apps/web/src/lib/foo.ts', additions: 10, deletions: 2, status: 'modified' },
          ]);
        }
        return Promise.resolve({
          number: 42,
          head: { sha: 'sha-42' },
          base: { ref: integrationBranch },
          mergeable_state: 'clean',
        });
      });

      const res = await put();

      // With the bug, this FAILS with 403 agent-review because resolvePolicy cannot
      // tell that the PR is based on the mission's integration branch (the needed fields
      // are missing from the mission object). The PR is incorrectly gated as if it were
      // going to trunk. This test SHOULD PASS after the fix is applied.
      //
      // After the fix, this will merge successfully (status 200) because the mission
      // query will include workingBranch and integrationBranchEnabled, so resolvePolicy
      // can correctly identify that the base is the integration branch and drop the tier
      // to auto-threshold for task PRs.
      expect(res.status).toBe(200);
      expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
    });
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
    expect(data.error).toBe('PR not found');
  });

  it('returns success with existing metadata when DB says PR already merged (mergedAt set)', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      prUrl: 'https://github.com/owner/repo/pull/1870',
      mergedAt: new Date('2026-08-28T10:00:00Z'),
      prLifecycleStatus: 'merged',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValueOnce({
      merged: true,
      merged_at: '2026-08-28T10:00:05Z',
      merged_by: { login: 'reviewer-bot' },
      merge_commit_sha: 'abc123',
    });

    const req = createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', prNumber: 1870 },
    });
    const res = await PUT(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.merged).toBe(true);
    expect(data.alreadyMerged).toBe(true);
    expect(data.pr.mergedAt).toBe('2026-08-28T10:00:05Z');
    expect(data.pr.mergedBy).toBe('reviewer-bot');
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('returns success when only prLifecycleStatus=merged is set (mergedAt null — race condition)', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      prUrl: 'https://github.com/owner/repo/pull/55',
      mergedAt: null,
      prLifecycleStatus: 'merged',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockRejectedValueOnce(new Error('GitHub unavailable'));

    const req = createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', prNumber: 55 },
    });
    const res = await PUT(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.merged).toBe(true);
    expect(data.alreadyMerged).toBe(true);
    expect(data.pr.mergedAt).toBeNull();
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('merge_pr by prNumber on already-merged PR returns success (idempotent)', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockGetTeamWorkspaceIds.mockResolvedValue(['workspace-1']);
    mockWorkersFindMany.mockResolvedValue([{
      id: 'w-merged',
      taskId: 'task-1',
      workspaceId: 'workspace-1',
      prUrl: 'https://github.com/owner/repo/pull/1870',
      prNumber: 1870,
      prLifecycleStatus: 'merged',
      mergedAt: new Date('2026-08-28T10:00:00Z'),
      lastCommitSha: null,
      workspace: WORKSPACE_OK,
    }]);
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValueOnce({
      merged: true,
      merged_at: '2026-08-28T10:00:05Z',
      merged_by: { login: 'buildd-bot' },
      merge_commit_sha: 'deadbeef',
    });

    const req = createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { prNumber: 1870 },
    });
    const res = await PUT(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.merged).toBe(true);
    expect(data.alreadyMerged).toBe(true);
    expect(data.pr.number).toBe(1870);
    expect(mockMergePullRequest).not.toHaveBeenCalled();
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

  it('merged PR (workerId path) returns 200 with state=merged and merge metadata', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      prNumber: 1870,
      prUrl: 'https://github.com/owner/repo/pull/1870',
      mergedAt: new Date('2026-08-28T10:00:00Z'),
      prLifecycleStatus: 'merged',
      lastCommitSha: null,
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);

    mockGithubApi.mockResolvedValueOnce({
      number: 1870,
      title: 'feat: reviewer auto-merge',
      body: 'Fixes the auto-merge gate.',
      state: 'closed',
      merged: true,
      merged_at: '2026-08-28T10:00:05Z',
      merged_by: { login: 'mergebot' },
      merge_commit_sha: 'abc123def456',
      html_url: 'https://github.com/owner/repo/pull/1870',
      head: { sha: 'headsha' },
      base: { ref: 'dev' },
      additions: 50, deletions: 5, changed_files: 3,
    });
    mockGithubApi.mockResolvedValueOnce({ check_runs: [{ status: 'completed', conclusion: 'success', name: 'CI' }] });
    mockGithubApi.mockResolvedValueOnce([{ user: { login: 'reviewer-bot' }, state: 'APPROVED' }]);

    const res = await GET(createGetRequest('w-1', 1870));
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.ok).toBe(true);
    expect(data.pr.state).toBe('merged');
    expect(data.pr.mergedAt).toBe('2026-08-28T10:00:05Z');
    expect(data.pr.mergedBy).toBe('mergebot');
    expect(data.pr.mergeCommitSha).toBe('abc123def456');
    expect(data.pr.mergedVia).toBe('unknown');
    expect(data.pr.baseRef).toBe('dev');
    expect(data.pr.mergeable).toBeNull();
    expect(data.checks.state).toBe('success');
    expect(data.reviews.approved).toBe(1);
  });

  it('closed-unmerged PR returns 200 with state=closed_unmerged (distinguishable from merged)', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      prNumber: 777,
      prUrl: 'https://github.com/owner/repo/pull/777',
      mergedAt: null,
      prLifecycleStatus: 'closed',
      lastCommitSha: null,
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);

    mockGithubApi.mockResolvedValueOnce({
      number: 777,
      title: 'abandoned: old approach',
      body: null,
      state: 'closed',
      merged: false,
      merged_at: null,
      closed_at: '2026-08-27T09:00:00Z',
      html_url: 'https://github.com/owner/repo/pull/777',
      head: { sha: 'headsha2' },
      base: { ref: 'dev' },
      additions: 10, deletions: 2, changed_files: 1,
    });
    mockGithubApi.mockResolvedValueOnce({ check_runs: [] });
    mockGithubApi.mockResolvedValueOnce([]);

    const res = await GET(createGetRequest('w-1', 777));
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.ok).toBe(true);
    expect(data.pr.state).toBe('closed_unmerged');
    expect(data.pr.closedAt).toBe('2026-08-27T09:00:00Z');
    expect(data.pr.mergedAt).toBeNull();
    expect(data.pr.mergedBy).toBeNull();
    expect(data.pr.mergeCommitSha).toBeNull();
    expect(data.pr.mergedVia).toBeNull();
  });

  it('merged PR by prNumber (no workerId) returns 200 with merged state', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockGetTeamWorkspaceIds.mockResolvedValue(['workspace-1']);
    mockWorkersFindMany.mockResolvedValue([{
      id: 'w-merged',
      taskId: 'task-1',
      workspaceId: 'workspace-1',
      prUrl: 'https://github.com/owner/repo/pull/1660',
      prNumber: 1660,
      prLifecycleStatus: 'merged',
      mergedAt: new Date('2026-08-27T15:00:00Z'),
      lastCommitSha: null,
      workspace: WORKSPACE_OK,
    }]);
    mockGithubReposFindFirst.mockResolvedValue(REPO);

    mockGithubApi.mockResolvedValueOnce({
      number: 1660, title: 'feat: ci retry #1', body: null,
      state: 'closed', merged: true,
      merged_at: '2026-08-27T15:00:03Z',
      merged_by: { login: 'buildd-bot' },
      merge_commit_sha: 'cafe1234',
      html_url: 'https://github.com/owner/repo/pull/1660',
      head: { sha: 'sha1660' }, base: { ref: 'dev' },
      additions: 30, deletions: 5, changed_files: 2,
    });
    mockGithubApi.mockResolvedValueOnce({ check_runs: [] });
    mockGithubApi.mockResolvedValueOnce([]);

    const res = await GET(createGetRequest(null, 1660));
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.ok).toBe(true);
    expect(data.pr.state).toBe('merged');
    expect(data.pr.mergedAt).toBe('2026-08-27T15:00:03Z');
    expect(data.pr.mergedBy).toBe('buildd-bot');
    expect(data.pr.mergeCommitSha).toBe('cafe1234');
  });

  it('worker with prLifecycleStatus=merged but null mergedAt still reports merged', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockGetTeamWorkspaceIds.mockResolvedValue(['workspace-1']);
    mockWorkersFindMany.mockResolvedValue([{
      id: 'w-race',
      taskId: 'task-race',
      workspaceId: 'workspace-1',
      prUrl: 'https://github.com/owner/repo/pull/999',
      prNumber: 999,
      prLifecycleStatus: 'merged',
      mergedAt: null,
      lastCommitSha: null,
      workspace: WORKSPACE_OK,
    }]);
    mockGithubReposFindFirst.mockResolvedValue(REPO);

    // GitHub returns closed=true even if merged:false (edge: API lag)
    mockGithubApi.mockResolvedValueOnce({
      number: 999, title: 'fix: race condition', body: null,
      state: 'closed', merged: false,
      html_url: 'https://github.com/owner/repo/pull/999',
      head: { sha: 'sha999' }, base: { ref: 'dev' },
      additions: 5, deletions: 1, changed_files: 1,
    });
    mockGithubApi.mockResolvedValueOnce({ check_runs: [] });
    mockGithubApi.mockResolvedValueOnce([]);

    const res = await GET(createGetRequest(null, 999));
    expect(res.status).toBe(200);
    const data = await res.json();

    // prLifecycleStatus='merged' + githubClosed → canonicalState = 'merged'
    expect(data.pr.state).toBe('merged');
  });

  it('genuinely nonexistent PR number returns 404 with unambiguous message', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockGetTeamWorkspaceIds.mockResolvedValue(['workspace-1']);
    mockWorkersFindMany.mockResolvedValue([]);

    const res = await GET(createGetRequest(null, 9999));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('PR not found');
    expect(data.error).not.toContain('merged');
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

  it('returns 404 when workspaceId is supplied but resolves to no accessible workspace, instead of falling back to an unscoped search', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockGetTeamWorkspaceIds.mockResolvedValue(['uuid-ws-1', 'uuid-ws-2']);
    // Neither a UUID in wsIds nor a matching name/repo — e.g. a typo'd or inaccessible workspace.
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'uuid-ws-1', name: 'sibling-app', repo: 'acme/sibling-app' },
      { id: 'uuid-ws-2', name: 'other', repo: 'acme/other' },
    ]);

    const res = await GET(createGetRequest(null, 149, 'nonexistent-workspace'));

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('nonexistent-workspace');
    // Must not have silently fallen back to searching across all accessible workspaces.
    expect(mockWorkersFindMany).not.toHaveBeenCalled();
  });
});
