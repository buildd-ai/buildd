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
const mockAnnounceTaskCreated = mock(() => Promise.resolve());
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
const mockGetUserTeamIds = mock(async (_userId: string) => [] as string[]);
mock.module('@/lib/team-access', () => ({
  getTeamWorkspaceIds: mockGetTeamWorkspaceIds,
  getUserTeamIds: mockGetUserTeamIds,
}));
const mockGetCurrentUser = mock(async () => null as { id: string } | null);
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/workspace-resolver', () => ({ resolveWorkspace: mockResolveWorkspace }));
// resolvePriorVerdict stays REAL (bun merges an unstubbed named export from the
// real module) — it is a pure extraction function, and the delta-vs-full
// branch this route is judged on depends on its actual behaviour, not a stub.
mock.module('@/lib/reviewer', () => ({ createReviewerTask: mockCreateReviewerTask }));
// The dispatch authority's full surface: mock.module is process-global.
const mockWakeTask = mock(async (_taskId: string, _cause: string, _opts?: unknown) => {});
mock.module('@/lib/dispatch-authority', () => ({
  announceTaskCreated: mockAnnounceTaskCreated,
  wakeTask: mockWakeTask,
  wakeTasks: mock(async () => {}),
  kickDispatch: () => {},
  enqueueTaskDispatch: async () => {},
  drainDispatchOutbox: async () => ({ claimed: 0, delivered: 0, skipped: 0, failed: 0 }),
  deliverTaskDispatch: async () => 'pusher',
  routeForCause: () => ({ event: 'task.created', legacyDefault: true, githubActions: true, legacyUnfilteredRunnerPreference: false }),
  webhookWants: () => false,
  primaryCause: (_causes: string[], fallback: string) => fallback,
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
  reseedDispatchTimer: async () => {},
}));
mock.module('@/lib/pr-activity-comment', () => ({ appendPrActivity: mockAppendPrActivity }));
const mockCarryForward = mock(async (_p: any) => ({ carried: false, reason: 'PR diff changed' }));
mock.module('@/lib/approval-carry-forward', () => ({ carryForwardApprovalIfUnchanged: mockCarryForward }));

