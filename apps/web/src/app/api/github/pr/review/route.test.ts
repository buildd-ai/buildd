process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockAuthenticateApiKey = mock(() => null as any);
const mockGithubApi = mock(() => null as any);
const mockGetTeamWorkspaceIds = mock(() => ['ws-1'] as string[]);
const mockResolveWorkspace = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockMissionsFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockGithubReposFindFirst = mock(() => null as any);
const mockCreateReviewerTask = mock(() => ({ id: 'review-task-9' }) as any);
const mockDispatchNewTask = mock(() => Promise.resolve());
const mockAppendPrActivity = mock(() => Promise.resolve({ action: 'created', commentId: 1 }));
const mockFindReviewTaskForPr = mock(() => null as any);
const mockFindPrOwningWorker = mock(() => null as any);
const mockListWorkspaceRoles = mock(() => [{ slug: 'reviewer', isRole: true }] as any[]);
const mockWaitForPrReviewStatus = mock(() => ({
  status: { state: 'reviewing', terminal: false },
  timedOut: true,
}) as any);
const mockReadPrReviewStatus = mock(() => ({ state: 'queued', terminal: false }) as any);

const insertCalls: Array<{ table: any; values: any }> = [];

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));
mock.module('@/lib/team-access', () => ({ getTeamWorkspaceIds: mockGetTeamWorkspaceIds }));
mock.module('@/lib/workspace-resolver', () => ({ resolveWorkspace: mockResolveWorkspace }));
mock.module('@/lib/reviewer', () => ({ createReviewerTask: mockCreateReviewerTask }));
mock.module('@/lib/task-dispatch', () => ({ dispatchNewTask: mockDispatchNewTask }));
mock.module('@/lib/pr-activity-comment', () => ({ appendPrActivity: mockAppendPrActivity }));

