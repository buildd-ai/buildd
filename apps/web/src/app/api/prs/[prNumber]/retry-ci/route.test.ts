import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockGithubApi = mock(() => Promise.resolve(null) as any);
const mockResolveOrAdoptPrOwner = mock(() => Promise.resolve({}) as any);
const mockCheckPrIsDraft = mock(() => Promise.resolve(false));
const mockFetchCIFailureLogs = mock(() => Promise.resolve({ summary: null, runId: null, runUrl: null, failedJobId: null, failedJobNames: [] }));
const mockFetchCommitAuthor = mock(() => Promise.resolve({ login: 'buildd-ai[bot]', email: '258464409+buildd-ai[bot]@users.noreply.github.com', name: 'buildd-ai[bot]' }));
const mockIsBuilddWorkerCommit = mock((author: any) => !!author?.login?.includes('buildd-ai'));
const mockIsSchemaDriftFailure = mock(() => false);
const mockBuildDriftDiagnoseTask = mock((p: any) => ({
  title: `[CI Diagnose] Schema drift on PR #${p.prNumber}`,
  description: 'diagnose only',
  workspaceId: p.originalTask.workspaceId,
  parentTaskId: p.originalTask.id,
  creationSource: 'dashboard',
  taskClass: 'attempt',
  missionId: p.originalTask.missionId ?? null,
  outputRequirement: 'artifact_required',
  context: { driftDiagnosis: true, prNumber: p.prNumber },
}));
const mockDispatchNewTask = mock(() => Promise.resolve());
const mockAppendPrActivity = mock(() => Promise.resolve({ action: 'updated' } as any));

const mockWorkspacesFindFirst = mock(() => Promise.resolve(null) as any);
const mockGithubReposFindFirst = mock(() => Promise.resolve(null) as any);
const mockTasksFindFirst = mock(() => Promise.resolve(null) as any);
const mockTasksValues = mock((_v: any) => {});
const mockTasksReturning = mock(() => Promise.resolve([{ id: 'new-task-1' }]) as any);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({ getUserWorkspaceIds: mockGetUserWorkspaceIds }));
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));
mock.module('@/lib/pr-review-request', () => ({ resolveOrAdoptPrOwner: mockResolveOrAdoptPrOwner }));
mock.module('@/lib/ci-failure-inspect', () => ({
  checkPrIsDraft: mockCheckPrIsDraft,
  fetchCIFailureLogs: mockFetchCIFailureLogs,
  fetchCommitAuthor: mockFetchCommitAuthor,
  isBuilddWorkerCommit: mockIsBuilddWorkerCommit,
}));
mock.module('@/lib/ci-drift-diagnose', () => ({
  isSchemaDriftFailure: mockIsSchemaDriftFailure,
  buildDriftDiagnoseTask: mockBuildDriftDiagnoseTask,
}));
mock.module('@/lib/ci-retry', () => ({
  buildCIRetryTask: (p: any) => ({
    title: `[CI Retry #1] ${p.originalTask.title}`,
    description: 'retry description',
    workspaceId: p.originalTask.workspaceId,
    parentTaskId: p.originalTask.id,
    creationSource: 'webhook',
    taskClass: 'attempt',
    missionId: p.originalTask.missionId ?? null,
    context: { iteration: 1, maxIterations: 3, prNumber: p.worker.prNumber, foreign_head_sha: p.foreignHeadSha || undefined },
  }),
  DEFAULT_MAX_CI_RETRIES: 3,
}));
mock.module('@/lib/task-dispatch', () => ({ dispatchNewTask: mockDispatchNewTask }));
mock.module('@/lib/pr-activity-comment', () => ({ appendPrActivity: mockAppendPrActivity }));

const TASKS_TABLE = { __name: 'tasks' };
const WORKSPACES_TABLE = { __name: 'workspaces' };
const GITHUB_REPOS_TABLE = { __name: 'githubRepos' };

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      githubRepos: { findFirst: mockGithubReposFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
    },
    insert: (table: any) => {
      if (table === TASKS_TABLE) {
        return {
          values: (v: any) => {
            mockTasksValues(v);
            return { returning: mockTasksReturning };
          },
        };
      }
      throw new Error(`unexpected insert table in test: ${JSON.stringify(table)}`);
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  inArray: (a: any, b: any) => ({ type: 'inArray', a, b }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ type: 'sql', strings, values }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: TASKS_TABLE,
  workspaces: WORKSPACES_TABLE,
  githubRepos: GITHUB_REPOS_TABLE,
}));

import { POST } from './route';

