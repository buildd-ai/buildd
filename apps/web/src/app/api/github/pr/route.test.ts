// Ensure test mode — routes short-circuit in development
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { TOKEN_PRESETS } from '@buildd/core/token-scopes';

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
// `guardMissionPrMerge`/`finalizeMissionPrMerge` (P3) run through
// `evaluateMissionWorkState`, which reads deliverable tasks via findMany.
const mockTasksFindMany = mock(() => Promise.resolve([]) as any);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockGetTeamWorkspaceIds = mock(() => [] as string[]);
/**
 * `db.update(...).set(...).where(...)` — awaited by most callers, but the
 * guarded `kind` stamp (mission-legibility Rule K2-16) needs `.returning()` as
 * its did-anything-change signal, so the fake WHERE is a thenable that also
 * carries one.
 */
const mockWorkersUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Object.assign(Promise.resolve([]), { returning: () => Promise.resolve([]) })),
  })),
}));
// Stored reviewer verdict for the agent-review self-merge gate. Default: no
// review on file, so tier=agent-review refuses unless a test says otherwise.
const mockReadPrReviewStatus = mock(() => Promise.resolve({
  state: 'not_requested' as const,
  terminal: true,
  reviewTaskId: null,
  adoptedTaskId: null,
  verdict: null,
  confidence: null,
  summary: null,
  feedback: null,
  escalationReason: null,
  iteration: null,
  maxIterations: null,
  prState: 'open' as const,
  merged: false,
  mergeBlocked: null,
}));

// Part 2: the live GitHub existence check + re-cut of a deleted integration
// branch. Mocked here so this file can drive the three answers it returns; the
// behaviour itself is covered in mission-integration-branch.test.ts.
const mockEnsureIntegrationBaseForTaskPr = mock(
  () => Promise.resolve({ usable: true, recreated: false }) as any,
);
const mockReportMissionBranchUnresolved = mock(async (_input: any) => {});
mock.module('@/lib/mission-integration-branch', () => ({
  ensureIntegrationBaseForTaskPr: mockEnsureIntegrationBaseForTaskPr,
  missionBranchRemedy: (reason: string) => `remedy for ${reason}`,
  reportMissionBranchUnresolved: mockReportMissionBranchUnresolved,
}));

// Mocks for the mission-integration-branch auto-review feature
const mockCreateReviewerTask = mock(() => Promise.resolve({ id: 'reviewer-task-1' }) as any);
const mockFindLiveReviewerTaskForHead = mock(() => Promise.resolve(null) as any);
const mockDispatchNewTask = mock(() => Promise.resolve());
const mockAppendPrActivity = mock(() => Promise.resolve());
const mockPickReviewerRole = mock(() => ({ role: 'reviewer', source: 'policy' as const }) as any);
const mockListWorkspaceRoles = mock(() => Promise.resolve([{ slug: 'reviewer', isRole: true }]) as any);

// Mock api-auth
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

// CI failure excerpts (opt-in `includeCiFailures`) — the lib has its own tests.
const mockFetchCiFailureExcerpts = mock(async (_i: number, _repo: string, failed: any[]) =>
  failed.map(f => ({ ...f, step: 'Type check', excerpt: 'error TS2322' })) as any);
mock.module('@/lib/ci-failure-excerpts', () => ({
  fetchCiFailureExcerpts: mockFetchCiFailureExcerpts,
}));

// Mock github
mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
  mergePullRequest: mockMergePullRequest,
  githubAppBotLogin: () => 'buildd[bot]',
}));

// Mock team-access
const mockVerifyWorkspaceAccess = mock(async (_userId: string, _workspaceId: string) => null as { teamId: string; role: string } | null);
const mockGetUserTeamIds = mock(async (_userId: string) => [] as string[]);
const mockVerifyAccountWorkspaceAccess = mock(async (_accountId: string, _workspaceId: string) => true);
mock.module('@/lib/team-access', () => ({
  getTeamWorkspaceIds: mockGetTeamWorkspaceIds,
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
  getUserTeamIds: mockGetUserTeamIds,
}));

// Inline evidence list — the lib has its own tests; here only who gets it.
const mockLoadInlineEvidence = mock(async (..._a: any[]) => [
  { id: 'ev-1', taskId: 'task-1', kind: 'command_output', bytes: 1, uploadState: 'stored', createdAt: '2026-01-01T00:00:00.000Z' },
] as any[]);
mock.module('@/lib/evidence-inline', () => ({ loadInlineEvidence: mockLoadInlineEvidence }));

// Dashboard session — GET only. Default: no session.
const mockGetCurrentUser = mock(async () => null as { id: string } | null);
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
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
      tasks: { findFirst: mockTasksFindFirst, findMany: mockTasksFindMany },
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
  tasks: { id: 'id', parentTaskId: 'parentTaskId', taskClass: 'taskClass' },
}));

// Mock pr-review-request — the stored-verdict lookup the agent-review
// self-merge gate consults, plus the role listing the auto-review feature uses.
// Claim grants for the cross-team runner path (canActOnWorkerPr). Default: none.
const mockGetAccountWorkspacePermissions = mock(async (_accountId: string) => [] as Array<{ workspaceId: string; canClaim: boolean; canCreate: boolean }>);
mock.module('@/lib/account-workspace-cache', () => ({
  getAccountWorkspacePermissions: mockGetAccountWorkspacePermissions,
}));

mock.module('@/lib/pr-review-request', () => ({
  readPrReviewStatus: mockReadPrReviewStatus,
  listWorkspaceRoles: mockListWorkspaceRoles,
}));

// Mock reviewer — auto-review dedup + task creation
mock.module('@/lib/reviewer', () => ({
  createReviewerTask: mockCreateReviewerTask,
  findLiveReviewerTaskForHead: mockFindLiveReviewerTaskForHead,
}));

// Mock task-dispatch — dispatching the reviewer task once created
mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: mockDispatchNewTask,
}));

// Mock pr-activity-comment — sticky "reviewing" comment on the PR
mock.module('@/lib/pr-activity-comment', () => ({
  appendPrActivity: mockAppendPrActivity,
}));

// Mock pr-review-status — reviewer role selection
mock.module('@/lib/pr-review-status', () => ({
  pickReviewerRole: mockPickReviewerRole,
}));

// The landing function — its decisions are covered in lib/pr-landing.test.ts;
// here only the merge_pr door's wiring is asserted. Mode resolution is the real rule.
const mockLandPr = mock(async (_input: any, _deps?: any): Promise<any> => ({ kind: 'waiting_ci', headSha: 'sha-42' }));
mock.module('@/lib/pr-landing', () => ({
  landPr: mockLandPr,
  resolveLandingMode: (gitConfig: any) => {
    const mode = gitConfig?.landing?.mode;
    return mode === 'off' || mode === 'shadow' || mode === 'enforce' ? mode : 'shadow';
  },
}));

// Import handler AFTER mocks
const mockCloseAncestorRetryPrs = mock(async (_opts: any) => [] as any[]);
mock.module('@/lib/retry-pr-supersession', () => ({ closeAncestorRetryPrs: mockCloseAncestorRetryPrs }));