const { GATE_SLUGS: REAL_GATE_SLUGS } = await import('@buildd/core/gate-slugs');
const mockFireGateEvent = mock((_input: any) => 'gate-event-1');
mock.module('@/lib/gate-ledger', () => ({ GATE_SLUGS: REAL_GATE_SLUGS, fireGateEvent: mockFireGateEvent }));

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
  mockGetCurrentUser.mockReset();
  mockGetCurrentUser.mockResolvedValue(null);
  mockGetUserTeamIds.mockReset();
  mockGetUserTeamIds.mockResolvedValue([]);
  insertCalls.length = 0;
  mockAuthenticateApiKey.mockReset();
  mockAuthenticateApiKey.mockReturnValue(ACCOUNT);
  mockGithubApi.mockReset();
  // Default: the PR itself, except the per-file breakdown fetchSplitPrStats
  // uses to split reviewable vs generated lines before an adopted worker's
  // diff stats are recorded.
  mockGithubApi.mockImplementation((_installationId: number, path: string) => {
    if (typeof path === 'string' && path.includes('/files')) {
      return Promise.resolve([
        { filename: 'apps/web/src/lib/spinner.ts', additions: 40, deletions: 0 },
        { filename: 'apps/web/src/lib/spinner.test.ts', additions: 0, deletions: 3 },
      ]);
    }
    return Promise.resolve(OPEN_PR);
  });
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
  mockAnnounceTaskCreated.mockReset();
  mockWakeTask.mockReset();
  mockAnnounceTaskCreated.mockReturnValue(Promise.resolve());
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
  mockFireGateEvent.mockClear();
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

  // Automatic adoption skips Renovate/Dependabot PRs; an explicit request is
  // still honoured — reviewed like any PR — but the adoption row records whose
  // branch it is, which is what every push path checks (conflict retry,
  // update-branch, CI fix, review follow-up) before touching it.
  it('explicit review of a renovate[bot] PR adopts and reviews it, stamps the bot, and records the bypass', async () => {
    const botPr = {
      ...OPEN_PR,
      title: 'chore(deps): update dependency postcss to v8.5.28',
      head: { ref: 'renovate/postcss-8.x-lockfile', sha: 'sha-42' },
      user: { login: 'renovate[bot]', type: 'Bot' },
    };
    mockGithubApi.mockImplementation((_i: number, path: string) =>
      Promise.resolve(typeof path === 'string' && path.includes('/files') ? [] : botPr));

    const res = await POST(post({ prNumber: 42, workspaceId: 'buildd' }));

    expect(res.status).toBe(201);
    expect((await res.json()).adopted).toBe(true);
    expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
    expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
    expect(mockWakeTask).toHaveBeenCalledWith((mockAnnounceTaskCreated.mock.calls[0] as any[])[0].id, 'task.created');

    const taskInsert = insertCalls.find((c) => c.table === 'tasks_table')!;
    const { isDependencyBotPrContext } = await import('@/lib/dependency-bot-pr');
    expect(isDependencyBotPrContext(taskInsert.values.context)).toBe(true);

    // Nothing but reads went to GitHub — no push, no update-branch.
    const writes = mockGithubApi.mock.calls.filter(([, , init]: any[]) => init?.method && init.method !== 'GET');
    expect(writes).toEqual([]);

    expect(mockFireGateEvent.mock.calls[0][0]).toMatchObject({
      gate: 'dependency_bot_pr',
      outcome: 'bypassed',
      detail: { prNumber: 42, author: 'renovate[bot]' },
    });
  });

  it('records no bypass for a human-authored PR', async () => {
    await POST(post({ prNumber: 42, workspaceId: 'buildd' }));
    expect(mockFireGateEvent).not.toHaveBeenCalled();
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
    expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
    expect(mockWakeTask).toHaveBeenCalledWith((mockAnnounceTaskCreated.mock.calls[0] as any[])[0].id, 'task.created');
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

  it('force sends a DELTA review (prior verdict + delta SHA) when the head has moved past the terminal verdict', async () => {
    // OPEN_PR.head.sha is 'sha-42' — the terminal review recorded a different
    // headSha, so head has advanced since the verdict.
    mockFindReviewTaskForPr.mockReturnValue({
      id: 'review-task-1',
      status: 'completed',
      result: { structuredOutput: { verdict: 'approve', confidence: 0.9, summary: 'good' } },
      context: { prNumber: 42, headSha: 'old-sha' },
    });

    const res = await POST(post({ prNumber: 42, workspaceId: 'buildd', force: true }));
    expect(res.status).toBe(201);
    expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
    const created = mockCreateReviewerTask.mock.calls[0][0] as any;
    expect(created.priorVerdict).toEqual({
      headSha: 'old-sha',
      verdict: 'approve',
      confidence: 0.9,
      summary: 'good',
      feedback: null,
      escalationReason: null,
    });
  });

  it('force does NOT dispatch a reviewer when the approved PR diff is unchanged since the approval (rebase only)', async () => {
    mockFindReviewTaskForPr.mockReturnValue({
      id: 'review-task-1',
      status: 'completed',
      result: { structuredOutput: { verdict: 'approve', confidence: 0.9, summary: 'good' } },
      context: { prNumber: 42, headSha: 'old-sha' },
    });
    mockCarryForward.mockResolvedValueOnce({ carried: true, reason: 'PR diff unchanged' });

    const res = await POST(post({ prNumber: 42, workspaceId: 'buildd', force: true }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.carriedForward).toBe(true);
    expect(json.reviewTaskId).toBe('review-task-1');
    expect(mockCarryForward.mock.calls.at(-1)![0]).toMatchObject({ prNumber: 42, headSha: 'sha-42' });
    expect(mockCreateReviewerTask).not.toHaveBeenCalled();
  });

  it('force never tries to carry forward a request-changes verdict', async () => {
    mockCarryForward.mockClear();
    mockFindReviewTaskForPr.mockReturnValue({
      id: 'review-task-1',
      status: 'completed',
      result: { structuredOutput: { verdict: 'request-changes', confidence: 0.9, summary: 'fix it', feedback: 'x' } },
      context: { prNumber: 42, headSha: 'old-sha' },
    });

    const res = await POST(post({ prNumber: 42, workspaceId: 'buildd', force: true }));
    expect(res.status).toBe(201);
    expect(mockCarryForward).not.toHaveBeenCalled();
    expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
  });

  it('force does NOT build a delta when the terminal verdict is already at the current head', async () => {
    mockFindReviewTaskForPr.mockReturnValue({
      id: 'review-task-1',
      status: 'completed',
      result: { structuredOutput: { verdict: 'approve', confidence: 0.9, summary: 'good' } },
      context: { prNumber: 42, headSha: 'sha-42' }, // == OPEN_PR.head.sha
    });

    const res = await POST(post({ prNumber: 42, workspaceId: 'buildd', force: true }));
    expect(res.status).toBe(201);
    expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
    const created = mockCreateReviewerTask.mock.calls[0][0] as any;
    expect(created.priorVerdict).toBeUndefined();
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

describe('GET /api/github/pr/review — dashboard session', () => {
  const noKey = {};

  beforeEach(() => {
    mockAuthenticateApiKey.mockReturnValue(null);
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    // user-1 is in team-1 (ws-1) and team-2 (ws-2).
    mockGetUserTeamIds.mockResolvedValue(['team-1', 'team-2']);
    mockGetTeamWorkspaceIds.mockImplementation(((teamId: string) => (teamId === 'team-1' ? ['ws-1'] : ['ws-2'])) as any);
  });

  it('reports review status for a workspace in the user teams', async () => {
    const res = await GET(get('?prNumber=42&workspaceId=buildd', noKey));
    expect(res.status).toBe(200);
    expect(mockResolveWorkspace.mock.calls[0][1]).toEqual({ teamIds: ['team-1', 'team-2'] });
    expect(mockWaitForPrReviewStatus.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws-1', prNumber: 42 });
  });

  it('404s (not 403) a workspace outside the user teams', async () => {
    mockResolveWorkspace.mockReturnValue({ ...WORKSPACE, teamId: 'team-9' });
    const res = await GET(get('?prNumber=42&workspaceId=buildd', noKey));
    expect(res.status).toBe(404);
    expect(mockWaitForPrReviewStatus).not.toHaveBeenCalled();
  });

  it('without workspaceId, searches the workspaces of every user team', async () => {
    mockWorkspacesFindMany.mockReturnValue([WORKSPACE]);
    const res = await GET(get('?prNumber=42', noKey));
    expect(res.status).toBe(200);
    const ownerQuery = mockWorkersFindFirst.mock.calls[0][0] as any;
    expect(ownerQuery.where.conditions[1].values).toEqual(['ws-1', 'ws-2']);
  });

  it('?teamId pins the search: team-2 workspaces are not considered under ?teamId=team-1', async () => {
    mockWorkspacesFindMany.mockReturnValue([WORKSPACE]);
    const res = await GET(get('?prNumber=42&teamId=team-1', noKey));
    expect(res.status).toBe(200);
    const ownerQuery = mockWorkersFindFirst.mock.calls[0][0] as any;
    expect(ownerQuery.where.conditions[1].values).toEqual(['ws-1']);
  });

  it('?teamId bounds an explicit workspaceId to that team', async () => {
    mockResolveWorkspace.mockReturnValue(null);
    const res = await GET(get('?prNumber=42&workspaceId=other&teamId=team-1', noKey));
    expect(res.status).toBe(404);
    expect(mockResolveWorkspace.mock.calls[0][1]).toEqual({ teamIds: ['team-1'] });
  });

  it('404s a ?teamId pin to a team the user is not in', async () => {
    const res = await GET(get('?prNumber=42&teamId=team-9', noKey));
    expect(res.status).toBe(404);
    expect(mockWaitForPrReviewStatus).not.toHaveBeenCalled();
  });

  it('401s with neither a session nor a key', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await GET(get('?prNumber=42', noKey))).status).toBe(401);
  });

  it('keeps a present key authoritative (403 out of team, no session lookup)', async () => {
    mockAuthenticateApiKey.mockReturnValue(ACCOUNT);
    mockResolveWorkspace.mockReturnValue({ ...WORKSPACE, teamId: 'team-2' });
    const res = await GET(get('?prNumber=42&workspaceId=buildd'));
    expect(res.status).toBe(403);
    expect(mockGetCurrentUser).not.toHaveBeenCalled();
  });

  it('does not accept a session on POST', async () => {
    const res = await POST(post({ prNumber: 42, workspaceId: 'buildd' }, {}));
    expect(res.status).toBe(401);
  });
});

describe('per-task token', () => {
  const SCOPED = { ...ACCOUNT, level: 'worker', taskScope: { taskId: 'task-1', workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 } };
  const owner = (taskId: string) => ({ id: 'w-1', taskId, branch: 'buildd/abc', prUrl: OPEN_PR.html_url, prLifecycleStatus: 'pr_open', mergedAt: null });

  beforeEach(() => {
    mockAuthenticateApiKey.mockReturnValue(SCOPED);
  });

  it('requests review of its own task’s PR', async () => {
    mockFindPrOwningWorker.mockReturnValue(owner('task-1'));
    mockWorkersFindFirst.mockReturnValue({
      ...owner('task-1'),
      task: { id: 'task-1', title: 'Original work', description: null, backend: 'claude', missionId: null, pathManifest: null, context: {} },
    });
    const res = await POST(post({ prNumber: 42 }));
    expect(res.status).toBe(201);
  });

  it('refuses review of another task’s PR, without creating a reviewer', async () => {
    mockFindPrOwningWorker.mockReturnValue(owner('task-2'));
    const res = await POST(post({ prNumber: 42 }));
    expect(res.status).toBe(403);
    expect(mockCreateReviewerTask).not.toHaveBeenCalled();
  });

  it('requests review of a PR its own task names, even though a different task’s worker owns it', async () => {
    // A coordination/cleanup task ("resolve conflicts on #42") repairing a PR
    // it never opened — same fallback pr/route.ts already applies to close/merge.
    mockFindPrOwningWorker.mockReturnValue(owner('task-2'));
    mockTasksFindFirst.mockReturnValue({
      id: 'task-1', title: 'Repair stale PRs', description: 'resolve conflicts on #42', context: {}, workspaceId: 'ws-1',
    });
    const res = await POST(post({ prNumber: 42 }));
    expect(res.status).toBe(201);
  });

  it('still refuses when neither its own worker nor its task names the PR', async () => {
    mockFindPrOwningWorker.mockReturnValue(owner('task-2'));
    mockTasksFindFirst.mockReturnValue({
      id: 'task-1', title: 'Unrelated work', description: 'nothing about PRs here', context: {}, workspaceId: 'ws-1',
    });
    const res = await POST(post({ prNumber: 42 }));
    expect(res.status).toBe(403);
    expect(mockCreateReviewerTask).not.toHaveBeenCalled();
  });

  it('does not trust another task naming the PR when the task row has drifted out of its own workspace', async () => {
    mockFindPrOwningWorker.mockReturnValue(owner('task-2'));
    mockTasksFindFirst.mockReturnValue({
      id: 'task-1', title: 'Repair stale PRs', description: 'resolve conflicts on #42', context: {}, workspaceId: 'ws-2',
    });
    const res = await POST(post({ prNumber: 42 }));
    expect(res.status).toBe(403);
  });

  it('refuses review of a PR buildd does not own, rather than adopting it', async () => {
    const res = await POST(post({ prNumber: 42 }));
    expect(res.status).toBe(403);
    expect(insertCalls).toHaveLength(0);
  });

  it('sees only its own workspace, even when the team has others', async () => {
    mockGetTeamWorkspaceIds.mockReturnValue(['ws-1', 'ws-2']);
    mockResolveWorkspace.mockReturnValue({ ...WORKSPACE, id: 'ws-2', name: 'other' });
    const res = await GET(get('?prNumber=42&workspaceId=other'));
    expect(res.status).toBe(404);
  });
});