function makeRequest(prNumber = '42', body?: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost/api/prs/${prNumber}/retry-ci`, {
    method: 'POST',
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
  });
  return [req, { params: Promise.resolve({ prNumber }) }] as const;
}

const workspaceRow = {
  id: 'ws-1',
  githubRepoId: 'repo-1',
  githubInstallationId: 'inst-1',
  gitConfig: {},
};

const repoRow = {
  fullName: 'test-org/test-repo',
  installation: { installationId: 5000 },
};

const openPr = {
  number: 42,
  state: 'open',
  title: 'Release v1.2.3',
  body: 'notes',
  html_url: 'https://github.com/test-org/test-repo/pull/42',
  head: { sha: 'abc123', ref: 'release/v1.2.3' },
  base: { sha: 'def456', ref: 'main' },
  draft: false,
};

const adoptedOwner = {
  adopted: true,
  ownerWorker: { id: 'w-1', branch: 'release/v1.2.3' },
  originalTask: { id: 't-1', title: 'PR #42: Release v1.2.3', description: null, missionId: null, workspaceId: 'ws-1' },
};

describe('POST /api/prs/[prNumber]/retry-ci', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockGithubApi.mockReset();
    mockGithubApi.mockResolvedValue(openPr);
    mockResolveOrAdoptPrOwner.mockReset();
    mockResolveOrAdoptPrOwner.mockResolvedValue(adoptedOwner);
    mockCheckPrIsDraft.mockReset();
    mockCheckPrIsDraft.mockResolvedValue(false);
    mockFetchCIFailureLogs.mockReset();
    mockFetchCIFailureLogs.mockResolvedValue({ summary: null, runId: null, runUrl: null, failedJobId: null, failedJobNames: [] });
    mockFetchCommitAuthor.mockReset();
    mockFetchCommitAuthor.mockResolvedValue({ login: 'buildd-ai[bot]', email: '258464409+buildd-ai[bot]@users.noreply.github.com', name: 'buildd-ai[bot]' });
    mockIsBuilddWorkerCommit.mockReset();
    mockIsBuilddWorkerCommit.mockImplementation((author: any) => !!author?.login?.includes('buildd-ai'));
    mockIsSchemaDriftFailure.mockReset();
    mockIsSchemaDriftFailure.mockReturnValue(false);
    mockDispatchNewTask.mockReset();
    mockAppendPrActivity.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesFindFirst.mockResolvedValue(workspaceRow);
    mockGithubReposFindFirst.mockReset();
    mockGithubReposFindFirst.mockResolvedValue(repoRow);
    mockTasksFindFirst.mockReset();
    mockTasksFindFirst.mockResolvedValue(null);
    mockTasksValues.mockReset();
    mockTasksReturning.mockReset();
    mockTasksReturning.mockResolvedValue([{ id: 'new-task-1' }]);
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const [req, ctx] = makeRequest('42', { workspaceId: 'ws-1' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 400 for a non-numeric prNumber', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    const [req, ctx] = makeRequest('not-a-number', { workspaceId: 'ws-1' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 when workspaceId is missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    const [req, ctx] = makeRequest('42', {});
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 403 when the workspace is not accessible to the user', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockGetUserWorkspaceIds.mockResolvedValue(['some-other-ws']);
    const [req, ctx] = makeRequest('42', { workspaceId: 'ws-1' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
  });

  it('returns the in-flight task instead of stacking a second one', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockTasksFindFirst.mockResolvedValue({ id: 'inflight-task-1', outputRequirement: 'pr_required' });
    const [req, ctx] = makeRequest('42', { workspaceId: 'ws-1' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, dispatched: false, inFlight: true, taskId: 'inflight-task-1', diagnoseOnly: false });
    expect(mockResolveOrAdoptPrOwner).not.toHaveBeenCalled();
    expect(mockDispatchNewTask).not.toHaveBeenCalled();
  });

  it('returns 404 when the PR does not exist on GitHub', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockGithubApi.mockResolvedValue(null);
    const [req, ctx] = makeRequest('42', { workspaceId: 'ws-1' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
  });

  it('returns 409 for a merged/closed PR', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockGithubApi.mockResolvedValue({ ...openPr, state: 'closed', merged: false });
    const [req, ctx] = makeRequest('42', { workspaceId: 'ws-1' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
  });

  it('refuses to dispatch a fix for a fork PR', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockGithubApi.mockResolvedValue({
      ...openPr,
      head: { ...openPr.head, repo: { full_name: 'someone-else/test-repo' } },
    });
    const [req, ctx] = makeRequest('42', { workspaceId: 'ws-1' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect(mockResolveOrAdoptPrOwner).not.toHaveBeenCalled();
  });

  it('returns 409 for a draft PR', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockCheckPrIsDraft.mockResolvedValue(true);
    const [req, ctx] = makeRequest('42', { workspaceId: 'ws-1' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
    expect(mockResolveOrAdoptPrOwner).not.toHaveBeenCalled();
  });

  it('adopts the PR (if needed) and dispatches a normal CI retry with a fresh budget', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    const [req, ctx] = makeRequest('42', { workspaceId: 'ws-1' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, dispatched: true, diagnoseOnly: false, taskId: 'new-task-1' });
    expect(mockResolveOrAdoptPrOwner).toHaveBeenCalledTimes(1);
    expect(mockResolveOrAdoptPrOwner.mock.calls[0][0].creationSource).toBe('dashboard');
    expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
    const inserted = mockTasksValues.mock.calls[0][0];
    expect(inserted.title).toContain('[CI Retry');
    expect(inserted.ciRetryPrNumber).toBe(42);
    expect(inserted.creationSource).toBe('dashboard');
  });

  it('dispatches a diagnose-only task for a drift-class failure — never a fix task', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockIsSchemaDriftFailure.mockReturnValue(true);
    const [req, ctx] = makeRequest('42', { workspaceId: 'ws-1' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, dispatched: true, diagnoseOnly: true, taskId: 'new-task-1' });
    const inserted = mockTasksValues.mock.calls[0][0];
    expect(inserted.title).toContain('[CI Diagnose]');
    expect(inserted.outputRequirement).toBe('artifact_required');
    expect(inserted.title).not.toContain('[CI Retry');
  });
});