import { POST, PATCH, PUT, GET } from './route';
import { MISSION_PR_TASK_PREFIX } from '@buildd/core/mission-integration';
import { extractLede } from '@buildd/core/pr-lede';

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
    mockMissionsFindFirst.mockReset();
    mockMissionsFindFirst.mockResolvedValue(null);
    mockTasksFindMany.mockReset();
    mockTasksFindMany.mockResolvedValue([]);
    mockEnsureIntegrationBaseForTaskPr.mockReset();
    mockEnsureIntegrationBaseForTaskPr.mockResolvedValue({ usable: true, recreated: false });
    mockCreateReviewerTask.mockReset();
    mockCreateReviewerTask.mockResolvedValue({ id: 'reviewer-task-1' });
    mockFindLiveReviewerTaskForHead.mockReset();
    mockFindLiveReviewerTaskForHead.mockResolvedValue(null);
    mockDispatchNewTask.mockReset();
    mockDispatchNewTask.mockResolvedValue(undefined);
    mockAppendPrActivity.mockReset();
    mockAppendPrActivity.mockResolvedValue(undefined);
    mockPickReviewerRole.mockReset();
    mockPickReviewerRole.mockReturnValue({ role: 'reviewer', source: 'policy' });
    mockListWorkspaceRoles.mockReset();
    mockListWorkspaceRoles.mockResolvedValue([{ slug: 'reviewer', isRole: true }]);

    // Restore default chain mock for update
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Object.assign(Promise.resolve([]), { returning: () => Promise.resolve([]) })),
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

  it("refuses a per-task token for a team worker that is not its own", async () => {
    const scoped = { ...ACCOUNT, level: 'worker', taskScope: { taskId: 'task-own', expiresAt: Date.now() + 60_000 } };
    mockAuthenticateApiKey.mockResolvedValue(scoped);
    // Same team (so an account key would pass), but another account's worker...
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1', accountId: 'account-2', taskId: 'task-own', name: 'test-worker', workspace: WORKSPACE_OK,
    });
    const body = { workerId: 'w-1', title: 'My PR', head: 'feature-branch' };
    let res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body }));
    expect(res.status).toBe(403);
    // ...or its own account's worker on another task.
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1', accountId: 'account-1', taskId: 'task-other', name: 'test-worker', workspace: WORKSPACE_OK,
    });
    res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body }));
    expect(res.status).toBe(403);
  });

  // A shared runner on its own team reaches this workspace through a claim
  // grant; the claim path honours it, so create_pr must too.
  it('lets the cross-team account running the worker through while it holds a claim grant', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockGetAccountWorkspacePermissions.mockResolvedValueOnce([{ workspaceId: 'ws-other', canClaim: true, canCreate: false }]);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      workspaceId: 'ws-other',
      name: 'test-worker',
      workspace: WORKSPACE_OTHER_TEAM,
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'feature-branch' },
    });
    const res = await POST(req);

    expect(res.status).not.toBe(403);
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

  // ── Option A′: derive, don't accept (P1) ────────────────────────────────
  //
  // Once a mission has an integration base, the server already knows the
  // correct head (the worker's own branch) and base (the integration branch)
  // — a caller-supplied value is checked against the derivation, not trusted.
  describe('Option A′ — derive, don’t accept (P1)', () => {
    const INTEGRATION_BRANCH = 'mission/checkout-arc-1a2b3c4d';
    const WORKER_BRANCH = 'buildd/t-1-do-thing';

    function taskWorker(overrides: Record<string, any> = {}) {
      return {
        id: 'w-1',
        accountId: 'account-1',
        name: 'test-worker',
        branch: WORKER_BRANCH,
        // The FK column, not just the joined row — the guarded `kind` stamp
        // keys on workers.task_id, which a real row always carries.
        taskId: 't-1',
        workspace: { ...WORKSPACE_OK, gitConfig: { defaultBranch: 'dev' } },
        task: { id: 't-1', missionId: 'obj-1', title: 'Do thing', taskClass: 'work', context: null },
        ...overrides,
      };
    }

    function optedInMission(overrides: Record<string, any> = {}) {
      mockMissionsFindFirst.mockResolvedValue({
        workingBranch: INTEGRATION_BRANCH,
        integrationBranchEnabled: true,
        ...overrides,
      });
    }

    function noExistingPr() {
      // Dedup-by-head GET call, hit before the derive/refuse checks.
      mockGithubApi.mockResolvedValueOnce([]);
    }

    it('refuses a caller-supplied base that disagrees with the integration base', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      noExistingPr();

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'My PR', head: WORKER_BRANCH, base: 'dev' },
      });
      const res = await POST(req);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain(INTEGRATION_BRANCH);
      expect(mockGithubApi).not.toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.objectContaining({ method: 'POST' }),
      );
    });

    it('accepts a caller base that agrees with the integration base', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      noExistingPr();
      mockGithubApi.mockResolvedValueOnce({ number: 42, html_url: 'https://github.com/owner/repo/pull/42', state: 'open', title: 'My PR' });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'My PR', head: WORKER_BRANCH, base: INTEGRATION_BRANCH },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
    });

    it('derives the base when the caller omits it entirely', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      noExistingPr();
      mockGithubApi.mockResolvedValueOnce({ number: 42, html_url: 'https://github.com/owner/repo/pull/42', state: 'open', title: 'My PR' });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'My PR', head: WORKER_BRANCH },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      const createCall = mockGithubApi.mock.calls.find((c: any[]) => c[2]?.method === 'POST');
      expect(createCall).toBeDefined();
      const body = JSON.parse((createCall as any[])[2].body);
      expect(body.base).toBe(INTEGRATION_BRANCH);
    });

    // Regression (mission 6341fe61): a task with NO missionId whose context
    // still carries the mission branch as baseBranch. The integration guard
    // never runs, the base resolves from task context to a ref that was never
    // created, and GitHub's bare 422 used to come back as a 500.
    it('turns a non-existent base into an actionable 400 and traces a missing mission branch', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker({
        workspaceId: 'ws-1',
        task: { id: 't-1', missionId: null, title: 'Do thing', taskClass: 'work', context: { baseBranch: INTEGRATION_BRANCH } },
      }));
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      mockMissionsFindFirst.mockResolvedValue(null);
      mockReportMissionBranchUnresolved.mockClear();
      noExistingPr();
      mockGithubApi.mockImplementationOnce((() => Promise.reject(new Error(
        'GitHub API error: 422 {"message":"Validation Failed","errors":[{"resource":"PullRequest","field":"base","code":"invalid"}]}',
      ))) as any);

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'My PR', head: WORKER_BRANCH },
      }));

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain(`'${INTEGRATION_BRANCH}' does not exist`);
      expect(data.hint).toContain("base='dev'");
      expect(mockReportMissionBranchUnresolved).toHaveBeenCalledTimes(1);
      expect((mockReportMissionBranchUnresolved.mock.calls[0] as any[])[0]).toMatchObject({
        branch: INTEGRATION_BRANCH, where: 'create_pr', cause: 'missing', workerId: 'w-1',
      });
    });

    it('refuses a caller-supplied head that disagrees with the worker’s own branch', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      noExistingPr();

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'My PR', head: 'some-other-branch' },
      });
      const res = await POST(req);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain(WORKER_BRANCH);
    });

    it('allows the mission-PR owner to open head=integration-branch, base=trunk', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker({
        branch: INTEGRATION_BRANCH,
        task: { id: 't-own', missionId: 'obj-1', title: `${MISSION_PR_TASK_PREFIX}Checkout arc`, taskClass: 'bookkeeping', context: null },
      }));
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      noExistingPr();
      mockGithubApi.mockResolvedValueOnce({ number: 42, html_url: 'https://github.com/owner/repo/pull/42', state: 'open', title: 'Checkout arc' });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'Checkout arc', head: INTEGRATION_BRANCH, base: 'dev' },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
    });

    it('is unaffected for a task with no mission — explicit head/base pass through', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker({ task: { id: 't-1', missionId: null, title: 'Do thing', taskClass: 'work', context: null } }));
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      noExistingPr();
      mockGithubApi.mockResolvedValueOnce({ number: 42, html_url: 'https://github.com/owner/repo/pull/42', state: 'open', title: 'My PR' });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'My PR', head: 'some-other-branch', base: 'dev' },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
    });

    it('is unaffected for a mission with no integration base — explicit base passes through', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission({ integrationBranchEnabled: false });
      noExistingPr();
      mockGithubApi.mockResolvedValueOnce({ number: 42, html_url: 'https://github.com/owner/repo/pull/42', state: 'open', title: 'My PR' });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'My PR', head: 'some-other-branch', base: 'dev' },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
    });

    // ── Part 2: the integration branch is already GONE ────────────────────
    //
    // The production dead end. A mission PR merged while later-filed work was
    // still pending, which deleted the integration branch by design. Every
    // worker that then claimed one of those tasks found both doors shut: this
    // route refused trunk because the mission has an integration base, and
    // GitHub refused the derived base with a 422 because it no longer exists.
    // No route out from inside a worker, and no owner in the loop.

    it('consults the live branch check for a mission task, then proceeds on the re-cut branch', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      noExistingPr();
      mockEnsureIntegrationBaseForTaskPr.mockResolvedValue({ usable: true, recreated: true });
      mockGithubApi.mockResolvedValueOnce({ number: 42, html_url: 'https://github.com/owner/repo/pull/42', state: 'open', title: 'My PR' });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'My PR', head: WORKER_BRANCH },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockEnsureIntegrationBaseForTaskPr).toHaveBeenCalledWith(
        expect.objectContaining({ missionId: 'obj-1', integrationBase: INTEGRATION_BRANCH }),
      );
      const createCall = mockGithubApi.mock.calls.find((c: any[]) => c[2]?.method === 'POST');
      const body = JSON.parse((createCall as any[])[2].body);
      expect(body.base).toBe(INTEGRATION_BRANCH);
    });

    it('opens the PR against trunk instead of dead-ending when the branch cannot be restored', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      noExistingPr();
      mockEnsureIntegrationBaseForTaskPr.mockResolvedValue({ usable: false, recreated: false, detail: 'api_error' });
      mockGithubApi.mockResolvedValueOnce({ number: 42, html_url: 'https://github.com/owner/repo/pull/42', state: 'open', title: 'My PR' });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'My PR', head: WORKER_BRANCH },
      });
      const res = await POST(req);

      // The PR is delivered — not a 400 and not a 500 on a base that 404s.
      expect(res.status).toBe(200);
      const createCall = mockGithubApi.mock.calls.find((c: any[]) => c[2]?.method === 'POST');
      const body = JSON.parse((createCall as any[])[2].body);
      expect(body.base).toBe('dev');
    });

    it('stops refusing an explicit trunk base once the integration branch is unrecoverable', async () => {
      // This exact 400 is what three workers hit in production: they were told
      // by their own prompt to target trunk, and refused for naming it.
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      noExistingPr();
      mockEnsureIntegrationBaseForTaskPr.mockResolvedValue({ usable: false, recreated: false });
      mockGithubApi.mockResolvedValueOnce({ number: 42, html_url: 'https://github.com/owner/repo/pull/42', state: 'open', title: 'My PR' });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'My PR', head: WORKER_BRANCH, base: 'dev' },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      const createCall = mockGithubApi.mock.calls.find((c: any[]) => c[2]?.method === 'POST');
      const body = JSON.parse((createCall as any[])[2].body);
      expect(body.base).toBe('dev');
    });

    it('does not touch the branch check for a task with no mission integration base', async () => {
      // One extra GitHub round-trip per PR is cheap; one per PR for every
      // workspace that never opted into A′ is not.
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker({ task: { id: 't-1', missionId: null, title: 'Do thing', taskClass: 'work', context: null } }));
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      noExistingPr();
      mockGithubApi.mockResolvedValueOnce({ number: 42, html_url: 'https://github.com/owner/repo/pull/42', state: 'open', title: 'My PR' });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'My PR', head: WORKER_BRANCH },
      });
      await POST(req);

      expect(mockEnsureIntegrationBaseForTaskPr).not.toHaveBeenCalled();
    });

    it('respects a stacked-phase task’s predecessor base instead of forcing the integration branch', async () => {
      const predecessorBranch = 'buildd/predecessor00-earlier-thing';
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker({
        task: { id: 't-2', missionId: 'obj-1', title: 'Second phase', taskClass: 'work', context: { baseBranch: predecessorBranch } },
      }));
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      noExistingPr();
      mockGithubApi.mockResolvedValueOnce({ number: 42, html_url: 'https://github.com/owner/repo/pull/42', state: 'open', title: 'My PR' });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'My PR', head: WORKER_BRANCH },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      const createCall = mockGithubApi.mock.calls.find((c: any[]) => c[2]?.method === 'POST');
      const body = JSON.parse((createCall as any[])[2].body);
      expect(body.base).toBe(predecessorBranch);
    });

    it('resolves a recovery task (context.baseBranch === head) to the integration base', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker({
        task: { id: 't-1', missionId: 'obj-1', title: 'Do thing', taskClass: 'work', context: { baseBranch: WORKER_BRANCH } },
      }));
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      noExistingPr();
      mockGithubApi.mockResolvedValueOnce({ number: 42, html_url: 'https://github.com/owner/repo/pull/42', state: 'open', title: 'My PR' });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'My PR', head: WORKER_BRANCH },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      const createCall = mockGithubApi.mock.calls.find((c: any[]) => c[2]?.method === 'POST');
      const body = JSON.parse((createCall as any[])[2].body);
      expect(body.base).toBe(INTEGRATION_BRANCH);
    });
  });

  // ── Option A′: adoption legality gate (P2a) ─────────────────────────────
  describe('adoption (prUrl) — mission-integration legality gate (P2a)', () => {
    const INTEGRATION_BRANCH = 'mission/checkout-arc-1a2b3c4d';

    function taskWorker(overrides: Record<string, any> = {}) {
      return {
        id: 'w-1',
        accountId: 'account-1',
        name: 'test-worker',
        branch: 'buildd/t-1-do-thing',
        workspace: { ...WORKSPACE_OK, gitConfig: { defaultBranch: 'dev' } },
        task: { id: 't-1', missionId: 'obj-1', title: 'Do thing', taskClass: 'work', context: null },
        ...overrides,
      };
    }

    function optedInMission(overrides: Record<string, any> = {}) {
      mockMissionsFindFirst.mockResolvedValue({
        workingBranch: INTEGRATION_BRANCH,
        integrationBranchEnabled: true,
        ...overrides,
      });
    }

    it('refuses adoption of an out-of-band PR based on trunk instead of the integration branch', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      optedInMission();

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workerId: 'w-1', title: 'My PR', head: 'buildd/t-1-do-thing',
          base: 'dev', prUrl: 'https://github.com/owner/repo/pull/42',
        },
      });
      const res = await POST(req);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain(INTEGRATION_BRANCH);
    });

    it('refuses adoption when the claimed base is omitted entirely', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      optedInMission();

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'My PR', head: 'buildd/t-1-do-thing', prUrl: 'https://github.com/owner/repo/pull/42' },
      });
      const res = await POST(req);

      expect(res.status).toBe(400);
    });

    it('adopts when the claimed base matches the integration branch', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      optedInMission();

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workerId: 'w-1', title: 'My PR', head: 'buildd/t-1-do-thing',
          base: INTEGRATION_BRANCH, prUrl: 'https://github.com/owner/repo/pull/42',
        },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
    });

    it('is unaffected when the mission has no integration base', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      optedInMission({ integrationBranchEnabled: false });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workerId: 'w-1', title: 'My PR', head: 'buildd/t-1-do-thing',
          base: 'dev', prUrl: 'https://github.com/owner/repo/pull/42',
        },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
    });

    it('allows adoption of the mission PR itself (head=integration branch, base=trunk)', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker({
        task: { id: 't-own', missionId: 'obj-1', title: `${MISSION_PR_TASK_PREFIX}Checkout arc`, taskClass: 'bookkeeping', context: null },
      }));
      optedInMission();

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workerId: 'w-1', title: 'Checkout arc', head: INTEGRATION_BRANCH,
          base: 'dev', prUrl: 'https://github.com/owner/repo/pull/42',
        },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
    });

    // The claimed base is a sentence about a PR buildd never opened. When the
    // workspace has an installation we can read the PR itself, and the PR wins.
    it('verifies the real base against GitHub instead of trusting the claim', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      // The real PR is based on trunk, whatever the caller says.
      mockGithubApi.mockResolvedValueOnce({ number: 42, base: { ref: 'dev' } });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workerId: 'w-1', title: 'My PR', head: 'buildd/t-1-do-thing',
          base: INTEGRATION_BRANCH, prUrl: 'https://github.com/owner/repo/pull/42',
        },
      });
      const res = await POST(req);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain(INTEGRATION_BRANCH);
      expect(data.error).toContain('#42');
    });

    it('adopts when GitHub confirms the base is the integration branch', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      mockGithubApi.mockResolvedValueOnce({ number: 42, base: { ref: INTEGRATION_BRANCH } });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workerId: 'w-1', title: 'My PR', head: 'buildd/t-1-do-thing',
          base: 'dev', prUrl: 'https://github.com/owner/repo/pull/42',
        },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
    });
  });

  // A worker's stored prUrl/prNumber must never outrank a prUrl the caller
  // explicitly supplies in THIS request — regression for a friction report
  // where a worker with a stale/wrong PR already recorded kept getting that
  // same stale PR back from every subsequent create_pr call, even when the
  // caller passed a different, freshly-created prUrl to correct it.
  describe('adoption (prUrl) — caller-supplied prUrl overrides a stale stored one', () => {
    it('returns the stored PR unchanged when the caller re-asserts the same prUrl (idempotent retry)', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue({
        id: 'w-1',
        accountId: 'account-1',
        name: 'test-worker',
        prUrl: 'https://github.com/owner/repo/pull/42',
        prNumber: 42,
        workspace: WORKSPACE_OK,
      });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workerId: 'w-1', title: 'My PR', head: 'feature-branch',
          prUrl: 'https://github.com/owner/repo/pull/42',
        },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.deduplicated).toBe(true);
      expect(data.pr.number).toBe(42);
      expect(data.pr.url).toBe('https://github.com/owner/repo/pull/42');
      // Same PR re-asserted — no GitHub call needed.
      expect(mockGithubApi).not.toHaveBeenCalled();
    });

    it('registers the new PR when the caller supplies a different prUrl than what is stored', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue({
        id: 'w-1',
        accountId: 'account-1',
        name: 'test-worker',
        taskId: 't-1',
        // Stale PR from an earlier, unrelated call — this is what a caller
        // must be able to correct via an explicit prUrl.
        prUrl: 'https://github.com/other-org/infrastructure/pull/4',
        prNumber: 4,
        workspace: WORKSPACE_OK,
      });

      // Multiple db.update calls happen in this flow (the PR record itself,
      // plus the best-effort task-kind stamp), so every `set()` payload is
      // captured rather than just the last one.
      const capturedSetDatas: any[] = [];
      mockWorkersUpdate.mockReturnValue({
        set: mock((data: any) => {
          capturedSetDatas.push(data);
          return { where: mock(() => Object.assign(Promise.resolve([]), { returning: () => Promise.resolve([]) })) };
        }),
      });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workerId: 'w-1', title: 'My PR', head: 'feature-branch',
          prUrl: 'https://github.com/owner/repo/pull/2600',
        },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      // The caller's explicit correction wins — not the stale stored PR, and
      // not silently marked as a dedup.
      expect(data.deduplicated).toBeUndefined();
      expect(data.pr.number).toBe(2600);
      expect(data.pr.url).toBe('https://github.com/owner/repo/pull/2600');
      const prUpdate = capturedSetDatas.find((d) => d.prUrl);
      expect(prUpdate?.prUrl).toBe('https://github.com/owner/repo/pull/2600');
      expect(prUpdate?.prNumber).toBe(2600);
    });
  });

  // ── Option A′: the dedup-by-head door ───────────────────────────────────
  //
  // `create_pr` adopts a PR that already exists for the worker's branch and
  // returns 200 long before the derive-don't-accept checks run. That is the
  // exact shape of `gh pr create --base dev` followed by `create_pr`: buildd
  // never chose the base, so it has to check the one GitHub reports.
  describe('dedup-by-head adoption — mission-integration legality gate', () => {
    const INTEGRATION_BRANCH = 'mission/checkout-arc-1a2b3c4d';
    const WORKER_BRANCH = 'buildd/t-1-do-thing';

    function taskWorker(overrides: Record<string, any> = {}) {
      return {
        id: 'w-1',
        accountId: 'account-1',
        name: 'test-worker',
        branch: WORKER_BRANCH,
        // The FK column, not just the joined row — the guarded `kind` stamp
        // keys on workers.task_id, which a real row always carries.
        taskId: 't-1',
        workspace: { ...WORKSPACE_OK, gitConfig: { defaultBranch: 'dev' } },
        task: { id: 't-1', missionId: 'obj-1', title: 'Do thing', taskClass: 'work', context: null },
        ...overrides,
      };
    }

    function optedInMission(overrides: Record<string, any> = {}) {
      mockMissionsFindFirst.mockResolvedValue({
        workingBranch: INTEGRATION_BRANCH,
        integrationBranchEnabled: true,
        ...overrides,
      });
    }

    /** An open PR already exists for the worker's branch, based on `baseRef`. */
    function existingPrOnHead(baseRef: string | null) {
      const pr = {
        number: 77,
        html_url: 'https://github.com/owner/repo/pull/77',
        state: 'open',
        title: 'Opened out of band',
        base: baseRef ? { ref: baseRef, sha: 'base-sha' } : undefined,
      };
      mockGithubApi.mockResolvedValueOnce([pr]);   // dedup list call
      mockGithubApi.mockResolvedValueOnce(pr);     // per-PR detail call
    }

    it('refuses to adopt a PR that already exists on the branch but targets trunk', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      existingPrOnHead('dev');

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'My PR', head: WORKER_BRANCH },
      });
      const res = await POST(req);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain(INTEGRATION_BRANCH);
      expect(data.error).toContain('#77');
      expect(data.hint).toContain(INTEGRATION_BRANCH);
    });

    it('refuses when GitHub reports no base ref at all', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      existingPrOnHead(null);

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'My PR', head: WORKER_BRANCH },
      });
      const res = await POST(req);

      expect(res.status).toBe(400);
    });

    it('adopts the existing PR when it is based on the integration branch', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      existingPrOnHead(INTEGRATION_BRANCH);

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'My PR', head: WORKER_BRANCH },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.deduplicated).toBe(true);
      expect(data.pr.number).toBe(77);
    });

    it('is unaffected for a task with no mission', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker({
        task: { id: 't-1', missionId: null, title: 'Do thing', taskClass: 'work', context: null },
      }));
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      existingPrOnHead('dev');

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'My PR', head: WORKER_BRANCH },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
    });

    it('lets the mission-PR owner adopt its own trunk-based PR', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker({
        branch: INTEGRATION_BRANCH,
        task: { id: 't-own', missionId: 'obj-1', title: `${MISSION_PR_TASK_PREFIX}Checkout arc`, taskClass: 'bookkeeping', context: null },
      }));
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      existingPrOnHead('dev');

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'Checkout arc', head: INTEGRATION_BRANCH },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
    });
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
    // The lede now leads the body; the agent's own text follows it verbatim.
    expect(extractLede(parsedBody.body)?.rest).toBe('Custom body');
  });

  describe('task-sibling dedup is per head branch', () => {
    const firstPr = {
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      taskId: 't-1',
      branch: 'first-branch',
      prUrl: 'https://github.com/owner/repo/pull/3193',
      prNumber: 3193,
      workspace: { ...WORKSPACE_OK },
    };

    it('opens a second PR when the task already has an open PR from a different head', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(firstPr);
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      mockGithubApi.mockResolvedValue({
        number: 3195,
        html_url: 'https://github.com/owner/repo/pull/3195',
        state: 'open',
        title: 'Second PR',
      });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'Second PR', head: 'second-branch', base: 'other-base' },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.deduplicated).toBeUndefined();
      expect(data.pr.number).toBe(3195);
      const createCall = mockGithubApi.mock.calls.find((c) => c[2]?.method === 'POST');
      expect(JSON.parse((createCall as any[])[2].body).head).toBe('second-branch');
    });

    it('still dedups to the task PR when the head is the same branch', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(firstPr);

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'First PR', head: 'first-branch' },
      });
      const res = await POST(req);

      const data = await res.json();
      expect(data.deduplicated).toBe(true);
      expect(data.pr.number).toBe(3193);
      expect(mockGithubApi).not.toHaveBeenCalled();
    });
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
    expect(extractLede(parsedBody.body)?.rest).toBe('Created by buildd worker test-worker');
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
        return { where: mock(() => Object.assign(Promise.resolve([]), { returning: () => Promise.resolve([]) })) };
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

  // TERMINAL_PR_LIFECYCLE: an `unresolvable` PR is as dead as a closed one —
  // echoing it back as the worker's open PR repeats a PR nothing can resolve.
  it('does not deduplicate a stored PR whose lifecycle is unresolvable', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      prUrl: 'https://github.com/owner/repo/pull/99',
      prNumber: 99,
      prLifecycleStatus: 'unresolvable',
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValueOnce([]);
    mockGithubApi.mockResolvedValueOnce({
      number: 100,
      html_url: 'https://github.com/owner/repo/pull/100',
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
    expect(data.deduplicated).toBeUndefined();
    expect(mockGithubApi).toHaveBeenCalled();
  });

  // Regression: a worker whose earlier PR (#3070) had already merged called
  // create_pr again with a new head branch. The dedup fast path used to
  // return the stored prUrl/prNumber unconditionally, echoing the merged PR
  // back as 'state: open' and never opening anything for the new head.
  it('does not deduplicate a stored PR that is already merged — opens a new PR for the new head', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      branch: 'buildd/old-task-old-branch',
      prUrl: 'https://github.com/owner/repo/pull/3070',
      prNumber: 3070,
      mergedAt: new Date('2026-09-01T00:00:00Z'),
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    // Dedup-by-head check: nothing open yet for the new head.
    mockGithubApi.mockResolvedValueOnce([]);
    // Creation succeeds against the new head.
    mockGithubApi.mockResolvedValueOnce({
      number: 3080,
      html_url: 'https://github.com/owner/repo/pull/3080',
      state: 'open',
      title: 'My PR',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'buildd/new-task-new-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.deduplicated).toBeUndefined();
    expect(data.pr.number).toBe(3080);
    expect(data.pr.url).toBe('https://github.com/owner/repo/pull/3080');
    // Must have actually gone to GitHub instead of echoing the stale PR back.
    expect(mockGithubApi).toHaveBeenCalled();
  });

  // Same root cause, narrower trigger: the stored PR isn't known merged, but
  // it belongs to a different branch than the one the caller is asking about
  // now — still not a valid dedup target for this request.
  it('does not deduplicate a stored PR whose branch differs from the requested head', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      name: 'test-worker',
      branch: 'buildd/old-task-old-branch',
      prUrl: 'https://github.com/owner/repo/pull/3070',
      prNumber: 3070,
      workspace: WORKSPACE_OK,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValueOnce([]);
    mockGithubApi.mockResolvedValueOnce({
      number: 3080,
      html_url: 'https://github.com/owner/repo/pull/3080',
      state: 'open',
      title: 'My PR',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'My PR', head: 'buildd/new-task-new-branch' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deduplicated).toBeUndefined();
    expect(data.pr.number).toBe(3080);
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
    // Third call: per-file breakdown for the reviewable/generated split.
    mockGithubApi.mockResolvedValueOnce([
      { filename: 'apps/web/src/lib/foo.ts', additions: 807, deletions: 12 },
    ]);

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
    // Should have called githubApi three times: list check + individual PR
    // fetch for stats + per-file breakdown for the reviewable/generated split.
    expect(mockGithubApi).toHaveBeenCalledTimes(3);
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
    // Third call: per-file breakdown for the reviewable/generated split.
    mockGithubApi.mockResolvedValueOnce([
      { filename: 'apps/web/src/lib/foo.ts', additions: 807, deletions: 0 },
      { filename: 'apps/web/src/lib/foo.test.ts', additions: 0, deletions: 23 },
    ]);

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
    expect(capturedSetData.filesChanged).toBe(2);
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
    // Third call: per-file breakdown for the reviewable/generated split.
    mockGithubApi.mockResolvedValueOnce([
      { filename: 'apps/web/src/lib/foo.ts', additions: 150, deletions: 0 },
      { filename: 'apps/web/src/lib/foo.test.ts', additions: 0, deletions: 8 },
    ]);

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
    expect(capturedSetData.filesChanged).toBe(2);
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
      branch: 'buildd/taskshare-fix',
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
      branch: 'buildd/taskshare-fix',
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
      branch: 'buildd/taskshare-fix',
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
      branch: 'buildd/taskshare-fix',
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

  // ── Auto-review for task PRs into mission integration branches ──────────
  //
  // A manual-orchestration mission has no heartbeat loop to notice a task PR
  // sitting open on its integration branch — this fires the review request at
  // the moment the PR lands instead. It reuses `missionBaseGuard.enforced`
  // (Option A′), so it only ever fires for exactly the PRs whose base was
  // just derived to the integration branch above.
  describe('auto-review for mission task PRs into the integration branch', () => {
    const INTEGRATION_BRANCH = 'mission/test-mission-1a2b3c4d';
    const WORKER_BRANCH = 'buildd/t-1-do-thing';
    const MISSION_TASK = {
      id: 't-1',
      title: 'Do thing',
      description: 'Task description',
      backend: 'claude' as const,
      missionId: 'mission-1',
      pathManifest: null,
      taskClass: 'work',
      context: null,
    };

    function taskWorker(overrides: Record<string, any> = {}) {
      return {
        id: 'w-1',
        accountId: 'account-1',
        name: 'test-worker',
        branch: WORKER_BRANCH,
        // The FK column, not just the joined row — the guarded `kind` stamp
        // keys on workers.task_id, which a real row always carries.
        taskId: MISSION_TASK.id,
        workspace: WORKSPACE_OK,
        task: MISSION_TASK,
        ...overrides,
      };
    }

    function optedInMission(overrides: Record<string, any> = {}) {
      mockMissionsFindFirst.mockResolvedValue({
        workingBranch: INTEGRATION_BRANCH,
        integrationBranchEnabled: true,
        ...overrides,
      });
    }

    function noExistingPr() {
      mockGithubApi.mockResolvedValueOnce([]);
    }

    it('requests review for a fresh task PR into the integration branch', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      noExistingPr();
      mockGithubApi.mockResolvedValueOnce({
        number: 42,
        html_url: 'https://github.com/owner/repo/pull/42',
        state: 'open',
        title: 'Do thing',
        base: { ref: INTEGRATION_BRANCH, sha: 'basesha' },
        head: { sha: 'headsha' },
      });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'Do thing', head: WORKER_BRANCH },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).toHaveBeenCalled();
      expect(mockDispatchNewTask).toHaveBeenCalled();
      const createArgs = mockCreateReviewerTask.mock.calls[0][0];
      expect(createArgs.prNumber).toBe(42);
      expect(createArgs.headSha).toBe('headsha');
    });

    it('creates the review pass EXACTLY once — the PR-open hook is the only trigger', async () => {
      // mission-legibility.md Rule R3-4: the programmatic review pass for a
      // builder task that opens a PR is the existing agent-review tier fired
      // here. No second trigger is designed, and none is needed — any new one
      // would race this through the same dedupe.
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      noExistingPr();
      mockGithubApi.mockResolvedValueOnce({
        number: 42,
        html_url: 'https://github.com/owner/repo/pull/42',
        state: 'open',
        title: 'Do thing',
        base: { ref: INTEGRATION_BRANCH, sha: 'basesha' },
        head: { sha: 'headsha' },
      });

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'Do thing', head: WORKER_BRANCH },
      }));

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
      expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
    });

    it('Rule K2-19: opening a PR stamps kind=engineering, guarded on kind IS NULL', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      noExistingPr();
      mockGithubApi.mockResolvedValueOnce({
        number: 42,
        html_url: 'https://github.com/owner/repo/pull/42',
        state: 'open',
        title: 'Do thing',
        base: { ref: INTEGRATION_BRANCH, sha: 'basesha' },
        head: { sha: 'headsha' },
      });

      const setCalls: any[] = [];
      const whereCalls: any[] = [];
      mockWorkersUpdate.mockReturnValue({
        set: mock((data: any) => {
          setCalls.push(data);
          return {
            where: mock((w: any) => {
              whereCalls.push(w);
              return Object.assign(Promise.resolve([]), { returning: () => Promise.resolve([]) });
            }),
          };
        }),
      });

      expect((await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'Do thing', head: WORKER_BRANCH },
      }))).status).toBe(200);

      const kindWrite = setCalls.findIndex(c => c.kind === 'engineering');
      expect(kindWrite).toBeGreaterThanOrEqual(0);
      // AC-12: the late signal never overwrites a declared kind, so the write
      // carries an IS NULL guard rather than keying on the task id alone.
      const hasIsNull = (node: any, seen = new Set()): boolean => {
        if (!node || typeof node !== 'object' || seen.has(node)) return false;
        seen.add(node);
        if (node.type === 'isNull') return true;
        return Object.values(node).some(v => hasIsNull(v, seen));
      };
      expect(hasIsNull(whereCalls[kindWrite])).toBe(true);
    });

    it('does not request a review for a draft PR', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      noExistingPr();
      mockGithubApi.mockResolvedValueOnce({
        number: 42,
        html_url: 'https://github.com/owner/repo/pull/42',
        state: 'open',
        title: 'Do thing',
        base: { ref: INTEGRATION_BRANCH, sha: 'basesha' },
        head: { sha: 'headsha' },
      });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'Do thing', head: WORKER_BRANCH, draft: true },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
    });

    it('does not request a review for the mission-PR owner itself', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker({
        branch: INTEGRATION_BRANCH,
        task: { ...MISSION_TASK, title: `${MISSION_PR_TASK_PREFIX}Test mission`, taskClass: 'bookkeeping' },
      }));
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      noExistingPr();
      mockGithubApi.mockResolvedValueOnce({
        number: 42,
        html_url: 'https://github.com/owner/repo/pull/42',
        state: 'open',
        title: 'Test mission',
        base: { ref: 'dev', sha: 'basesha' },
        head: { sha: 'headsha' },
      });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'Test mission', head: INTEGRATION_BRANCH, base: 'dev' },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
    });

    it('does not stack a second reviewer when one is already in flight', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker());
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      noExistingPr();
      mockGithubApi.mockResolvedValueOnce({
        number: 42,
        html_url: 'https://github.com/owner/repo/pull/42',
        state: 'open',
        title: 'Do thing',
        base: { ref: INTEGRATION_BRANCH, sha: 'basesha' },
        head: { sha: 'headsha' },
      });
      mockFindLiveReviewerTaskForHead.mockResolvedValue({ id: 'existing-reviewer-task' });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', title: 'Do thing', head: WORKER_BRANCH },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
    });

    it('requests review when adopting a prUrl already based on the integration branch', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue(taskWorker({ prUrl: null, prNumber: null }));
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      optedInMission();
      mockGithubApi.mockResolvedValueOnce({
        number: 42,
        html_url: 'https://github.com/owner/repo/pull/42',
        state: 'open',
        title: 'Do thing',
        base: { ref: INTEGRATION_BRANCH },
        head: { sha: 'headsha' },
        draft: false,
      });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workerId: 'w-1',
          title: 'Do thing',
          head: WORKER_BRANCH,
          base: INTEGRATION_BRANCH,
          prUrl: 'https://github.com/owner/repo/pull/42',
        },
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).toHaveBeenCalled();
      expect(mockDispatchNewTask).toHaveBeenCalled();
    });
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
    mockTasksFindMany.mockReset();
    mockTasksFindMany.mockResolvedValue([]);
    mockMissionsFindFirst.mockResolvedValue(null);
    mockReadPrReviewStatus.mockReset();
    mockReadPrReviewStatus.mockResolvedValue({
      state: 'not_requested', terminal: true, reviewTaskId: null, adoptedTaskId: null,
      verdict: null, confidence: null, summary: null, feedback: null, escalationReason: null,
      iteration: null, maxIterations: null, prState: 'open', merged: false, mergeBlocked: null,
    } as any);
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

    it('does not mark the worker merged when a push races the policy checks', async () => {
      workerOk();
      mockMergePullRequest.mockImplementation(async (...args: any[]) =>
        args[4] === 'sha-42'
          ? { merged: false, message: 'Head branch was modified', status: 409 }
          : { merged: true, message: 'merged unchecked head' });
      mockWorkersUpdate.mockClear();
      const res = await put();
      expect((await res.json()).merged).toBe(false);
      expect(mockWorkersUpdate).not.toHaveBeenCalled();
    });

    describe('landing function (gitConfig.landing.mode=enforce)', () => {
      const ENFORCE = { landing: { mode: 'enforce' } };
      function enforceWorker(mergePolicy: Record<string, unknown>) {
        workerOk();
        mockWorkersFindFirst.mockResolvedValue({
          id: 'w-1', accountId: 'account-1', taskId: 'task-1', prUrl: 'https://github.com/owner/repo/pull/42',
          workspace: { ...WORKSPACE_OK, id: 'ws-1', gitConfig: { mergePolicy, ...ENFORCE } },
        });
      }
      beforeEach(() => {
        mockLandPr.mockReset();
        mockLandPr.mockImplementation(async () => ({ kind: 'waiting_ci', headSha: 'sha-42' }));
      });

      it('a stored terminal approve under agent-review is accepted (landPr decides), not refused on tier', async () => {
        enforceWorker({ tier: 'agent-review', agentReview: { reviewerRole: 'reviewer', maxConfidenceThreshold: 0.6 } });
        mockReadPrReviewStatus.mockResolvedValue({
          state: 'approved', terminal: true, reviewTaskId: 't1', adoptedTaskId: 'task-1',
          verdict: 'approve', confidence: 0.96, summary: 'ok', feedback: null, escalationReason: null,
          iteration: 0, maxIterations: 3, prState: 'open', merged: false, mergeBlocked: null,
        } as any);
        mockLandPr.mockImplementation(async () => ({ kind: 'merged', sha: 'merge-sha' }));
        mockWorkersUpdate.mockClear();

        const res = await put();

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.merged).toBe(true);
        expect(mockLandPr).toHaveBeenCalledTimes(1);
        expect(mockLandPr.mock.calls[0]![0]).toMatchObject({
          workspaceId: 'ws-1', installationId: 12345, repoFullName: 'owner/repo', prNumber: 42,
          door: 'merge_pr', mode: 'enforce', actor: { kind: 'agent', workerId: 'w-1' },
          policy: { tier: 'agent-review' }, owner: { taskId: 'task-1', workerId: 'w-1' }, mergeMethod: 'squash',
        });
        // The merge is landPr's, never a second one from the route.
        expect(mockMergePullRequest).not.toHaveBeenCalled();
        expect(mockWorkersUpdate).toHaveBeenCalled();
      });

      it('behind base: the branch is refreshed with a marker; 202, nothing more asked of the caller', async () => {
        enforceWorker({ tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } });
        mockLandPr.mockImplementation(async () => ({ kind: 'updating_branch', newHeadSha: 'fresh-head-sha' }));

        const res = await put();

        expect(res.status).toBe(202);
        const data = await res.json();
        expect(data.merged).toBe(false);
        expect(data.branchUpdated).toBe(true);
        expect(data.hint).toContain('No further merge_pr call');
        expect(mockMergePullRequest).not.toHaveBeenCalled();
      });

      it('a human decision is a 403 naming the cause', async () => {
        enforceWorker({ tier: 'human' });
        mockLandPr.mockImplementation(async () => ({ kind: 'needs_human', cause: 'human_tier', reason: 'this workspace merges by human decision' }));

        const res = await put();

        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data.cause).toBe('human_tier');
        expect(data.error).toContain('human decision');
      });

      it('a fix in flight is a 409 naming the task', async () => {
        enforceWorker({ tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } });
        mockLandPr.mockImplementation(async () => ({ kind: 'needs_fix', fix: 'ci_fix', reason: 'CI red', taskId: 'fix-1' }));

        const res = await put();

        expect(res.status).toBe(409);
        expect((await res.json()).fixTaskId).toBe('fix-1');
      });

      it('admin force stays outside landPr', async () => {
        enforceWorker({ tier: 'human' });
        mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, level: 'admin' } as any);

        await PUT(createPutRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { workerId: 'w-1', prNumber: 42, force: true } }));

        expect(mockLandPr).not.toHaveBeenCalled();
      });

      it('shadow (the default) observes, then the legacy gates decide', async () => {
        workerOk();

        const res = await put();

        expect(mockLandPr).toHaveBeenCalledTimes(1);
        expect(mockLandPr.mock.calls[0]![0].mode).toBe('shadow');
        expect(res.status).toBe(200);
        expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
      });
    });

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

    function agentReviewWorker(agentReview: Record<string, unknown> = { reviewerRole: 'reviewer' }) {
      mockWorkersFindFirst.mockResolvedValue({
        id: 'w-1', accountId: 'account-1', taskId: 'task-1',
        workspace: { ...WORKSPACE_OK, id: 'ws-1', gitConfig: { mergePolicy: { tier: 'agent-review', agentReview } } },
      });
    }

    it("refuses under 'agent-review' when the reviewer requested changes", async () => {
      workerOk();
      agentReviewWorker();
      mockReadPrReviewStatus.mockResolvedValue({
        state: 'changes_requested', terminal: true, reviewTaskId: 't1', adoptedTaskId: 'task-1',
        verdict: 'request-changes', confidence: 0.9, summary: null, feedback: 'fix it', escalationReason: null,
        iteration: 1, maxIterations: 3, prState: 'open', merged: false, mergeBlocked: null,
      } as any);

      const res = await put();

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.tier).toBe('agent-review');
      expect(data.error).toContain('cannot be self-merged');
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it("refuses under 'agent-review' when the terminal approve is below the confidence threshold", async () => {
      workerOk();
      agentReviewWorker({ reviewerRole: 'reviewer', maxConfidenceThreshold: 0.8 });
      mockReadPrReviewStatus.mockResolvedValue({
        state: 'approved', terminal: true, reviewTaskId: 't1', adoptedTaskId: 'task-1',
        verdict: 'approve', confidence: 0.5, summary: 'looks ok', feedback: null, escalationReason: null,
        iteration: 0, maxIterations: 3, prState: 'open', merged: false, mergeBlocked: null,
      } as any);

      const res = await put();

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain('cannot be self-merged');
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it("refuses under 'agent-review' when an escalate path is touched, even with a terminal approve above threshold", async () => {
      workerOk();
      agentReviewWorker({ reviewerRole: 'reviewer', maxConfidenceThreshold: 0.6, escalateToPaths: ['packages/core/db/'] });
      mockReadPrReviewStatus.mockResolvedValue({
        state: 'approved', terminal: true, reviewTaskId: 't1', adoptedTaskId: 'task-1',
        verdict: 'approve', confidence: 0.95, summary: 'looks ok', feedback: null, escalationReason: null,
        iteration: 0, maxIterations: 3, prState: 'open', merged: false, mergeBlocked: null,
      } as any);
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

    it("succeeds under 'agent-review' on a terminal approve above the confidence threshold — the self-merge escape hatch", async () => {
      workerOk();
      agentReviewWorker({ reviewerRole: 'reviewer', maxConfidenceThreshold: 0.6 });
      mockReadPrReviewStatus.mockResolvedValue({
        state: 'approved', terminal: true, reviewTaskId: 't1', adoptedTaskId: 'task-1',
        verdict: 'approve', confidence: 0.96, summary: 'looks ok', feedback: null, escalationReason: null,
        iteration: 0, maxIterations: 3, prState: 'open', merged: false, mergeBlocked: null,
      } as any);

      const res = await put();

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.merged).toBe(true);
      expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
    });

    it('regression: a terminal approve with green CI and a mergeable PR reaches merged, not open', async () => {
      // Replays the deadlock this fix closes: a PR held a terminal approve well
      // above threshold, CI was fully green, and GitHub reported it mergeable —
      // yet under the old tier-only refusal it stayed open forever.
      workerOk();
      agentReviewWorker({ reviewerRole: 'reviewer', maxConfidenceThreshold: 0.6 });
      mockReadPrReviewStatus.mockResolvedValue({
        state: 'approved', terminal: true, reviewTaskId: 't1', adoptedTaskId: 'task-1',
        verdict: 'approve', confidence: 0.96, summary: 'clean diff', feedback: null, escalationReason: null,
        iteration: 0, maxIterations: 3, prState: 'open', merged: false, mergeBlocked: null,
      } as any);
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
          return Promise.resolve([{ filename: 'apps/web/src/lib/foo.ts', additions: 10, deletions: 2, status: 'modified' }]);
        }
        return Promise.resolve({ number: 42, head: { sha: 'sha-42' }, base: { ref: 'dev' }, mergeable_state: 'clean' });
      });
      mockMergePullRequest.mockResolvedValue({ merged: true, message: 'Pull request successfully merged' });

      const res = await put();

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.merged).toBe(true);
      expect(data.ok).toBe(true);
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

    // The friction behind PR #2658: an agent's merge_pr under concurrent landing
    // hits "PR is N commits behind dev" and had no recourse but a manual
    // rebase. The route now brings the branch up to date itself — but must NOT
    // merge in the same call: the update produces a new head whose CI has not
    // run, which is exactly what the freshness refusal exists to prevent.
    describe('behind base', () => {
      function behindGithub(updateBranch: () => Promise<unknown>) {
        const calls: string[] = [];
        mockGithubApi.mockImplementation((_inst: number, path: string, init?: any) => {
          calls.push(`${init?.method ?? 'GET'} ${path}`);
          if (/\/update-branch$/.test(path)) return updateBranch();
          if (/\/compare\//.test(path)) return Promise.resolve({ behind_by: 3 });
          if (/\/check-runs$/.test(path)) {
            return Promise.resolve({ check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] });
          }
          if (/\/files/.test(path)) {
            return Promise.resolve([{ filename: 'apps/web/src/lib/foo.ts', additions: 10, deletions: 2, status: 'modified' }]);
          }
          return Promise.resolve({ number: 42, head: { sha: 'sha-42' }, base: { ref: 'dev' }, mergeable_state: 'clean' });
        });
        return calls;
      }

      it('updates the branch from base and asks for a retry once CI re-runs, without merging', async () => {
        workerOk();
        const calls = behindGithub(() => Promise.resolve({ message: 'Updating pull request branch.' }));

        const res = await put();

        expect(res.status).toBe(409);
        const data = await res.json();
        expect(data.branchUpdated).toBe(true);
        expect(data.error).toContain('behind');
        expect(data.hint).toContain('merge_pr');
        expect(calls).toContain('PUT /repos/owner/repo/pulls/42/update-branch');
        expect(mockMergePullRequest).not.toHaveBeenCalled();
      });

      it('falls back to the 403 refusal when GitHub cannot update the branch', async () => {
        workerOk();
        behindGithub(() => Promise.reject(new Error('422 merge conflict between base and head')));

        const res = await put();

        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data.error).toContain('behind');
        expect(data.branchUpdated).toBeUndefined();
        expect(mockMergePullRequest).not.toHaveBeenCalled();
      });
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

    for (const preset of ['ci', 'runner'] as const) {
      it(`rejects force from a scoped ${preset} preset token: bypassing merge policy needs the admin scope`, async () => {
        workerOk();
        mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, level: 'admin', scopes: TOKEN_PRESETS[preset].scopes, workspaceIds: null });
        mockWorkersFindFirst.mockResolvedValue({
          id: 'w-1', accountId: 'account-1', taskId: 'task-1',
          workspace: { ...WORKSPACE_OK, gitConfig: { mergePolicy: { tier: 'human' } } },
        });

        const res = await PUT(createPutRequest({
          headers: { Authorization: 'Bearer bld_test' },
          body: { workerId: 'w-1', prNumber: 42, force: true },
        }));

        expect(res.status).toBe(403);
        expect(mockMergePullRequest).not.toHaveBeenCalled();
      });
    }

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
    expect(mockMergePullRequest).toHaveBeenCalledWith(12345, 'owner/repo', 42, 'squash', 'sha-42');
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

    expect(mockMergePullRequest).toHaveBeenCalledWith(12345, 'owner/repo', 42, 'rebase', 'sha-42');
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
    expect(mockMergePullRequest).toHaveBeenCalledWith(12345, 'owner/repo', 1732, 'squash', 'sha-42');
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

  // ── Mission-PR branch-lifecycle gate (P3) ─────────────────────────────────
  describe('mission-PR branch-lifecycle gate (P3)', () => {
    const BRANCH = 'mission/checkout-arc-1a2b3c4d';

    function missionPrWorkerOk() {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue({
        id: 'w-own',
        accountId: 'account-1',
        taskId: 't-own',
        prUrl: 'https://github.com/owner/repo/pull/42',
        workspace: WORKSPACE_OK,
      });
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      mockTasksFindFirst.mockResolvedValue({
        id: 't-own',
        requiresReview: false,
        missionId: 'mission-1',
        title: `${MISSION_PR_TASK_PREFIX}Checkout arc`,
        taskClass: 'bookkeeping',
      });
      mockMissionsFindFirst.mockResolvedValue({
        mergePolicy: null, requiresReview: false, workingBranch: BRANCH, integrationBranchEnabled: true,
      });
      mockMergePullRequest.mockResolvedValue({ merged: true, message: 'Pull request successfully merged' });
    }

    const put = () => PUT(createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-own', prNumber: 42 },
    }));

    it('refuses to merge the mission PR while a sibling task PR is still open', async () => {
      missionPrWorkerOk();
      mockTasksFindMany.mockResolvedValue([
        { id: 't-2', title: 'Task 2', status: 'completed', mode: 'execution', taskClass: 'work' },
      ]);
      mockWorkersFindMany.mockResolvedValue([
        { taskId: 't-2', prUrl: 'u2', prNumber: 7, prBaseRef: BRANCH, mergedAt: null, prLifecycleStatus: 'pr_open', startedAt: new Date(), createdAt: new Date() },
      ]);

      const res = await put();

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain('still open');
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('refuses to merge the mission PR while a sibling task has not opened a PR at all', async () => {
      // The widened gate, at the worker-facing merge_pr call site. Zero open
      // PRs used to be read as "the mission is done"; a mission whose remaining
      // work was still unclaimed passed straight through and lost its branch.
      missionPrWorkerOk();
      mockTasksFindMany.mockResolvedValue([
        { id: 't-2', title: 'Task 2', status: 'pending', mode: 'execution', taskClass: 'work' },
      ]);
      mockWorkersFindMany.mockResolvedValue([]);

      const res = await put();

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain('Task 2');
      expect(data.error).toContain('pending');
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('merges the mission PR and deletes the integration branch once every task PR has landed', async () => {
      missionPrWorkerOk();
      mockTasksFindMany.mockResolvedValue([
        { id: 't-2', title: 'Task 2', status: 'completed', mode: 'execution', taskClass: 'work' },
      ]);
      mockWorkersFindMany.mockResolvedValue([
        { taskId: 't-2', prUrl: 'u2', prNumber: 7, prBaseRef: BRANCH, mergedAt: new Date(), prLifecycleStatus: 'merged', startedAt: new Date(), createdAt: new Date() },
      ]);

      const res = await put();

      expect(res.status).toBe(200);
      expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
      expect(mockGithubApi).toHaveBeenCalledWith(
        expect.anything(),
        `/repos/owner/repo/git/refs/heads/${encodeURIComponent(BRANCH)}`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('does not gate an ordinary task PR merge — only the mission PR is gated', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue({
        id: 'w-1', accountId: 'account-1', taskId: 't-2',
        prUrl: 'https://github.com/owner/repo/pull/42',
        workspace: WORKSPACE_OK,
      });
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      mockTasksFindFirst.mockResolvedValue({
        id: 't-2', requiresReview: false, missionId: 'mission-1', title: 'Task 2', taskClass: 'work',
      });
      mockMissionsFindFirst.mockResolvedValue({
        mergePolicy: null, requiresReview: false, workingBranch: BRANCH, integrationBranchEnabled: true,
      });
      mockMergePullRequest.mockResolvedValue({ merged: true, message: 'Pull request successfully merged' });
      // mockGithubApi's call history is not cleared between tests in this
      // describe (only its implementation is reset) — clear it so this
      // negative assertion checks THIS test's calls, not accumulated ones.
      mockGithubApi.mockClear();

      const res = await PUT(createPutRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-1', prNumber: 42 },
      }));

      expect(res.status).toBe(200);
      expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
      expect(mockGithubApi).not.toHaveBeenCalledWith(
        expect.anything(), expect.stringContaining('/git/refs/heads/'), expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('applies even under an admin force merge — this guards data integrity, not review policy', async () => {
      missionPrWorkerOk();
      mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, level: 'admin' });
      mockTasksFindMany.mockResolvedValue([
        { id: 't-2', title: 'Task 2', status: 'completed', mode: 'execution', taskClass: 'work' },
      ]);
      mockWorkersFindMany.mockResolvedValue([
        { taskId: 't-2', prUrl: 'u2', prNumber: 7, prBaseRef: BRANCH, mergedAt: null, prLifecycleStatus: 'pr_open', startedAt: new Date(), createdAt: new Date() },
      ]);

      const res = await PUT(createPutRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { workerId: 'w-own', prNumber: 42, force: true },
      }));

      expect(res.status).toBe(409);
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });
  });

  // The tier check above only fires for `agent-review`. A task PR based on a
  // mission integration branch resolves to `auto-threshold` (resolvePolicy rule
  // 2) while `requestIntegrationBranchReview` still dispatches a reviewer at it
  // — so without this gate an agent could merge straight past its own
  // reviewer's request-changes on any Option A′ PR.
  describe('review-verdict gate — every tier, not just agent-review', () => {
    const HEAD = 'sha-42';

    function autoThresholdWorker() {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue({
        id: 'w-1', accountId: 'account-1', taskId: 'task-1',
        prUrl: 'https://github.com/owner/repo/pull/42',
        workspace: { ...WORKSPACE_OK, id: 'ws-1', gitConfig: { mergePolicy: { tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } } } },
      });
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      mockMergePullRequest.mockResolvedValue({ merged: true, message: 'Pull request successfully merged' });
    }

    const put = (body: Record<string, unknown> = {}) => PUT(createPutRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', prNumber: 42, ...body },
    }));

    it('refuses an auto-threshold merge when the reviewer requested changes on this commit', async () => {
      autoThresholdWorker();
      mockReadPrReviewStatus.mockResolvedValue({
        state: 'changes_requested', terminal: true, reviewTaskId: 'rev-1', adoptedTaskId: 'task-1',
        verdict: 'request-changes', confidence: 0.9, summary: null, feedback: 'the gate never checks mergedAt',
        escalationReason: null, iteration: 1, maxIterations: 3, reviewHeadSha: HEAD,
        prState: 'open', merged: false, mergeBlocked: null,
      } as any);

      const res = await put();

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain('requested changes');
      expect(data.error).toContain('the gate never checks mergedAt');
      expect(data.hint).toBeTruthy();
      expect(data.reviewState).toBe('changes_requested');
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('refuses while a review round is still in flight', async () => {
      autoThresholdWorker();
      mockReadPrReviewStatus.mockResolvedValue({
        state: 'reviewing', terminal: false, reviewTaskId: 'rev-1', adoptedTaskId: 'task-1',
        verdict: null, confidence: null, summary: null, feedback: null, escalationReason: null,
        iteration: 0, maxIterations: 3, reviewHeadSha: HEAD,
        prState: 'open', merged: false, mergeBlocked: null,
      } as any);

      const res = await put();

      expect(res.status).toBe(403);
      expect((await res.json()).error).toContain('still in flight');
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    // Regression: a push used to be treated as automatic proof that a fix
    // was re-reviewed, so the gate passed on ANY head-SHA mismatch. Nothing
    // re-reviewed it — the webhook only ever dispatched a reviewer on
    // `opened` — so this is the exact pre-fix incident shape: merge lands on
    // a commit whose only recorded verdict is a rejection of an earlier one.
    // A reviewer is now re-dispatched automatically on `synchronize`
    // (maybeReDispatchReviewer), and the gate blocks until THAT round
    // resolves rather than trusting the push on its own.
    it('still refuses the merge after a push — a push alone does not clear a request-changes verdict', async () => {
      autoThresholdWorker();
      mockReadPrReviewStatus.mockResolvedValue({
        state: 'changes_requested', terminal: true, reviewTaskId: 'rev-1', adoptedTaskId: 'task-1',
        verdict: 'request-changes', confidence: 0.9, summary: null, feedback: 'fix it', escalationReason: null,
        iteration: 1, maxIterations: 3, reviewHeadSha: 'a'.repeat(40),
        prState: 'open', merged: false, mergeBlocked: null,
      } as any);
      mockGithubApi.mockImplementation((_inst: number, path: string) => {
        if (/\/check-runs$/.test(path)) {
          return Promise.resolve({ check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] });
        }
        if (/\/files/.test(path)) return Promise.resolve([]);
        return Promise.resolve({ number: 42, head: { sha: 'b'.repeat(40) }, base: { ref: 'dev' }, mergeable_state: 'clean' });
      });

      const res = await put();

      expect(res.status).toBe(403);
      expect((await res.json()).error).toContain('requested changes');
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('an admin force still bypasses it, and the bypass is already recorded', async () => {
      autoThresholdWorker();
      mockAuthenticateApiKey.mockResolvedValue({ ...ACCOUNT, level: 'admin' });
      mockReadPrReviewStatus.mockResolvedValue({
        state: 'changes_requested', terminal: true, reviewTaskId: 'rev-1', adoptedTaskId: 'task-1',
        verdict: 'request-changes', confidence: 0.9, summary: null, feedback: 'fix it', escalationReason: null,
        iteration: 1, maxIterations: 3, reviewHeadSha: HEAD,
        prState: 'open', merged: false, mergeBlocked: null,
      } as any);

      const res = await put({ force: true });

      expect(res.status).toBe(200);
      expect(mockMergePullRequest).toHaveBeenCalled();
    });
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

  // Same claim-grant path as the POST test above, exercised through the
  // sessionUser-less (API-key) branch of the GET workerId lookup.
  it('lets the cross-team account running the worker through while it holds a claim grant', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockGetAccountWorkspacePermissions.mockResolvedValueOnce([{ workspaceId: 'ws-other', canClaim: true, canCreate: false }]);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      workspaceId: 'ws-other',
      prNumber: 42,
      workspace: WORKSPACE_OTHER_TEAM,
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);

    const res = await GET(createGetRequest('w-1', 42));

    expect(res.status).not.toBe(403);
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

  describe('inline evidence list — workspace reach', () => {
    function resolvablePr() {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockGetTeamWorkspaceIds.mockResolvedValue(['workspace-1']);
      mockWorkersFindMany.mockResolvedValue([{
        id: 'w-ev', taskId: 'task-1', workspaceId: 'workspace-1',
        prUrl: 'https://github.com/owner/repo/pull/150', prNumber: 150,
        prLifecycleStatus: null, lastCommitSha: null, error: null, status: 'completed',
        workspace: WORKSPACE_OK,
      }]);
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      mockGithubApi.mockResolvedValueOnce({
        number: 150, title: 'fix: x', body: null, state: 'open', mergeable: true, mergeable_state: 'clean',
        html_url: 'https://github.com/owner/repo/pull/150', head: { sha: 'sha150' }, additions: 1, deletions: 1, changed_files: 1,
      });
      mockGithubApi.mockResolvedValueOnce({ check_runs: [] });
      mockGithubApi.mockResolvedValueOnce([]);
    }

    beforeEach(() => {
      mockLoadInlineEvidence.mockClear();
      mockVerifyAccountWorkspaceAccess.mockReset();
      mockVerifyAccountWorkspaceAccess.mockImplementation(async () => true);
    });

    it('omits the list for a same-team key not linked to a restricted workspace', async () => {
      resolvablePr();
      mockVerifyAccountWorkspaceAccess.mockImplementation(async () => false);
      const res = await GET(createGetRequest(null, 150));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.evidenceObjects).toBeUndefined();
      expect(mockLoadInlineEvidence).not.toHaveBeenCalled();
      expect(mockVerifyAccountWorkspaceAccess).toHaveBeenCalledWith('account-1', 'workspace-1');
    });

    it('includes the list, audited as get_pr to the account, when the key reaches the workspace', async () => {
      resolvablePr();
      const data = await (await GET(createGetRequest(null, 150))).json();
      expect(data.evidenceObjects.map((o: any) => o.id)).toEqual(['ev-1']);
      expect(mockLoadInlineEvidence.mock.calls[0]).toEqual(['workspace-1', 'task-1', { surface: 'get_pr', actor: { accountId: 'account-1' } }]);
    });
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

  describe('includeComments opt-in', () => {
    it('does not fetch issue comments when includeComments is omitted', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue({
        id: 'w-1', accountId: 'account-1', prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42', lastCommitSha: null,
        workspace: WORKSPACE_OK,
      });
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      mockGithubApi.mockResolvedValueOnce({
        number: 42, title: 'test', body: null, state: 'open',
        mergeable: true, mergeable_state: 'clean',
        html_url: 'https://github.com/owner/repo/pull/42',
        head: { sha: 'abc123' }, additions: null, deletions: null, changed_files: null,
      });
      mockGithubApi.mockResolvedValueOnce({ check_runs: [] });
      mockGithubApi.mockResolvedValueOnce([]);

      const res = await GET(createGetRequest('w-1', 42));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.comments).toBeUndefined();
      // Exactly 3 calls: PR details, check-runs, reviews — no 4th comments call.
      expect(mockGithubApi).toHaveBeenCalledTimes(3);
    });

    it('fetches and ranks issue comments when includeComments=true, buildd-authored first', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue({
        id: 'w-1', accountId: 'account-1', prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42', lastCommitSha: null,
        workspace: WORKSPACE_OK,
      });
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      mockGithubApi.mockResolvedValueOnce({
        number: 42, title: 'test', body: null, state: 'open',
        mergeable: true, mergeable_state: 'clean',
        html_url: 'https://github.com/owner/repo/pull/42',
        head: { sha: 'abc123' }, additions: null, deletions: null, changed_files: null,
      });
      mockGithubApi.mockResolvedValueOnce({ check_runs: [] });
      mockGithubApi.mockResolvedValueOnce([]);
      mockGithubApi.mockResolvedValueOnce([
        { id: 1, user: { login: 'github-actions[bot]', type: 'Bot' }, body: 'CI started', created_at: '2026-01-01T00:00:00Z' },
        { id: 2, user: { login: 'buildd[bot]', type: 'Bot' }, body: 'Reviewer approved these changes.', created_at: '2026-01-02T00:00:00Z' },
      ]);

      const url = new URL('http://localhost:3000/api/github/pr');
      url.searchParams.set('workerId', 'w-1');
      url.searchParams.set('prNumber', '42');
      url.searchParams.set('includeComments', 'true');
      const res = await GET(new NextRequest(url.toString(), {
        method: 'GET',
        headers: new Headers({ Authorization: 'Bearer bld_test' }),
      }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.comments.total).toBe(2);
      expect(data.comments.items[0].kind).toBe('buildd');
      expect(data.comments.items[0].author).toBe('buildd[bot]');
      expect(data.comments.items[1].kind).toBe('bot');
      expect(mockGithubApi).toHaveBeenCalledTimes(4);
    });

    it('a comments fetch failure degrades to an empty ranked list instead of failing the whole GET', async () => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue({
        id: 'w-1', accountId: 'account-1', prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42', lastCommitSha: null,
        workspace: WORKSPACE_OK,
      });
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      mockGithubApi.mockResolvedValueOnce({
        number: 42, title: 'test', body: null, state: 'open',
        mergeable: true, mergeable_state: 'clean',
        html_url: 'https://github.com/owner/repo/pull/42',
        head: { sha: 'abc123' }, additions: null, deletions: null, changed_files: null,
      });
      mockGithubApi.mockResolvedValueOnce({ check_runs: [] });
      mockGithubApi.mockResolvedValueOnce([]);
      mockGithubApi.mockImplementationOnce(() => Promise.reject(new Error('rate limited')));

      const url = new URL('http://localhost:3000/api/github/pr');
      url.searchParams.set('workerId', 'w-1');
      url.searchParams.set('prNumber', '42');
      url.searchParams.set('includeComments', 'true');
      const res = await GET(new NextRequest(url.toString(), {
        method: 'GET',
        headers: new Headers({ Authorization: 'Bearer bld_test' }),
      }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.comments).toEqual({ items: [], total: 0, omitted: 0 });
    });
  });

  describe('includeCiFailures opt-in', () => {
    const RED_RUNS = { check_runs: [
      { name: 'build', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/owner/repo/actions/runs/1/job/9' },
      { name: 'lint', status: 'completed', conclusion: 'success', html_url: 'https://github.com/owner/repo/actions/runs/1/job/10' },
    ] };
    const arrange = (checks: unknown) => {
      mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
      mockWorkersFindFirst.mockResolvedValue({
        id: 'w-1', accountId: 'account-1', prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42', lastCommitSha: null,
        workspace: WORKSPACE_OK,
      });
      mockGithubReposFindFirst.mockResolvedValue(REPO);
      mockGithubApi.mockResolvedValueOnce({
        number: 42, title: 'test', body: null, state: 'open',
        mergeable: true, mergeable_state: 'clean',
        html_url: 'https://github.com/owner/repo/pull/42',
        head: { sha: 'abc123' }, additions: null, deletions: null, changed_files: null,
      });
      mockGithubApi.mockResolvedValueOnce(checks);
      mockGithubApi.mockResolvedValueOnce([]);
    };
    const get = (flag?: string) => {
      const url = new URL('http://localhost:3000/api/github/pr');
      url.searchParams.set('workerId', 'w-1');
      url.searchParams.set('prNumber', '42');
      if (flag) url.searchParams.set('includeCiFailures', flag);
      return GET(new NextRequest(url.toString(), { method: 'GET', headers: new Headers({ Authorization: 'Bearer bld_test' }) }));
    };

    it('reads no job logs unless asked', async () => {
      mockFetchCiFailureExcerpts.mockClear();
      arrange(RED_RUNS);
      const data = await (await get()).json();
      expect(data.ciFailures).toBeUndefined();
      expect(mockFetchCiFailureExcerpts).not.toHaveBeenCalled();
    });

    it('returns an excerpt for each failing check when includeCiFailures=true', async () => {
      mockFetchCiFailureExcerpts.mockClear();
      arrange(RED_RUNS);
      const res = await get('true');
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(mockFetchCiFailureExcerpts).toHaveBeenCalledTimes(1);
      const [, repo, failed] = mockFetchCiFailureExcerpts.mock.calls[0] as any[];
      expect(repo).toBe('owner/repo');
      expect(failed.map((f: any) => f.name)).toEqual(['build']);
      expect(data.ciFailures).toEqual([expect.objectContaining({ name: 'build', step: 'Type check', excerpt: 'error TS2322' })]);
    });

    it('is an empty list, with no fetch, when nothing is failing', async () => {
      mockFetchCiFailureExcerpts.mockClear();
      arrange({ check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] });
      const data = await (await get('true')).json();
      expect(data.ciFailures).toEqual([]);
      expect(mockFetchCiFailureExcerpts).not.toHaveBeenCalled();
    });

    it('a failure reading logs degrades to the failing checks by name and URL, not a failed GET', async () => {
      mockFetchCiFailureExcerpts.mockClear();
      mockFetchCiFailureExcerpts.mockImplementationOnce(async () => { throw new Error('boom'); });
      arrange(RED_RUNS);
      const res = await get('true');
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.ciFailures).toEqual([{
        name: 'build', conclusion: 'failure', url: 'https://github.com/owner/repo/actions/runs/1/job/9', step: null, excerpt: null,
      }]);
    });
  });
});

describe('GET /api/github/pr — dashboard session', () => {
  const SESSION_USER = { id: 'user-1' };
  const WORKER_ROW = {
    id: 'w-1',
    accountId: 'account-runner',
    workspaceId: 'ws-team-1',
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
    lastCommitSha: null,
    workspace: WORKSPACE_OK,
  };

  function sessionGet(query: string): NextRequest {
    return new NextRequest(`http://localhost:3000/api/github/pr?${query}`, { method: 'GET' });
  }

  function stubGithubOpenPr() {
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValueOnce({ number: 42, title: 'feat: x', state: 'open', head: { sha: 'abc' } });
    mockGithubApi.mockResolvedValueOnce({ check_runs: [] });
    mockGithubApi.mockResolvedValueOnce([]);
  }

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGithubApi.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkersFindMany.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockGetTeamWorkspaceIds.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockGetUserTeamIds.mockReset();
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue(SESSION_USER);
    // user-1 is in team-1 (ws-team-1) and team-2 (ws-team-2).
    mockGetUserTeamIds.mockResolvedValue(['team-1', 'team-2']);
    mockGetTeamWorkspaceIds.mockImplementation(async (teamId: string) => [`ws-${teamId}`]);
    // The resolver scopes by inArray(workspaceId, …); honour it so scoping is observable.
    mockWorkersFindMany.mockImplementation(async (q: any) => {
      const ids: string[] = q.where.conditions[0].values;
      return [
        { ...WORKER_ROW, id: 'w-1', workspaceId: 'ws-team-1' },
        { ...WORKER_ROW, id: 'w-2', workspaceId: 'ws-team-2', prNumber: 77, workspace: { ...WORKSPACE_OK, teamId: 'team-2' } },
      ].filter((w) => ids.includes(w.workspaceId) && w.prNumber === q.where.conditions[1].value);
    });
  });

  it('reads a worker PR for a member of the worker workspace', async () => {
    mockWorkersFindFirst.mockResolvedValue(WORKER_ROW);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });
    stubGithubOpenPr();

    const res = await GET(sessionGet('workerId=w-1'));

    expect(res.status).toBe(200);
    expect((await res.json()).pr.number).toBe(42);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith('user-1', 'ws-team-1');
  });

  it('404s (not 403) a worker outside the user teams', async () => {
    mockWorkersFindFirst.mockResolvedValue(WORKER_ROW);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const res = await GET(sessionGet('workerId=w-1'));

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Worker not found');
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('404s a worker in another of the user teams under a ?teamId pin', async () => {
    mockWorkersFindFirst.mockResolvedValue(WORKER_ROW);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });

    const res = await GET(sessionGet('workerId=w-1&teamId=team-2'));

    expect(res.status).toBe(404);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('resolves a PR number across every team the user belongs to', async () => {
    stubGithubOpenPr();
    const res = await GET(sessionGet('prNumber=77'));
    expect(res.status).toBe(200);
    expect(mockGetUserTeamIds).toHaveBeenCalledWith('user-1');
  });

  it('?teamId pins PR-number resolution: a team-2 PR is not found under ?teamId=team-1', async () => {
    const res = await GET(sessionGet('prNumber=77&teamId=team-1'));
    expect(res.status).toBe(404);
    expect(mockGithubApi).not.toHaveBeenCalled();
    expect((mockWorkersFindMany.mock.calls[0] as any[])[0].where.conditions[0].values).toEqual(['ws-team-1']);
  });

  it('404s a ?teamId pin to a team the user is not in', async () => {
    const res = await GET(sessionGet('prNumber=42&teamId=team-9'));
    expect(res.status).toBe(404);
    expect(mockWorkersFindMany).not.toHaveBeenCalled();
  });

  it('401s with neither a session nor a key', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(sessionGet('workerId=w-1'));
    expect(res.status).toBe(401);
  });

  it('keeps the key path authoritative when a key is present (403 out of team, no session lookup)', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({ ...WORKER_ROW, workspace: WORKSPACE_OTHER_TEAM });
    const res = await GET(createGetRequest('w-1', 42));
    expect(res.status).toBe(403);
    expect(mockGetCurrentUser).not.toHaveBeenCalled();
  });

  it('does not accept a session on POST, PATCH or PUT', async () => {
    const body = JSON.stringify({ workerId: 'w-1', prNumber: 42 });
    for (const [handler, method] of [[POST, 'POST'], [PATCH, 'PATCH'], [PUT, 'PUT']] as const) {
      const res = await handler(new NextRequest('http://localhost:3000/api/github/pr', {
        method,
        headers: new Headers({ 'content-type': 'application/json' }),
        body,
      }));
      expect(res.status).toBe(401);
    }
  });
});