mock.module('@/lib/pr-review-request', () => ({
  findReviewTaskForPr: mockFindReviewTaskForPr,
  findPrOwningWorker: mockFindPrOwningWorker,
  listWorkspaceRoles: mockListWorkspaceRoles,
  waitForPrReviewStatus: mockWaitForPrReviewStatus,
  readPrReviewStatus: mockReadPrReviewStatus,
}));
// pr-review-status stays REAL — the status mapping and role picking are the
// contract this route is judged on, and stubbing them would only assert that
// the route calls its own stubs.

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst, findMany: mockWorkspacesFindMany },
      missions: { findFirst: mockMissionsFindFirst },
      githubRepos: { findFirst: mockGithubReposFindFirst },
    },
    insert: (table: any) => ({
      values: (values: any) => {
        insertCalls.push({ table, values });
        return {
          returning: () => Promise.resolve([{ id: table === 'tasks_table' ? 'adopted-task-1' : 'adopted-worker-1' }]),
        };
      },
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
  or: (...conditions: any[]) => ({ conditions, type: 'or' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
  sql: (...args: any[]) => ({ args, type: 'sql' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: 'tasks_table',
  workers: 'workers_table',
  workspaces: { id: 'id', repo: 'repo', name: 'name', teamId: 'teamId' },
  missions: { id: 'id' },
  githubRepos: { id: 'id' },
  workspaceSkills: { slug: 'slug' },
}));

import { POST, GET } from './route';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ACCOUNT = { id: 'account-1', teamId: 'team-1' };
const WORKSPACE = {
  id: 'ws-1',
  name: 'buildd',
  repo: 'buildd-ai/buildd',
  teamId: 'team-1',
  githubRepoId: 'repo-1',
  githubInstallationId: 'inst-1',
  gitConfig: { mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } } },
};
const REPO = { id: 'repo-1', fullName: 'buildd-ai/buildd', installation: { installationId: 5000 } };
const OPEN_PR = {
  number: 42,
  state: 'open',
  title: 'fix: stop the spinner',
  body: 'Work summary here',
  html_url: 'https://github.com/buildd-ai/buildd/pull/42',
  head: { ref: 'fix/spinner', sha: 'sha-42' },
  base: { ref: 'dev', sha: 'base-sha' },
  additions: 40,
  deletions: 3,
  changed_files: 2,
};

function post(body: unknown, headers: Record<string, string> = { authorization: 'Bearer bld_test' }) {
  return new NextRequest('https://buildd.dev/api/github/pr/review', {
    method: 'POST',
    headers: new Headers({ ...headers, 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

function get(query: string, headers: Record<string, string> = { authorization: 'Bearer bld_test' }) {
  return new NextRequest(`https://buildd.dev/api/github/pr/review${query}`, {
    method: 'GET',
    headers: new Headers(headers),
  });
}

beforeEach(() => {
  insertCalls.length = 0;
  mockAuthenticateApiKey.mockReset();
  mockAuthenticateApiKey.mockReturnValue(ACCOUNT);
  mockGithubApi.mockReset();
  mockGithubApi.mockReturnValue(Promise.resolve(OPEN_PR));
  mockGetTeamWorkspaceIds.mockReset();
  mockGetTeamWorkspaceIds.mockReturnValue(['ws-1']);
  mockResolveWorkspace.mockReset();
  mockResolveWorkspace.mockReturnValue(WORKSPACE);
  mockWorkersFindFirst.mockReset();
  mockWorkersFindFirst.mockReturnValue(null);
  mockWorkspacesFindFirst.mockReset();
  mockWorkspacesFindFirst.mockReturnValue(WORKSPACE);
  mockWorkspacesFindMany.mockReset();
  mockWorkspacesFindMany.mockReturnValue([WORKSPACE]);
  mockMissionsFindFirst.mockReset();
  mockMissionsFindFirst.mockReturnValue(null);
  mockTasksFindFirst.mockReset();
  mockTasksFindFirst.mockReturnValue(null);
  mockGithubReposFindFirst.mockReset();
  mockGithubReposFindFirst.mockReturnValue(REPO);
  mockCreateReviewerTask.mockReset();
  mockCreateReviewerTask.mockReturnValue({ id: 'review-task-9' });
  mockDispatchNewTask.mockReset();
  mockDispatchNewTask.mockReturnValue(Promise.resolve());
  mockAppendPrActivity.mockReset();
  mockAppendPrActivity.mockReturnValue(Promise.resolve({ action: 'created', commentId: 1 }));
  mockFindReviewTaskForPr.mockReset();
  mockFindReviewTaskForPr.mockReturnValue(null);
  mockFindPrOwningWorker.mockReset();
  mockFindPrOwningWorker.mockReturnValue(null);
  mockListWorkspaceRoles.mockReset();
  mockListWorkspaceRoles.mockReturnValue([
    { slug: 'reviewer', isRole: true },
    { slug: 'builder', isRole: true },
  ]);
  mockWaitForPrReviewStatus.mockReset();
  mockWaitForPrReviewStatus.mockReturnValue({
    status: { state: 'reviewing', terminal: false },
    timedOut: true,
  });
  mockReadPrReviewStatus.mockReset();
  mockReadPrReviewStatus.mockReturnValue({ state: 'queued', terminal: false });
});

describe('POST /api/github/pr/review — auth and validation', () => {
  it('rejects a request with no API key', async () => {
    mockAuthenticateApiKey.mockReturnValue(null);
    const res = await POST(post({ prNumber: 42 }));
    expect(res.status).toBe(401);
  });

  it('requires a positive integer prNumber', async () => {
    for (const prNumber of [undefined, 0, -3, 'abc']) {
      const res = await POST(post({ prNumber }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('prNumber');
    }
  });

  it('refuses a workspace belonging to another team', async () => {
    mockResolveWorkspace.mockReturnValue({ ...WORKSPACE, teamId: 'team-other' });
    const res = await POST(post({ prNumber: 42, workspaceId: 'buildd' }));
    expect(res.status).toBe(403);
  });

  it('refuses a non-https callback URL up front rather than failing at delivery', async () => {
    const res = await POST(post({ prNumber: 42, callbackUrl: 'http://example.test/hook' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('https');
  });

  it('asks for a workspaceId when the team has several GitHub-linked workspaces', async () => {
    mockGetTeamWorkspaceIds.mockReturnValue(['ws-1', 'ws-2']);
    mockWorkspacesFindMany.mockReturnValue([WORKSPACE, { ...WORKSPACE, id: 'ws-2', name: 'other' }]);
    const res = await POST(post({ prNumber: 42 }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('workspaceId');
    expect(json.candidates).toEqual(['buildd', 'other']);
  });

  it('rejects a workspace with no GitHub link', async () => {
    mockResolveWorkspace.mockReturnValue({ ...WORKSPACE, githubRepoId: null, githubInstallationId: null });
    const res = await POST(post({ prNumber: 42, workspaceId: 'buildd' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('GitHub');
  });
});

describe('POST /api/github/pr/review — the PR itself', () => {
  it('404s when GitHub has no such PR', async () => {
    mockGithubApi.mockReturnValue(Promise.reject(new Error('GitHub API error: 404 Not Found')));
    const res = await POST(post({ prNumber: 999, workspaceId: 'buildd' }));
    expect(res.status).toBe(404);
  });

  it('refuses to review a PR that is already closed', async () => {
    mockGithubApi.mockReturnValue(Promise.resolve({ ...OPEN_PR, state: 'closed' }));
    const res = await POST(post({ prNumber: 42, workspaceId: 'buildd' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('closed');
  });
});

describe('POST /api/github/pr/review — adoption', () => {
  it('adopts an unknown PR as a task + worker mapped to the PR number', async () => {
    const res = await POST(post({ prNumber: 42, workspaceId: 'buildd' }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.adopted).toBe(true);
    expect(json.taskId).toBe('adopted-task-1');
    expect(json.reviewTaskId).toBe('review-task-9');

    const taskInsert = insertCalls.find((c) => c.table === 'tasks_table')!;
    expect(taskInsert.values).toMatchObject({
      workspaceId: 'ws-1',
      status: 'completed',
      creationSource: 'mcp',
    });
    expect(taskInsert.values.title).toContain('#42');

    const workerInsert = insertCalls.find((c) => c.table === 'workers_table')!;
    expect(workerInsert.values).toMatchObject({
      workspaceId: 'ws-1',
      taskId: 'adopted-task-1',
      prNumber: 42,
      prUrl: OPEN_PR.html_url,
      branch: 'fix/spinner',
      prLifecycleStatus: 'pr_open',
    });
    // Diff stats come from the PR so policy thresholds see real numbers.
    expect(workerInsert.values.linesAdded).toBe(40);
    expect(workerInsert.values.filesChanged).toBe(2);
  });

  it('reuses the existing worker when buildd already owns the PR', async () => {
    mockFindPrOwningWorker.mockReturnValue({
      id: 'w-1',
      taskId: 'task-1',
      branch: 'buildd/abc',
      prUrl: OPEN_PR.html_url,
      prLifecycleStatus: 'pr_open',
      mergedAt: null,
    });
    mockWorkersFindFirst.mockReturnValue({
      id: 'w-1',
      taskId: 'task-1',
      branch: 'buildd/abc',
      task: { id: 'task-1', title: 'Original work', description: null, backend: 'claude', missionId: null, pathManifest: null, context: {} },
    });

    const res = await POST(post({ prNumber: 42, workspaceId: 'buildd' }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.adopted).toBe(false);
    expect(json.taskId).toBe('task-1');
    expect(insertCalls.filter((c) => c.table === 'tasks_table')).toHaveLength(0);
    expect(insertCalls.filter((c) => c.table === 'workers_table')).toHaveLength(0);
  });

  it('dispatches the reviewer task and announces it on the PR', async () => {
    await POST(post({ prNumber: 42, workspaceId: 'buildd' }));

    expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
    expect(mockCreateReviewerTask.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws-1',
      prNumber: 42,
      prUrl: OPEN_PR.html_url,
      headSha: 'sha-42',
      reviewerRole: 'reviewer',
      installationId: 5000,
      repoFullName: 'buildd-ai/buildd',
    });
    expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
    expect(mockAppendPrActivity).toHaveBeenCalledTimes(1);
    expect(mockAppendPrActivity.mock.calls[0][0]).toMatchObject({
      prNumber: 42,
      entry: { kind: 'reviewing' },
    });
  });

  it('stores an https callback on the reviewer task so the verdict can be pushed', async () => {
    await POST(post({
      prNumber: 42,
      workspaceId: 'buildd',
      callbackUrl: 'https://example.test/hook',
      callbackOn: 'merge',
    }));

    expect(mockCreateReviewerTask.mock.calls[0][0].reviewCallback).toEqual({
      url: 'https://example.test/hook',
      on: 'merge',
    });
  });
});

describe('POST /api/github/pr/review — reviewer role', () => {
  it('uses the policy reviewer role by default', async () => {
    await POST(post({ prNumber: 42, workspaceId: 'buildd' }));
    expect(mockCreateReviewerTask.mock.calls[0][0].reviewerRole).toBe('reviewer');
  });

  it('honours an explicitly requested role', async () => {
    await POST(post({ prNumber: 42, workspaceId: 'buildd', reviewerRole: 'builder' }));
    expect(mockCreateReviewerTask.mock.calls[0][0].reviewerRole).toBe('builder');
  });

  it('rejects a role the workspace does not have instead of substituting one', async () => {
    const res = await POST(post({ prNumber: 42, workspaceId: 'buildd', reviewerRole: 'ghost' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('ghost');
    expect(mockCreateReviewerTask).not.toHaveBeenCalled();
  });
});

describe('POST /api/github/pr/review — idempotency', () => {
  it('does not start a second reviewer while one is in flight', async () => {
    mockFindReviewTaskForPr.mockReturnValue({
      id: 'review-task-1',
      status: 'in_progress',
      result: null,
      context: { prNumber: 42 },
    });

    const res = await POST(post({ prNumber: 42, workspaceId: 'buildd' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.alreadyRequested).toBe(true);
    expect(json.reviewTaskId).toBe('review-task-1');
    expect(mockCreateReviewerTask).not.toHaveBeenCalled();
  });

  it('returns a finished review rather than silently re-reviewing', async () => {
    mockFindReviewTaskForPr.mockReturnValue({
      id: 'review-task-1',
      status: 'completed',
      result: { structuredOutput: { verdict: 'approve', confidence: 0.9, summary: 'good' } },
      context: { prNumber: 42 },
    });

    const res = await POST(post({ prNumber: 42, workspaceId: 'buildd' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.alreadyRequested).toBe(true);
    expect(json.status.state).toBe('approved');
    expect(mockCreateReviewerTask).not.toHaveBeenCalled();
  });

  it('force re-reviews a PR whose review already finished', async () => {
    mockFindReviewTaskForPr.mockReturnValue({
      id: 'review-task-1',
      status: 'completed',
      result: { structuredOutput: { verdict: 'approve', confidence: 0.9, summary: 'good' } },
      context: { prNumber: 42 },
    });

    const res = await POST(post({ prNumber: 42, workspaceId: 'buildd', force: true }));
    expect(res.status).toBe(201);
    expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
  });

  it('force does NOT stack a second reviewer on an in-flight review', async () => {
    mockFindReviewTaskForPr.mockReturnValue({
      id: 'review-task-1',
      status: 'in_progress',
      result: null,
      context: { prNumber: 42 },
    });

    const res = await POST(post({ prNumber: 42, workspaceId: 'buildd', force: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).alreadyRequested).toBe(true);
    expect(mockCreateReviewerTask).not.toHaveBeenCalled();
  });
});

describe('GET /api/github/pr/review', () => {
  it('rejects a request with no API key', async () => {
    mockAuthenticateApiKey.mockReturnValue(null);
    expect((await GET(get('?prNumber=42'))).status).toBe(401);
  });

  it('requires prNumber', async () => {
    const res = await GET(get('?workspaceId=buildd'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('prNumber');
  });

  it('returns the current status with a single read by default', async () => {
    const res = await GET(get('?prNumber=42&workspaceId=buildd'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status.state).toBe('reviewing');
    expect(json.timedOut).toBe(true);
    expect(mockWaitForPrReviewStatus.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws-1',
      prNumber: 42,
      waitSeconds: 0,
      waitFor: 'verdict',
    });
  });

  it('passes waitFor and waitSeconds through, clamped to the platform limit', async () => {
    await GET(get('?prNumber=42&workspaceId=buildd&waitFor=merge&waitSeconds=600'));
    expect(mockWaitForPrReviewStatus.mock.calls[0][0]).toMatchObject({
      waitFor: 'merge',
      waitSeconds: 45,
    });
  });

  it('reports whether the policy would auto-merge on approval', async () => {
    mockResolveWorkspace.mockReturnValue({
      ...WORKSPACE,
      gitConfig: {
        mergePolicy: {
          tier: 'agent-review',
          agentReview: { reviewerRole: 'reviewer', gateCondition: 'approve-only' },
        },
      },
    });
    const res = await GET(get('?prNumber=42&workspaceId=buildd'));
    expect((await res.json()).autoMergeExpected).toBe(false);
    expect(mockWaitForPrReviewStatus.mock.calls[0][0].autoMergeExpected).toBe(false);
  });
});
