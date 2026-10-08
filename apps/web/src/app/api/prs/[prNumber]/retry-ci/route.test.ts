import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockGithubApi = mock(() => Promise.resolve(null) as any);
const mockResolveOrAdoptPrOwner = mock(() => Promise.resolve({}) as any);
const mockCheckPrIsDraft = mock(() => Promise.resolve(false));
const mockFetchCIFailureLogs = mock(() => Promise.resolve({ summary: null, runId: null, runUrl: null, failedJobId: null, failedJobNames: [] }));
// Workflow kernel door (lib/workflow/seam.ts; real-SQL cases in tests/db/workflow-matrix.test.ts).
const mockRequestCiRetry = mock(async (_p: any): Promise<any> => ({ handled: false }));
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
const mockAnnounceTaskCreated = mock((..._a: unknown[]) => Promise.resolve());
const mockWakeTask = mock((..._a: unknown[]) => Promise.resolve());
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
}));
mock.module('@/lib/workflow/seam', () => ({ requestCiRetry: mockRequestCiRetry }));
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
    context: { iteration: (p.attemptsUsed ?? 0) + 1, maxIterations: 3, prNumber: p.worker.prNumber },
  }),
  DEFAULT_MAX_CI_RETRIES: 3,
}));
// Full export surface: mock.module is process-global.
mock.module('@/lib/dispatch-authority', () => ({
  wakeTask: mockWakeTask,
  wakeTasks: mock(async () => {}),
  announceTaskCreated: mockAnnounceTaskCreated,
  kickDispatch: mock(() => {}),
  enqueueTaskDispatch: mock(async () => {}),
  drainDispatchOutbox: mock(async () => ({ claimed: 0, delivered: 0, skipped: 0, failed: 0 })),
  deliverTaskDispatch: mock(async () => 'pusher'),
  routeForCause: mock(() => ({ event: 'task.created', legacyDefault: true, legacyUnfilteredRunnerPreference: false })),
  webhookWants: mock(() => false),
  primaryCause: mock((_c: unknown, fallback: unknown) => fallback),
  reseedDispatchTimer: mock(async () => {}),
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
}));
mock.module('@/lib/pr-activity-comment', () => ({ appendPrActivity: mockAppendPrActivity }));
const NO_IDENTITY = { roleSlug: null, kind: null, complexity: null, missionPhaseIndex: null, missionPhaseLabel: null };
const mockInheritAttemptIdentity = mock((_id: string) => Promise.resolve({ ...NO_IDENTITY } as any));
mock.module('@/lib/attempt-identity', () => ({ inheritAttemptIdentity: mockInheritAttemptIdentity }));

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
    mockRequestCiRetry.mockReset();
    mockRequestCiRetry.mockResolvedValue({ handled: false });
    mockIsSchemaDriftFailure.mockReset();
    mockIsSchemaDriftFailure.mockReturnValue(false);
    mockAnnounceTaskCreated.mockReset();
    mockWakeTask.mockReset();
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
    mockInheritAttemptIdentity.mockReset();
    mockInheritAttemptIdentity.mockResolvedValue({ ...NO_IDENTITY });
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
    expect(mockWakeTask).not.toHaveBeenCalled();
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

  it('refuses to dispatch a fix for a dependency-bot PR — a fix commit hijacks the bot branch', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockGithubApi.mockResolvedValue({ ...openPr, user: { login: 'dependabot[bot]', type: 'Bot' } });
    const [req, ctx] = makeRequest('42', { workspaceId: 'ws-1' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('dependency bot');
    expect(mockResolveOrAdoptPrOwner).not.toHaveBeenCalled();
    expect(mockWakeTask).not.toHaveBeenCalled();
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
    expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
    expect(mockWakeTask.mock.calls).toEqual([['new-task-1', 'ci.retry']]);
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
    expect(mockWakeTask.mock.calls).toEqual([['new-task-1', 'ci.retry']]);
    expect(inserted.outputRequirement).toBe('artifact_required');
    expect(inserted.title).not.toContain('[CI Retry');
  });

  // role-routing §1 row 8: both inserts hand-enumerated their columns and
  // dropped the owner task's role.
  it('the manual CI retry inherits the owner task\'s roleSlug', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockInheritAttemptIdentity.mockResolvedValue({ ...NO_IDENTITY, roleSlug: 'builder', backend: 'codex' });
    const [req, ctx] = makeRequest('42', { workspaceId: 'ws-1' });
    await POST(req, ctx);
    expect(mockInheritAttemptIdentity).toHaveBeenCalledWith('t-1');
    const inserted = mockTasksValues.mock.calls[0][0];
    expect(inserted.roleSlug).toBe('builder');
    expect(inserted.backend).toBe('codex');
  });

  it('the drift diagnose task inherits the owner task\'s roleSlug', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockIsSchemaDriftFailure.mockReturnValue(true);
    mockInheritAttemptIdentity.mockResolvedValue({ ...NO_IDENTITY, roleSlug: 'builder' });
    const [req, ctx] = makeRequest('42', { workspaceId: 'ws-1' });
    await POST(req, ctx);
    const inserted = mockTasksValues.mock.calls[0][0];
    expect(inserted.title).toContain('[CI Diagnose]');
    expect(inserted.roleSlug).toBe('builder');
  });

  it('an adopted (role-less) owner gives its attempt no role', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    const [req, ctx] = makeRequest('42', { workspaceId: 'ws-1' });
    await POST(req, ctx);
    expect(mockTasksValues.mock.calls[0][0].roleSlug).toBeNull();
  });

  describe('a kernel-owned PR (§5.7 rule 5)', () => {
    const authed = () => mockGetCurrentUser.mockResolvedValue({ id: 'user-1' } as any);

    it('goes through the kernel with the configured cap; the legacy dispatch never runs', async () => {
      authed();
      mockRequestCiRetry.mockResolvedValue({ handled: true, extended: false, attemptTaskId: 'ci-1', result: { result: 'applied', decision: { toState: 'REPAIRING' } } });
      const res = await POST(...makeRequest('42', { workspaceId: 'ws-1' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, dispatched: true, diagnoseOnly: false, taskId: 'ci-1', budgetExtended: false });
      expect(mockRequestCiRetry.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws-1', prNumber: 42, actor: 'human:user-1', maxAttempts: 3 });
      expect(mockResolveOrAdoptPrOwner).not.toHaveBeenCalled();
      expect(mockTasksValues).not.toHaveBeenCalled();
    });

    it('past the cap the answer says the budget was extended', async () => {
      authed();
      mockRequestCiRetry.mockResolvedValue({ handled: true, extended: true, attemptTaskId: 'ci-4', result: { result: 'applied', decision: { toState: 'REPAIRING' } } });
      const res = await POST(...makeRequest('42', { workspaceId: 'ws-1', reason: 'flaky runner' }));
      expect((await res.json()).budgetExtended).toBe(true);
      expect(mockRequestCiRetry.mock.calls[0][0].reason).toBe('flaky runner');
    });

    it('a fix already in flight is reported, not stacked; any other refusal is a 409 with the current view', async () => {
      authed();
      mockRequestCiRetry.mockResolvedValue({ handled: true, extended: false, attemptTaskId: null, result: { result: 'rejected', reason: 'fix_in_flight', current: { state: 'REPAIRING' } } });
      expect(await (await POST(...makeRequest('42', { workspaceId: 'ws-1' }))).json()).toMatchObject({ dispatched: false, inFlight: true });
      mockRequestCiRetry.mockResolvedValue({ handled: true, extended: false, attemptTaskId: null, result: { result: 'rejected', reason: 'state_not_allowed', current: { state: 'MERGED', version: 9, head: 'abc123', round: 1 } } });
      const res = await POST(...makeRequest('42', { workspaceId: 'ws-1' }));
      expect(res.status).toBe(409);
      expect((await res.json()).current).toMatchObject({ state: 'MERGED' });
      expect(mockTasksValues).not.toHaveBeenCalled();
    });
  });
});