describe('Retry PR body generation', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockAuthenticateApiKey.mockReset();
    mockGithubApi.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkersFindMany.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockWorkersUpdate.mockReset();

    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Object.assign(Promise.resolve([]), { returning: () => Promise.resolve([]) })),
      })),
    });
  });

  it('generated retry PR body must not contain UUIDs', async () => {
    const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
    const taskId = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'; // UUID-shaped taskId

    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      taskId,
      name: 'test-worker',
      prUrl: null,
      prNumber: null,
      workspace: WORKSPACE_OK,
      task: { missionId: null, parentTaskId: null, title: null, context: { iteration: 1, maxIterations: 3 } },
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockGithubApi.mockResolvedValueOnce([]); // no existing PR for this head

    let capturedCreateBody = '';
    const originalGithubApi = mockGithubApi.getMockImplementation?.();
    let callCount = 0;
    mockGithubApi.mockImplementation(async (installationId: any, path: string, opts?: any) => {
      callCount++;
      if (path.includes('/pulls') && opts?.method === 'POST') {
        const body = JSON.parse(opts.body);
        capturedCreateBody = body.body;
      }
      // Return a mock PR response
      return {
        number: 99,
        html_url: 'https://github.com/owner/repo/pull/99',
        state: 'open',
        title: 'Retry PR',
        head: { sha: 'sha123' },
        base: { sha: 'basesha123', ref: 'main' },
      };
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: {
        workerId: 'w-1',
        title: 'Retry PR',
        head: 'retry-branch',
        body: 'Initial PR description',
      },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    // The PR body was generated with retry context
    expect(capturedCreateBody).toContain('Attempt 1/3');
    // Must NOT contain the raw taskId UUID
    expect(uuidPattern.test(capturedCreateBody)).toBe(false);
  });

  it('retry attempt line is replaceable without UUIDs appearing', async () => {
    const taskId = 'bbbbcccc-dddd-eeee-ffff-000011112222';

    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      taskId,
      prUrl: null,
      prNumber: null,
      name: 'test-worker',
      workspace: WORKSPACE_OK,
      task: { missionId: null, parentTaskId: null, title: null, context: { iteration: 1, maxIterations: 3 } },
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);

    // Simulate an existing PR with a retry footer (from a previous attempt)
    mockGithubApi.mockResolvedValueOnce([
      {
        number: 88,
        html_url: 'https://github.com/owner/repo/pull/88',
        state: 'open',
        title: 'Fix: retry',
        body: 'Original body\n\n---\n_Attempt 1/3 — resume failed; new branch._',
        additions: 5,
        deletions: 2,
        changed_files: 1,
      },
    ]);

    let patchedBody = '';
    const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

    mockGithubApi.mockImplementation(async (installationId: any, path: string, opts?: any) => {
      if (path.includes('/pulls') && opts?.method === 'PATCH') {
        const body = JSON.parse(opts.body);
        patchedBody = body.body;
        // Fail if UUID detected
        if (uuidPattern.test(patchedBody)) {
          throw new Error(`UUID detected in patched PR body: ${patchedBody}`);
        }
      }
      return {
        number: 88,
        html_url: 'https://github.com/owner/repo/pull/88',
        state: 'open',
        title: 'Fix: retry',
        body: patchedBody || 'Original body\n\n---\n_Attempt 1/3 — resume failed; new branch._',
        base: { sha: 'basesha', ref: 'main' },
      };
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: {
        workerId: 'w-1',
        title: 'Fix: retry',
        head: 'retry-branch',
      },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    // If PATCH was called, it should not have UUIDs
    if (patchedBody) {
      expect(uuidPattern.test(patchedBody)).toBe(false);
    }
  });
});

// ── The lede leads the PR body ───────────────────────────────────────────────
// `lede` is required on the agent-facing `create_pr` action, which throws before
// this route is ever reached (see packages/core/__tests__/mcp-tools-create-pr-lede.test.ts).
// What this route owns is COMPOSITION: the lede goes into the body itself, so
// every reader of the body — GitHub, get_pr, the `pr` corpus — gets it first
// without knowing the field exists. And absence here, which can only mean a
// non-agent caller, degrades to the same deterministic title-derived fallback
// the adoption path uses. Nothing in this feature fails a PR over its prose.
describe('POST /api/github/pr — lede', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    mockAuthenticateApiKey.mockReset();
    mockGithubApi.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkersFindMany.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockMissionsFindFirst.mockReset();
    mockMissionsFindFirst.mockResolvedValue(null);
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({ where: mock(() => Promise.resolve()) })),
    });
  });

  /** Drive a fresh PR creation and return the body sent to GitHub. */
  async function createAndCaptureBody(requestBody: Record<string, unknown>): Promise<string> {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      taskId: 'task-1',
      name: 'test-worker',
      prUrl: null,
      prNumber: null,
      branch: 'feature-branch',
      workspace: WORKSPACE_OK,
      task: { missionId: null, parentTaskId: null, title: 'Task', context: null },
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);

    let captured = '';
    mockGithubApi.mockImplementation((_id: number, path: string, init?: any) => {
      if (typeof path === 'string' && path.endsWith('/pulls') && init?.method === 'POST') {
        captured = JSON.parse(init.body).body;
        return Promise.resolve({
          number: 42,
          html_url: 'https://github.com/owner/repo/pull/42',
          state: 'open',
          title: 'My PR',
          base: { sha: 'basesha', ref: 'main' },
        });
      }
      return Promise.resolve([]); // dedup check: no existing PRs
    });

    const res = await POST(createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', head: 'feature-branch', ...requestBody },
    }));
    expect(res.status).toBe(200);
    return captured;
  }

  it('leads the PR body with the lede, before anything the agent wrote', async () => {
    const lede = 'An escalation that names a real defect can now dispatch the fix.';
    const body = await createAndCaptureBody({
      title: 'feat: dispatch from escalations',
      lede,
      body: '## What changed\n\nWidened the apply-recommendation handler.',
    });

    expect(extractLede(body)?.lede).toBe(lede);
    expect(body.indexOf(lede)).toBeLessThan(body.indexOf('## What changed'));
  });

  it('leaves the rest of the body intact and uncapped — the corpus record is not truncated', async () => {
    const longBody = `## Detail\n\n${'a durable paragraph worth searching later. '.repeat(400)}`;
    const body = await createAndCaptureBody({
      title: 'feat: x',
      lede: 'Short and to the point.',
      body: longBody,
    });

    expect(body).toContain(longBody.trim());
    expect(extractLede(body)?.rest).toBe(longBody);
  });

  it('composes the lede ahead of the retry lineage stamp, not after it', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      taskId: 'task-1',
      name: 'test-worker',
      prUrl: null,
      prNumber: null,
      branch: 'feature-branch',
      workspace: WORKSPACE_OK,
      task: { missionId: null, parentTaskId: null, title: 'Task', context: { iteration: 1, maxIterations: 3 } },
    });
    mockGithubReposFindFirst.mockResolvedValue(REPO);

    let captured = '';
    mockGithubApi.mockImplementation((_id: number, path: string, init?: any) => {
      if (typeof path === 'string' && path.endsWith('/pulls') && init?.method === 'POST') {
        captured = JSON.parse(init.body).body;
        return Promise.resolve({
          number: 43, html_url: 'https://github.com/owner/repo/pull/43', state: 'open', title: 'x',
          base: { sha: 'basesha', ref: 'main' },
        });
      }
      return Promise.resolve([]);
    });

    const res = await POST(createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-1', title: 'feat: x', head: 'feature-branch', lede: 'Still the point.', body: 'detail' },
    }));

    expect(res.status).toBe(200);
    expect(extractLede(captured)?.lede).toBe('Still the point.');
    expect(captured).toContain('Attempt 1/3');
  });

  it('falls back deterministically when no lede reaches the route — it never refuses', async () => {
    const first = await createAndCaptureBody({ title: 'feat(specs): auto-file a friction task' });
    const second = await createAndCaptureBody({ title: 'feat(specs): auto-file a friction task' });

    expect(extractLede(first)?.lede).toBe('Auto-file a friction task.');
    expect(first).toBe(second);
    expect(first).toContain('derived from the PR title');
  });

  it('registers an externally-created PR with no lede instead of failing it', async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-1',
      accountId: 'account-1',
      taskId: 'task-1',
      name: 'test-worker',
      prUrl: null,
      prNumber: null,
      branch: 'feature-branch',
      workspace: WORKSPACE_OK,
      task: { missionId: null, parentTaskId: null, title: 'Task', context: null },
    });

    const res = await POST(createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: {
        workerId: 'w-1',
        title: 'feat: opened with gh',
        head: 'feature-branch',
        prUrl: 'https://github.com/owner/repo/pull/99',
      },
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.pr.number).toBe(99);
    // buildd does not own that PR's body on GitHub, so it writes nothing to it.
    expect(mockGithubApi.mock.calls.some((c: any[]) => c[2]?.method === 'PATCH')).toBe(false);
  });
});

describe('create_pr — retry supersession', () => {
  // The supersession logic itself (lineage scope, live-state guards, failure
  // recording, the sweep) is tested in lib/retry-pr-supersession.test.ts. This
  // block pins how create_pr calls it: gated on retry lineage, awaited, and
  // reported in the response.
  const WORKER_BRANCH = 'buildd/t-9-retry';

  function retryWorker(task: Record<string, any>) {
    return {
      id: 'w-9',
      accountId: 'account-1',
      name: 'test-worker',
      branch: WORKER_BRANCH,
      taskId: 't-9',
      workspace: { ...WORKSPACE_OK, id: 'ws-1', gitConfig: { defaultBranch: 'dev' } },
      task: { id: 't-9', missionId: null, title: 'Fix it', parentTaskId: 't-8', ...task },
    };
  }

  async function openPr(task: Record<string, any>) {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue(retryWorker(task));
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockMissionsFindFirst.mockResolvedValue(null);
    mockGithubApi.mockReset();
    mockGithubApi.mockResolvedValueOnce([]); // dedup-by-head: no existing PR
    mockGithubApi.mockResolvedValueOnce({ number: 77, html_url: 'https://github.com/owner/repo/pull/77', state: 'open', title: 'Fix it' });
    mockGithubApi.mockResolvedValue({});
    const res = await POST(createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-9', title: 'Fix it', head: WORKER_BRANCH },
    }));
    expect(res.status).toBe(200);
    return res.json();
  }

  beforeEach(() => {
    mockCloseAncestorRetryPrs.mockReset();
    mockCloseAncestorRetryPrs.mockResolvedValue([{ prNumber: 70, closed: true, reason: 'superseded (checked_out)' }]);
  });

  it('closes ancestors for an attempt task even when context.iteration is 0, and returns what it did', async () => {
    const data = await openPr({ taskClass: 'attempt', context: { iteration: 0 } });
    expect(mockCloseAncestorRetryPrs).toHaveBeenCalledTimes(1);
    const [args] = mockCloseAncestorRetryPrs.mock.calls[0] as any[];
    expect(args).toMatchObject({
      parentTaskId: 't-8', successorPrNumber: 77, installationId: 12345, repoFullName: 'owner/repo',
      successorWorkerId: 'w-9', via: 'create_pr',
    });
    expect(data.supersededPrs).toEqual([{ prNumber: 70, closed: true, reason: 'superseded (checked_out)' }]);
  });

  it("passes the new PR's base branch, so only an attempt into the same base is closed", async () => {
    mockAuthenticateApiKey.mockResolvedValue(ACCOUNT);
    mockWorkersFindFirst.mockResolvedValue(retryWorker({ taskClass: 'attempt', context: { iteration: 1, prNumber: 70 } }));
    mockGithubReposFindFirst.mockResolvedValue(REPO);
    mockMissionsFindFirst.mockResolvedValue(null);
    mockGithubApi.mockReset();
    mockGithubApi.mockResolvedValueOnce([]);
    mockGithubApi.mockResolvedValueOnce({ number: 77, html_url: 'https://github.com/owner/repo/pull/77', state: 'open', title: 'Fix it', base: { ref: 'dev' } });
    mockGithubApi.mockResolvedValue({});
    const res = await POST(createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workerId: 'w-9', title: 'Fix it', head: WORKER_BRANCH },
    }));
    expect(res.status).toBe(200);
    const [args] = mockCloseAncestorRetryPrs.mock.calls[0] as any[];
    expect(args.successorBaseBranch).toBe('dev');
  });

  it('awaits the close before responding', async () => {
    let settled = false;
    mockCloseAncestorRetryPrs.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 5));
      settled = true;
      return [];
    });
    await openPr({ taskClass: 'attempt', context: { iteration: 1 } });
    expect(settled).toBe(true);
  });

  it('does not close anything for a non-attempt child (parentTaskId as creation provenance)', async () => {
    await openPr({ taskClass: 'work', context: null });
    expect(mockCloseAncestorRetryPrs).not.toHaveBeenCalled();
  });

  it('still opens the PR when the supersession path throws', async () => {
    mockCloseAncestorRetryPrs.mockRejectedValue(new Error('db down'));
    const data = await openPr({ taskClass: 'attempt', context: { iteration: 1 } });
    expect(data.ok).toBe(true);
    expect(data.supersededPrs).toBeUndefined();
  });
});
