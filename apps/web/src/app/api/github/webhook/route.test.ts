process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── Mock functions ──────────────────────────────────────────────────────────
const mockVerifyWebhookSignature = mock(() => Promise.resolve(true));
const mockGithubApi = mock(() => Promise.resolve(null) as any);
const mockAllCheckSuitesPassed = mock(() => Promise.resolve(true));
const mockHasCheckSuites = mock(() => Promise.resolve(false));
const mockMergePullRequest = mock(() => Promise.resolve({ merged: true, message: 'ok' }));
const mockNotifyMissionPrReady = mock(() => Promise.resolve());
const mockDispatchNewTask = mock(() => Promise.resolve());
const mockInstallationsFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockWorkspacesFindMany = mock(() => [] as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockMissionsFindFirst = mock(() => null as any);

// Track DB operations for assertions
let insertCalls: Array<{ table: any; values: any; conflict: string | null }> = [];
let deleteCalls: Array<{ table: any }> = [];
let updateCalls: Array<{ table: any; setValues: any }> = [];

// Table-keyed select results — lets tests configure `db.select().from(<table>)`
// responses (used by the knowledge-ingest enqueue path). Return null to fall
// back to the legacy `.limit()` chain used by the release-PR lookups.
let selectTableResults: (table: any) => any[] | null = () => null;
// When true, ingest-job inserts return no rows (simulated ON CONFLICT DO NOTHING).
let jobInsertConflicts = false;

// ── Module mocks (must be before route import) ──────────────────────────────
mock.module('@/lib/github', () => ({
  verifyWebhookSignature: mockVerifyWebhookSignature,
  allCheckSuitesPassed: mockAllCheckSuitesPassed,
  hasCheckSuites: mockHasCheckSuites,
  mergePullRequest: mockMergePullRequest,
  githubApi: mockGithubApi,
}));

mock.module('@/lib/mission-notifications', () => ({
  notifyMissionPrReady: mockNotifyMissionPrReady,
}));

mock.module('@/lib/pushover', () => ({
  notify: mock(() => {}),
}));

mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: mockDispatchNewTask,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      githubInstallations: { findFirst: mockInstallationsFindFirst },
      workspaces: {
        findFirst: mockWorkspacesFindFirst,
        findMany: mockWorkspacesFindMany,
      },
      workers: { findFirst: mockWorkersFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
      missions: { findFirst: mockMissionsFindFirst },
    },
    insert: (table: any) => ({
      values: (values: any) => {
        const call = { table, values, conflict: null as string | null };
        insertCalls.push(call);
        return {
          onConflictDoUpdate: (opts: any) => {
            call.conflict = 'update';
            return Promise.resolve();
          },
          onConflictDoNothing: () => {
            call.conflict = 'nothing';
            return {
              returning: () =>
                Promise.resolve(jobInsertConflicts ? [] : [{ id: 'task-1', ...values }]),
            };
          },
          returning: () => Promise.resolve([{ id: 'new-task-1', ...values }]),
        };
      },
    }),
    delete: (table: any) => ({
      where: (condition: any) => {
        deleteCalls.push({ table });
        return Promise.resolve();
      },
    }),
    update: (table: any) => ({
      set: (values: any) => {
        updateCalls.push({ table, setValues: values });
        return {
          where: (condition: any) => ({
            returning: () => Promise.resolve([{ id: 'row-1' }]),
            then: (resolve: any) => resolve(undefined),
          }),
        };
      },
    }),
    // Used by handleReleasePrCiSuccess / handleReleasePrCiFailure (via .limit)
    // and by the knowledge-ingest enqueue path (awaited directly).
    select: (_columns?: any) => ({
      from: (table: any) => ({
        where: (_cond: any) => {
          const rows = selectTableResults(table);
          if (rows) {
            return Object.assign(Promise.resolve(rows), {
              limit: (_n: number) => Promise.resolve(rows),
            });
          }
          return { limit: (_n: number) => Promise.resolve([]) };
        },
      }),
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  isNull: (field: any) => ({ field, type: 'isNull' }),
  sql: Object.assign((strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }), {}),
}));

const schemaMock = {
  githubInstallations: { id: 'id', installationId: 'installationId' },
  githubRepos: { id: 'id', repoId: 'repoId', installationId: 'installationId', fullName: 'fullName' },
  tasks: { id: 'id', externalId: 'externalId', parentTaskId: 'parentTaskId', status: 'status' },
  workers: { id: 'id', prNumber: 'prNumber', workspaceId: 'workspaceId' },
  workspaces: { id: 'id', repo: 'repo', githubRepoId: 'githubRepoId' },
  missions: { id: 'id', releasedAt: 'released_at' },
  knowledgeIngestJobs: {
    id: 'id', workspaceId: 'workspaceId', repo: 'repo', trigger: 'trigger',
    sha: 'sha', prNumber: 'prNumber', scope: 'scope', status: 'status',
  },
};
mock.module('@buildd/core/db/schema', () => schemaMock);

// Mock release-strategy (real logic but isolated from DB)
const mockResolveReleaseStrategy = mock((config: any) => {
  if (!config || !config.enabled) return { ok: false, reason: 'not_configured', message: 'not configured' };
  const kind = config.strategy ?? 'branch_merge';
  if (kind === 'branch_merge') {
    return { ok: true, strategy: { kind, prodBranch: config.prodBranch ?? 'main' } };
  }
  if (kind === 'workflow_dispatch') {
    return {
      ok: true,
      strategy: {
        kind,
        workflowFile: config.workflowFile ?? 'release.yml',
        ref: config.ref ?? 'dev',
        inputs: config.inputs ?? {},
      },
    };
  }
  return { ok: false, reason: 'invalid', message: 'unknown strategy' };
});
mock.module('@buildd/core/release-strategy', () => ({
  resolveReleaseStrategy: mockResolveReleaseStrategy,
}));

// Mock mission-release helpers
const mockCountPendingTasksForMission = mock(() => Promise.resolve(0));
mock.module('@/lib/mission-release', () => ({
  countPendingTasksForMission: mockCountPendingTasksForMission,
  fireMissionReleaseIfComplete: mock(() => Promise.resolve()),
}));

// Pusher — no-op in tests; triggerEvent calls should be silently skipped
mock.module('@/lib/pusher', () => ({
  triggerEvent: mock(() => Promise.resolve()),
  channels: {
    workspace: (id: string) => `workspace-${id}`,
    task: (id: string) => `task-${id}`,
    worker: (id: string) => `worker-${id}`,
    mission: (id: string) => `mission-${id}`,
  },
  events: {
    TASK_CREATED: 'task:created',
    TASK_CLAIMED: 'task:claimed',
    TASK_COMPLETED: 'task:completed',
    TASK_FAILED: 'task:failed',
    TASK_ASSIGNED: 'task:assigned',
    WORKER_STARTED: 'worker:started',
    WORKER_PROGRESS: 'worker:progress',
    WORKER_COMPLETED: 'worker:completed',
    WORKER_FAILED: 'worker:failed',
    WORKER_COMMAND: 'worker:command',
    SCHEDULE_TRIGGERED: 'schedule:triggered',
    SCHEDULE_DEFERRED: 'schedule:deferred',
    CHILDREN_COMPLETED: 'task:children_completed',
    TASK_UNBLOCKED: 'task:unblocked',
    TASK_DEPENDENCY_FAILED: 'task:dependency_failed',
    MISSION_CYCLE_STARTED: 'mission:cycle_started',
    MISSION_LOOP_COMPLETED: 'mission:loop_completed',
    MISSION_LOOP_STALLED: 'mission:loop_stalled',
    TASK_UPDATED: 'task:updated',
    TASK_RETRY_CAP: 'task:retry_cap',
    MISSION_NOTE_POSTED: 'mission:note_posted',
  },
}));
mock.module('@/lib/work-tracker', () => ({
  maybePostWorkTrackerNote: mock(() => Promise.resolve()),
  postWorkTrackerCompletionUpdate: mock(() => Promise.resolve()),
  postLinearCompletionComment: mock(() => Promise.resolve()),
}));

// Merge-policy + reviewer mocks (Phase 2)
const mockResolvePolicy = mock(() => ({ tier: 'auto-threshold' as const, threshold: { maxLines: 800, denyPaths: [] } }));
mock.module('@/lib/merge-policy', () => ({
  resolvePolicy: mockResolvePolicy,
}));

const mockCreateReviewerTask = mock(() => Promise.resolve({ id: 'reviewer-task-1' }));
const mockPreflightEscalationCheck = mock(() => ({ shouldEscalate: false as const }));
mock.module('@/lib/reviewer', () => ({
  createReviewerTask: mockCreateReviewerTask,
  preflightEscalationCheck: mockPreflightEscalationCheck,
}));

const mockTryAutoMergeWorkerPr = mock(() => Promise.resolve());
mock.module('@/lib/auto-merge', () => ({
  tryAutoMergeWorkerPr: mockTryAutoMergeWorkerPr,
}));

// Import handler AFTER mocks
import { POST } from './route';

// ── Helpers ─────────────────────────────────────────────────────────────────
function createWebhookRequest(event: string, payload: any, validSig = true): NextRequest {
  mockVerifyWebhookSignature.mockReturnValue(Promise.resolve(validSig));
  return new NextRequest('http://localhost:3000/api/github/webhook', {
    method: 'POST',
    headers: {
      'x-hub-signature-256': 'sha256=test',
      'x-github-event': event,
      'x-github-delivery': 'delivery-1',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

function makeInstallation(overrides: Record<string, any> = {}) {
  return {
    id: 12345,
    account: {
      login: 'test-org',
      id: 1,
      type: 'Organization',
      avatar_url: 'https://example.com/avatar.png',
    },
    repository_selection: 'selected',
    permissions: { issues: 'read', contents: 'read' },
    ...overrides,
  };
}

function makeIssue(overrides: Record<string, any> = {}) {
  return {
    id: 999,
    number: 42,
    title: 'Test Issue',
    body: 'Issue body content',
    state: 'open',
    html_url: 'https://github.com/test-org/test-repo/issues/42',
    labels: [{ name: 'buildd' }],
    ...overrides,
  };
}

function makeCheckSuitePayload(overrides: Record<string, any> = {}) {
  return {
    action: 'completed',
    check_suite: {
      id: 1,
      head_sha: 'abc123',
      status: 'completed',
      conclusion: 'failure',
      pull_requests: [
        {
          number: 42,
          head: { sha: 'abc123', ref: 'buildd/task-1-fix-bug' },
          base: { sha: 'def456', ref: 'main' },
        },
      ],
      ...overrides.check_suite,
    },
    repository: {
      id: 100,
      full_name: 'test-org/test-repo',
      ...overrides.repository,
    },
    installation: {
      id: 5000,
      ...overrides.installation,
    },
  };
}

function resetAll() {
  mockVerifyWebhookSignature.mockReset();
  mockGithubApi.mockReset();
  mockAllCheckSuitesPassed.mockReset();
  mockHasCheckSuites.mockReset();
  mockMergePullRequest.mockReset();
  mockNotifyMissionPrReady.mockReset();
  mockDispatchNewTask.mockReset();
  mockInstallationsFindFirst.mockReset();
  mockWorkspacesFindFirst.mockReset();
  mockWorkspacesFindMany.mockReset();
  mockWorkersFindFirst.mockReset();
  mockTasksFindFirst.mockReset();
  mockMissionsFindFirst.mockReset();
  mockResolveReleaseStrategy.mockReset();
  mockCountPendingTasksForMission.mockReset();
  mockResolvePolicy.mockReset();
  mockCreateReviewerTask.mockReset();
  mockPreflightEscalationCheck.mockReset();
  mockTryAutoMergeWorkerPr.mockReset();

  insertCalls = [];
  deleteCalls = [];
  updateCalls = [];
  selectTableResults = () => null;
  jobInsertConflicts = false;

  // Defaults
  mockVerifyWebhookSignature.mockReturnValue(Promise.resolve(true));
  mockDispatchNewTask.mockReturnValue(Promise.resolve());
  mockInstallationsFindFirst.mockReturnValue(null);
  mockWorkspacesFindFirst.mockReturnValue(null);
  mockWorkspacesFindMany.mockReturnValue([]);
  mockWorkersFindFirst.mockReturnValue(null);
  mockTasksFindFirst.mockReturnValue(null);
  mockMissionsFindFirst.mockReturnValue(null);
  mockGithubApi.mockReturnValue(Promise.resolve({ draft: false }));
  mockAllCheckSuitesPassed.mockReturnValue(Promise.resolve(true));
  mockHasCheckSuites.mockReturnValue(Promise.resolve(false));
  mockMergePullRequest.mockReturnValue(Promise.resolve({ merged: true, message: 'ok' }));
  mockNotifyMissionPrReady.mockReturnValue(Promise.resolve());
  // Default: no pending tasks (all-terminal)
  mockCountPendingTasksForMission.mockReturnValue(Promise.resolve(0));
  // Phase 2 defaults
  mockResolvePolicy.mockReturnValue({ tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } });
  mockPreflightEscalationCheck.mockReturnValue({ shouldEscalate: false });
  mockCreateReviewerTask.mockReturnValue(Promise.resolve({ id: 'reviewer-task-1' }));
  mockTryAutoMergeWorkerPr.mockReturnValue(Promise.resolve());

  // Default: resolve based on workspace config
  mockResolveReleaseStrategy.mockImplementation((config: any) => {
    if (!config || !config.enabled) return { ok: false, reason: 'not_configured', message: 'not configured' };
    const kind = config.strategy ?? 'branch_merge';
    if (kind === 'branch_merge') return { ok: true, strategy: { kind, prodBranch: config.prodBranch ?? 'main' } };
    if (kind === 'workflow_dispatch') {
      return { ok: true, strategy: { kind, workflowFile: config.workflowFile ?? 'release.yml', ref: config.ref ?? 'dev', inputs: config.inputs ?? {} } };
    }
    return { ok: false, reason: 'invalid', message: 'unknown strategy' };
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────
describe('POST /api/github/webhook', () => {
  beforeEach(resetAll);

  // ── Signature validation ────────────────────────────────────────────────
  it('returns 401 on invalid signature', async () => {
    const req = createWebhookRequest('ping', {}, false);
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Invalid signature');
  });

  it('returns 200 for ping event', async () => {
    const req = createWebhookRequest('ping', { zen: 'hello' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  // ── Installation events ─────────────────────────────────────────────────
  it('handles installation created - inserts installation only', async () => {
    const payload = { action: 'created', installation: makeInstallation() };
    const req = createWebhookRequest('installation', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0].values.installationId).toBe(12345);
    expect(insertCalls[0].conflict).toBe('update');
  });

  it('handles installation deleted', async () => {
    const payload = { action: 'deleted', installation: makeInstallation() };
    const req = createWebhookRequest('installation', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(deleteCalls.length).toBe(1);
  });

  it('handles installation suspend', async () => {
    const payload = { action: 'suspend', installation: makeInstallation() };
    const req = createWebhookRequest('installation', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].setValues.suspendedAt).toBeInstanceOf(Date);
  });

  it('handles installation unsuspend', async () => {
    const payload = { action: 'unsuspend', installation: makeInstallation() };
    const req = createWebhookRequest('installation', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].setValues.suspendedAt).toBeNull();
  });

  // ── Installation repositories ───────────────────────────────────────────
  it('handles installation_repositories removed', async () => {
    const payload = {
      action: 'removed',
      installation: { id: 5000 },
      repositories_removed: [{ id: 300 }],
    };
    const req = createWebhookRequest('installation_repositories', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(deleteCalls.length).toBe(1);
  });

  // ── Issues events ───────────────────────────────────────────────────────
  it('handles issues opened with buildd label - creates task', async () => {
    mockWorkspacesFindFirst.mockReturnValue(
      Promise.resolve({ id: 'ws-1', repo: 'test-org/test-repo' })
    );

    const payload = {
      action: 'opened',
      issue: makeIssue({ labels: [{ name: 'buildd' }] }),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0].values.workspaceId).toBe('ws-1');
    expect(insertCalls[0].values.title).toBe('Test Issue');
    expect(insertCalls[0].values.status).toBe('pending');
    expect(insertCalls[0].values.creationSource).toBe('github');
    expect(insertCalls[0].conflict).toBe('nothing');
    expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
  });

  it('handles issues opened without buildd label - no task created', async () => {
    mockWorkspacesFindFirst.mockReturnValue(
      Promise.resolve({ id: 'ws-1', repo: 'test-org/test-repo' })
    );

    const payload = {
      action: 'opened',
      issue: makeIssue({ labels: [{ name: 'bug' }] }),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(insertCalls.length).toBe(0);
  });

  it('handles issues closed - cancels the linked task if non-terminal', async () => {
    mockWorkspacesFindFirst.mockReturnValue(
      Promise.resolve({ id: 'ws-1', repo: 'test-org/test-repo' })
    );

    const payload = {
      action: 'closed',
      issue: makeIssue({ state: 'closed' }),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(updateCalls.length).toBe(1);
    // An externally-closed issue cancels its open task (was 'completed' before the
    // work-tracker rework); the WHERE guard skips already-terminal tasks.
    expect(updateCalls[0].setValues.status).toBe('cancelled');
  });

  it('handles issues reopened - updates task to pending', async () => {
    mockWorkspacesFindFirst.mockReturnValue(
      Promise.resolve({ id: 'ws-1', repo: 'test-org/test-repo' })
    );

    const payload = {
      action: 'reopened',
      issue: makeIssue({ state: 'open' }),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].setValues.status).toBe('pending');
  });

  it('ignores issues event without installation', async () => {
    const payload = {
      action: 'opened',
      issue: makeIssue(),
      repository: { id: 100, full_name: 'test-org/test-repo' },
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(insertCalls.length).toBe(0);
    expect(mockWorkspacesFindFirst).not.toHaveBeenCalled();
  });

  it('handles issues opened with ai label - creates task', async () => {
    mockWorkspacesFindFirst.mockReturnValue(
      Promise.resolve({ id: 'ws-1', repo: 'test-org/test-repo' })
    );

    const payload = {
      action: 'opened',
      issue: makeIssue({ labels: [{ name: 'ai' }] }),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(insertCalls.length).toBe(1);
  });

  it('ignores issues when no workspace is linked', async () => {
    mockWorkspacesFindFirst.mockReturnValue(Promise.resolve(null));

    const payload = {
      action: 'opened',
      issue: makeIssue(),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(insertCalls.length).toBe(0);
  });

  // ── Error handling ──────────────────────────────────────────────────────
  it('returns 500 when handler throws', async () => {
    mockWorkspacesFindFirst.mockImplementation(() => {
      throw new Error('Database connection failed');
    });

    const payload = {
      action: 'opened',
      issue: makeIssue(),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Webhook processing failed');
  });

  it('returns 200 for unhandled event types', async () => {
    const req = createWebhookRequest('push', { ref: 'refs/heads/main' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  // ── Check suite handling ────────────────────────────────────────────────
  describe('check_suite handling', () => {
    // Helpers for the CI-failure → retry-task path.
    function withFailedWorkerPr(opts: { taskCtx?: Record<string, unknown>; gitConfig?: Record<string, unknown>; missionId?: string | null } = {}) {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w1', branch: 'buildd/abc12345-fix', prNumber: 42,
        task: {
          id: 't1', title: 'Fix the thing', description: 'orig desc',
          workspaceId: 'ws1', missionId: opts.missionId ?? 'm1',
          context: opts.taskCtx ?? {},
        },
      });
      mockWorkspacesFindFirst.mockReturnValue({ id: 'ws1', gitConfig: opts.gitConfig ?? {} });
      // PR-files / runs lookups return a non-array → draft=false, no logs (fallback context)
      mockGithubApi.mockReturnValue(Promise.resolve({ draft: false }));
      mockTasksFindFirst.mockReturnValue(null); // no existing in-flight retry
    }

    it('skips CI retry when no buildd worker owns the PR', async () => {
      // Default worker mock is null → nothing to retry
      const req = createWebhookRequest('check_suite', makeCheckSuitePayload());
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
      expect(mockDispatchNewTask).not.toHaveBeenCalled();
    });

    it('creates and dispatches a CI fix task when CI fails on a worker PR', async () => {
      withFailedWorkerPr();

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(1);
      const inserted = insertCalls[0].values;
      expect(inserted.title).toBe('[CI Retry #1] Fix the thing');
      expect(inserted.parentTaskId).toBe('t1');
      expect(inserted.missionId).toBe('m1');
      expect((inserted.context as any).iteration).toBe(1);
      expect((inserted.context as any).baseBranch).toBe('buildd/abc12345-fix');
      expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
    });

    it('dedupes — skips when a retry task is already in flight', async () => {
      withFailedWorkerPr();
      mockTasksFindFirst.mockReturnValue({ id: 'existing-retry' });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
      expect(mockDispatchNewTask).not.toHaveBeenCalled();
    });

    it('skips CI retry for draft PRs', async () => {
      withFailedWorkerPr();
      mockGithubApi.mockReturnValue(Promise.resolve({ draft: true }));

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
      expect(mockDispatchNewTask).not.toHaveBeenCalled();
    });

    it('fails the task and notifies the mission when retries are exhausted', async () => {
      // iteration already at the max → buildCIRetryTask returns null
      withFailedWorkerPr({ taskCtx: { iteration: 3 }, gitConfig: { maxCiRetries: 3 } });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
      expect(updateCalls.some(c => (c.setValues as any).status === 'failed')).toBe(true);
      expect(mockNotifyMissionPrReady).toHaveBeenCalledTimes(1);
    });

    it('does not retry when maxCiRetries is 0 (disabled)', async () => {
      withFailedWorkerPr({ gitConfig: { maxCiRetries: 0 } });

      const res = await POST(createWebhookRequest('check_suite', makeCheckSuitePayload()));

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
      expect(mockDispatchNewTask).not.toHaveBeenCalled();
      // exhausted/disabled path marks the task failed
      expect(updateCalls.some(c => (c.setValues as any).status === 'failed')).toBe(true);
    });

    it('ignores non-completed check_suite actions', async () => {
      const payload = makeCheckSuitePayload();
      payload.action = 'requested';

      const req = createWebhookRequest('check_suite', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
    });

    it('ignores check_suite without installation', async () => {
      const payload = makeCheckSuitePayload();
      delete (payload as any).installation;

      const req = createWebhookRequest('check_suite', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
    });

    it('ignores check_suite with non-failure conclusion', async () => {
      const payload = makeCheckSuitePayload({
        check_suite: { conclusion: 'neutral' },
      });

      const req = createWebhookRequest('check_suite', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
    });
  });

  // ── requiresReview gate (check_suite success path) ──────────────────────────
  describe('check_suite — requiresReview gate', () => {
    function withSuccessWorkerPr(opts: {
      taskRequiresReview?: boolean;
      mission?: { id: string; requiresReview: boolean } | null;
    } = {}) {
      mockWorkspacesFindMany.mockReturnValue([{ id: 'ws1', gitConfig: { autoMergePR: true } }]);
      mockWorkersFindFirst.mockReturnValue({ id: 'w1', taskId: 't1', prNumber: 42 });
      mockAllCheckSuitesPassed.mockReturnValue(Promise.resolve(true));
      mockTasksFindFirst.mockReturnValue({
        id: 't1',
        requiresReview: opts.taskRequiresReview ?? false,
        missionId: opts.mission?.id ?? 'm1',
        title: 'Fix bug',
        mission: opts.mission ?? null,
      });
    }

    it('holds PR and skips merge when task.requiresReview is true', async () => {
      withSuccessWorkerPr({ taskRequiresReview: true });
      mockNotifyMissionPrReady.mockReturnValue(Promise.resolve({ notified: true }));

      const res = await POST(
        createWebhookRequest('check_suite', makeCheckSuitePayload({ check_suite: { conclusion: 'success' } }))
      );

      expect(res.status).toBe(200);
      expect(mockMergePullRequest).not.toHaveBeenCalled();
      expect(mockNotifyMissionPrReady).toHaveBeenCalledTimes(1);
      const notifyArgs = (mockNotifyMissionPrReady.mock.calls[0] as any[])[1];
      expect(notifyArgs.reason).toBe('awaiting_review');
    });

    it('holds PR and skips merge when mission.requiresReview is true (inherited)', async () => {
      withSuccessWorkerPr({ mission: { id: 'm1', requiresReview: true } });
      mockNotifyMissionPrReady.mockReturnValue(Promise.resolve({ notified: true }));

      const res = await POST(
        createWebhookRequest('check_suite', makeCheckSuitePayload({ check_suite: { conclusion: 'success' } }))
      );

      expect(res.status).toBe(200);
      expect(mockMergePullRequest).not.toHaveBeenCalled();
      expect(mockNotifyMissionPrReady).toHaveBeenCalledTimes(1);
      const notifyArgs = (mockNotifyMissionPrReady.mock.calls[0] as any[])[1];
      expect(notifyArgs.reason).toBe('awaiting_review');
    });

    it('auto-merges when requiresReview is false and CI is green', async () => {
      withSuccessWorkerPr({ taskRequiresReview: false, mission: null });
      // check-runs empty (warns but does not block), PR files within budget
      mockGithubApi
        .mockReturnValueOnce(Promise.resolve({ check_runs: [] }))
        .mockReturnValueOnce(Promise.resolve([]));

      const res = await POST(
        createWebhookRequest('check_suite', makeCheckSuitePayload({ check_suite: { conclusion: 'success' } }))
      );

      expect(res.status).toBe(200);
      expect(mockTryAutoMergeWorkerPr).toHaveBeenCalledTimes(1);
    });

    it('blocks merge when a check run is still pending (CI completeness check)', async () => {
      withSuccessWorkerPr({ taskRequiresReview: false, mission: null });
      // First githubApi call is check-runs — pending run blocks merge
      mockGithubApi.mockReturnValueOnce(
        Promise.resolve({
          check_runs: [{ name: 'build', status: 'in_progress', conclusion: null }],
        })
      );

      const res = await POST(
        createWebhookRequest('check_suite', makeCheckSuitePayload({ check_suite: { conclusion: 'success' } }))
      );

      expect(res.status).toBe(200);
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });
  });

  // ── Pull request auto-merge (no-CI repos) ────────────────────────────────
  describe('pull_request auto-merge for repos without CI', () => {
    function makePullRequestPayload(overrides: Record<string, any> = {}) {
      return {
        action: 'opened',
        pull_request: {
          number: 7,
          merged: false,
          draft: false,
          head: { ref: 'buildd/abc12345-fix', sha: 'sha-7' },
          html_url: 'https://github.com/test-org/test-repo/pull/7',
          ...overrides.pull_request,
        },
        repository: { full_name: 'test-org/test-repo', ...overrides.repository },
        installation: { id: 5000, ...overrides.installation },
        ...overrides.top,
      };
    }

    function withAutoMergeWorkspaceAndWorker(gitConfig: Record<string, any> = { autoMergePR: true }) {
      mockWorkspacesFindMany.mockReturnValue([{ id: 'ws1', gitConfig }]);
      mockWorkersFindFirst.mockReturnValue({ id: 'w1', taskId: 't1', prNumber: 7 });
      // PR files fetch (safety rails) — empty diff passes the line budget
      mockGithubApi.mockReturnValue(Promise.resolve([]));
    }

    it('auto-merges a newly-opened PR when the repo has no CI', async () => {
      withAutoMergeWorkspaceAndWorker();
      mockHasCheckSuites.mockReturnValue(Promise.resolve(false));

      const res = await POST(createWebhookRequest('pull_request', makePullRequestPayload()));

      expect(res.status).toBe(200);
      expect(mockTryAutoMergeWorkerPr).toHaveBeenCalledTimes(1);
    });

    it('defers to check_suite when the repo has CI', async () => {
      withAutoMergeWorkspaceAndWorker();
      mockHasCheckSuites.mockReturnValue(Promise.resolve(true));

      const res = await POST(createWebhookRequest('pull_request', makePullRequestPayload()));

      expect(res.status).toBe(200);
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('does not auto-merge draft PRs', async () => {
      withAutoMergeWorkspaceAndWorker();
      mockHasCheckSuites.mockReturnValue(Promise.resolve(false));

      const payload = makePullRequestPayload({ pull_request: { draft: true } });
      const res = await POST(createWebhookRequest('pull_request', payload));

      expect(res.status).toBe(200);
      expect(mockHasCheckSuites).not.toHaveBeenCalled();
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('does nothing when autoMergePR is disabled', async () => {
      withAutoMergeWorkspaceAndWorker({ autoMergePR: false });
      mockHasCheckSuites.mockReturnValue(Promise.resolve(false));

      const res = await POST(createWebhookRequest('pull_request', makePullRequestPayload()));

      expect(res.status).toBe(200);
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('auto-merges when autoMergeOnGreenCI is true (new canonical field)', async () => {
      withAutoMergeWorkspaceAndWorker({ autoMergeOnGreenCI: true });
      mockHasCheckSuites.mockReturnValue(Promise.resolve(false));

      const res = await POST(createWebhookRequest('pull_request', makePullRequestPayload()));

      expect(res.status).toBe(200);
      expect(mockTryAutoMergeWorkerPr).toHaveBeenCalledTimes(1);
    });

    it('does nothing when autoMergeOnGreenCI is false, even if autoMergePR is true', async () => {
      withAutoMergeWorkspaceAndWorker({ autoMergeOnGreenCI: false, autoMergePR: true });
      mockHasCheckSuites.mockReturnValue(Promise.resolve(false));

      const res = await POST(createWebhookRequest('pull_request', makePullRequestPayload()));

      expect(res.status).toBe(200);
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('completes task — branch_merge workspace: Path A handles release, Path B does NOT dispatch', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 7,
          merged: true,
          draft: false,
          head: { ref: 'buildd/t1-fix', sha: 'sha-7' },
          html_url: 'https://github.com/test-org/test-repo/pull/7',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      mockWorkersFindFirst.mockReturnValue({
        id: 'w1',
        task: {
          id: 't1',
          status: 'pending',
          workspaceId: 'ws1',
          release: 'true',
          title: 'Fix bug',
          missionId: null,
        },
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws1',
        releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main' },
        gitConfig: { defaultBranch: 'dev' },
      });
      mockGithubApi.mockReturnValue(Promise.resolve({}));

      const res = await POST(createWebhookRequest('pull_request', payload));

      expect(res.status).toBe(200);
      expect(updateCalls.some((c) => (c.setValues as any).status === 'completed')).toBe(true);
      // Path B must NOT dispatch for branch_merge — Path A is authoritative
      const dispatchCall = (mockGithubApi.mock.calls as any[][]).find(
        (c) => typeof c[1] === 'string' && (c[1] as string).includes('dispatches'),
      );
      expect(dispatchCall).toBeUndefined();
    });

    it('workflow_dispatch + trigger=every_merge: dispatches configured workflow file', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 8,
          merged: true,
          draft: false,
          head: { ref: 'buildd/t2-feat', sha: 'sha-8' },
          html_url: 'https://github.com/test-org/test-repo/pull/8',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      mockWorkersFindFirst.mockReturnValue({
        id: 'w2',
        task: { id: 't2', status: 'pending', workspaceId: 'ws2', release: 'inherit', title: 'Feature', missionId: null },
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws2',
        releaseConfig: {
          enabled: true,
          strategy: 'workflow_dispatch',
          workflowFile: 'ship.yml',
          ref: 'dev',
          trigger: 'every_merge',
        },
        gitConfig: { defaultBranch: 'dev' },
      });
      mockGithubApi.mockReturnValue(Promise.resolve({}));

      const res = await POST(createWebhookRequest('pull_request', payload));

      expect(res.status).toBe(200);
      const dispatchCall = (mockGithubApi.mock.calls as any[][]).find(
        (c) => typeof c[1] === 'string' && (c[1] as string).includes('/ship.yml/dispatches'),
      );
      expect(dispatchCall).toBeDefined();
    });

    it('workflow_dispatch + trigger=manual: does not dispatch', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 9,
          merged: true,
          draft: false,
          head: { ref: 'buildd/t3-feat', sha: 'sha-9' },
          html_url: 'https://github.com/test-org/test-repo/pull/9',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      mockWorkersFindFirst.mockReturnValue({
        id: 'w3',
        task: { id: 't3', status: 'pending', workspaceId: 'ws3', release: 'inherit', title: 'Feature', missionId: null },
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws3',
        releaseConfig: {
          enabled: true,
          strategy: 'workflow_dispatch',
          workflowFile: 'release.yml',
          ref: 'dev',
          trigger: 'manual',
        },
      });
      mockGithubApi.mockReturnValue(Promise.resolve({}));

      const res = await POST(createWebhookRequest('pull_request', payload));

      expect(res.status).toBe(200);
      const dispatchCall = (mockGithubApi.mock.calls as any[][]).find(
        (c) => typeof c[1] === 'string' && (c[1] as string).includes('dispatches'),
      );
      expect(dispatchCall).toBeUndefined();
    });

    it('workflow_dispatch + on_mission_complete: dispatches once when mission is all-terminal', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 10,
          merged: true,
          draft: false,
          head: { ref: 'buildd/t4-feat', sha: 'sha-10' },
          html_url: 'https://github.com/test-org/test-repo/pull/10',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      mockWorkersFindFirst.mockReturnValue({
        id: 'w4',
        task: { id: 't4', status: 'pending', workspaceId: 'ws4', release: 'inherit', title: 'Feature', missionId: 'mission-1' },
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws4',
        releaseConfig: {
          enabled: true,
          strategy: 'workflow_dispatch',
          workflowFile: 'release.yml',
          ref: 'dev',
          trigger: 'on_mission_complete',
        },
      });
      // All tasks in the mission are terminal (pending=0)
      mockCountPendingTasksForMission.mockReturnValue(Promise.resolve(0));
      mockGithubApi.mockReturnValue(Promise.resolve({}));

      const res = await POST(createWebhookRequest('pull_request', payload));

      expect(res.status).toBe(200);
      const dispatchCall = (mockGithubApi.mock.calls as any[][]).find(
        (c) => typeof c[1] === 'string' && (c[1] as string).includes('dispatches'),
      );
      expect(dispatchCall).toBeDefined();
    });

    it('workflow_dispatch + on_mission_complete: does NOT dispatch when tasks are still pending', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 11,
          merged: true,
          draft: false,
          head: { ref: 'buildd/t5-feat', sha: 'sha-11' },
          html_url: 'https://github.com/test-org/test-repo/pull/11',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      mockWorkersFindFirst.mockReturnValue({
        id: 'w5',
        task: { id: 't5', status: 'pending', workspaceId: 'ws5', release: 'inherit', title: 'Feature', missionId: 'mission-2' },
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws5',
        releaseConfig: {
          enabled: true,
          strategy: 'workflow_dispatch',
          workflowFile: 'release.yml',
          ref: 'dev',
          trigger: 'on_mission_complete',
        },
      });
      // Still 2 tasks pending in the mission
      mockCountPendingTasksForMission.mockReturnValue(Promise.resolve(2));
      mockGithubApi.mockReturnValue(Promise.resolve({}));

      const res = await POST(createWebhookRequest('pull_request', payload));

      expect(res.status).toBe(200);
      const dispatchCall = (mockGithubApi.mock.calls as any[][]).find(
        (c) => typeof c[1] === 'string' && (c[1] as string).includes('dispatches'),
      );
      expect(dispatchCall).toBeUndefined();
    });

    it('calls tryAutoMergeWorkerPr (which handles line-budget blocking internally)', async () => {
      // The safety-rail logic (line budget, deny paths, notifyMissionPrReady on block)
      // now lives in auto-merge.ts. At the webhook level, we verify that
      // tryAutoMergeWorkerPr is invoked with the right gitConfig so the library
      // can apply those checks. The detailed blocking tests live in auto-merge.test.ts.
      mockWorkspacesFindMany.mockReturnValue([{ id: 'ws1', gitConfig: { autoMergePR: true, autoMergeMaxLines: 10 } }]);
      mockWorkersFindFirst.mockReturnValue({ id: 'w1', taskId: 't1', prNumber: 7 });
      mockHasCheckSuites.mockReturnValue(Promise.resolve(false));

      const res = await POST(createWebhookRequest('pull_request', makePullRequestPayload()));

      expect(res.status).toBe(200);
      expect(mockTryAutoMergeWorkerPr).toHaveBeenCalledTimes(1);
      expect(mockTryAutoMergeWorkerPr.mock.calls[0][0]).toMatchObject({
        gitConfig: { autoMergePR: true, autoMergeMaxLines: 10 },
      });
    });

    it('sets worker.mergedAt when PR merges (dependsOn gate prerequisite)', async () => {
      resetAll();
      const payload = {
        action: 'closed',
        pull_request: {
          number: 55,
          merged: true,
          draft: false,
          head: { ref: 'buildd/abc12345-fix', sha: 'sha-55' },
          html_url: 'https://github.com/test-org/test-repo/pull/55',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      mockWorkersFindFirst.mockReturnValue({
        id: 'worker-merge-test',
        task: {
          id: 'task-merge-test',
          status: 'in_progress',
          workspaceId: 'ws1',
          release: 'false',
          missionId: null,
        },
      });

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      // worker.mergedAt must be set — this is what the dependsOn gate checks
      const workerUpdate = updateCalls.find(
        (c) => (c.setValues as any).mergedAt instanceof Date,
      );
      expect(workerUpdate).toBeDefined();
      expect((workerUpdate!.setValues as any).mergedAt).toBeInstanceOf(Date);
    });

    it('sets worker.mergedAt even when task was already completed', async () => {
      resetAll();
      const payload = {
        action: 'closed',
        pull_request: {
          number: 56,
          merged: true,
          draft: false,
          head: { ref: 'buildd/abc12345-fix', sha: 'sha-56' },
          html_url: 'https://github.com/test-org/test-repo/pull/56',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      // Task already completed (worker called complete_task before PR merged)
      mockWorkersFindFirst.mockReturnValue({
        id: 'worker-already-done',
        task: {
          id: 'task-already-done',
          status: 'completed',
          workspaceId: 'ws1',
          release: 'false',
          missionId: null,
        },
      });

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      // mergedAt must still be set even though task was already 'completed'
      const workerUpdate = updateCalls.find(
        (c) => (c.setValues as any).mergedAt instanceof Date,
      );
      expect(workerUpdate).toBeDefined();
    });

    it('enqueues a knowledge diff ingest job per bound workspace on merged PR', async () => {
      // Bind repo → two workspaces via github_repos.fullName → workspaces.githubRepoId
      selectTableResults = (table: any) => {
        if (table === schemaMock.githubRepos) return [{ id: 'repo-uuid-1' }];
        if (table === schemaMock.workspaces) return [{ id: 'ws-a' }, { id: 'ws-b' }];
        return null;
      };

      const payload = {
        action: 'closed',
        pull_request: {
          number: 77,
          merged: true,
          draft: false,
          merge_commit_sha: 'merge-sha-77',
          head: { ref: 'feature/anything', sha: 'head-sha-77' },
          html_url: 'https://github.com/test-org/test-repo/pull/77',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      const jobInserts = insertCalls.filter(c => c.table === schemaMock.knowledgeIngestJobs);
      expect(jobInserts.length).toBe(2);
      expect(jobInserts[0].values).toMatchObject({
        workspaceId: 'ws-a',
        repo: 'test-org/test-repo',
        trigger: 'pr_merged',
        sha: 'merge-sha-77',
        prNumber: 77,
        scope: 'diff',
        status: 'queued',
      });
      expect(jobInserts[1].values.workspaceId).toBe('ws-b');
      // Idempotent enqueue — must go through ON CONFLICT DO NOTHING
      expect(jobInserts.every(c => c.conflict === 'nothing')).toBe(true);
    });

    it('enqueues ingest jobs even for non-worker PRs (any merged PR on a bound repo)', async () => {
      selectTableResults = (table: any) => {
        if (table === schemaMock.githubRepos) return [{ id: 'repo-uuid-1' }];
        if (table === schemaMock.workspaces) return [{ id: 'ws-a' }];
        return null;
      };
      // No worker owns this PR and branch doesn't match buildd/ pattern
      mockWorkersFindFirst.mockReturnValue(null);

      const payload = {
        action: 'closed',
        pull_request: {
          number: 88,
          merged: true,
          draft: false,
          merge_commit_sha: 'merge-sha-88',
          head: { ref: 'human/manual-fix', sha: 'head-sha-88' },
          html_url: 'https://github.com/test-org/test-repo/pull/88',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      const jobInserts = insertCalls.filter(c => c.table === schemaMock.knowledgeIngestJobs);
      expect(jobInserts.length).toBe(1);
    });

    it('does not enqueue an ingest job when the repo is not bound to any workspace', async () => {
      // Default selectTableResults → githubRepos select returns null → legacy
      // chain; configure explicitly to return empty for repos.
      selectTableResults = (table: any) => {
        if (table === schemaMock.githubRepos) return [];
        return null;
      };

      const payload = {
        action: 'closed',
        pull_request: {
          number: 78,
          merged: true,
          draft: false,
          merge_commit_sha: 'merge-sha-78',
          head: { ref: 'feature/x', sha: 'head-sha-78' },
          html_url: 'https://github.com/unbound-org/unbound-repo/pull/78',
        },
        repository: { full_name: 'unbound-org/unbound-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      const jobInserts = insertCalls.filter(c => c.table === schemaMock.knowledgeIngestJobs);
      expect(jobInserts.length).toBe(0);
    });

    it('returns 200 even when ingest enqueue throws (best-effort)', async () => {
      selectTableResults = (table: any) => {
        if (table === schemaMock.githubRepos) throw new Error('db exploded');
        return null;
      };

      const payload = {
        action: 'closed',
        pull_request: {
          number: 79,
          merged: true,
          draft: false,
          merge_commit_sha: 'merge-sha-79',
          head: { ref: 'feature/y', sha: 'head-sha-79' },
          html_url: 'https://github.com/test-org/test-repo/pull/79',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    });

    it('duplicate delivery: conflict on unique index yields no new job and still 200', async () => {
      selectTableResults = (table: any) => {
        if (table === schemaMock.githubRepos) return [{ id: 'repo-uuid-1' }];
        if (table === schemaMock.workspaces) return [{ id: 'ws-a' }];
        return null;
      };
      jobInsertConflicts = true; // second delivery — partial unique index fires

      const payload = {
        action: 'closed',
        pull_request: {
          number: 80,
          merged: true,
          draft: false,
          merge_commit_sha: 'merge-sha-80',
          head: { ref: 'feature/z', sha: 'head-sha-80' },
          html_url: 'https://github.com/test-org/test-repo/pull/80',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      // Insert attempted (idempotency handled by Postgres), but no row returned
      const jobInserts = insertCalls.filter(c => c.table === schemaMock.knowledgeIngestJobs);
      expect(jobInserts.length).toBe(1);
      expect(jobInserts[0].conflict).toBe('nothing');
    });

    it('falls back to head SHA when merge_commit_sha is absent', async () => {
      selectTableResults = (table: any) => {
        if (table === schemaMock.githubRepos) return [{ id: 'repo-uuid-1' }];
        if (table === schemaMock.workspaces) return [{ id: 'ws-a' }];
        return null;
      };

      const payload = {
        action: 'closed',
        pull_request: {
          number: 81,
          merged: true,
          draft: false,
          head: { ref: 'feature/no-merge-sha', sha: 'head-sha-81' },
          html_url: 'https://github.com/test-org/test-repo/pull/81',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      const jobInserts = insertCalls.filter(c => c.table === schemaMock.knowledgeIngestJobs);
      expect(jobInserts.length).toBe(1);
      expect(jobInserts[0].values.sha).toBe('head-sha-81');
    });

    it('calls tryAutoMergeWorkerPr regardless of drizzle/lockfile noise in diff', async () => {
      // Noise-exclusion logic (drizzle meta + lockfile) lives in auto-merge.ts.
      // The webhook's job is to invoke tryAutoMergeWorkerPr with the gitConfig so
      // the library can apply the budget after exclusions. Verified in auto-merge.test.ts.
      mockWorkspacesFindMany.mockReturnValue([{ id: 'ws1', gitConfig: { autoMergePR: true, autoMergeMaxLines: 10 } }]);
      mockWorkersFindFirst.mockReturnValue({ id: 'w1', taskId: 't1', prNumber: 7 });
      mockHasCheckSuites.mockReturnValue(Promise.resolve(false));

      const res = await POST(createWebhookRequest('pull_request', makePullRequestPayload()));

      expect(res.status).toBe(200);
      expect(mockTryAutoMergeWorkerPr).toHaveBeenCalledTimes(1);
    });
  });

  // ── PR lifecycle status tracking ─────────────────────────────────────────
  describe('PR lifecycle status', () => {
    it('sets prLifecycleStatus=pr_open when PR is opened and worker exists', async () => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w-open',
        workspaceId: 'ws1',
        taskId: 'task-open',
        prNumber: 42,
      });
      // Also return no CI for the no-CI auto-merge path (workspace lookup)
      mockWorkspacesFindMany.mockReturnValue([]);

      const payload = {
        action: 'opened',
        pull_request: {
          number: 42,
          merged: false,
          draft: false,
          head: { ref: 'buildd/abc-fix', sha: 'sha-42' },
          html_url: 'https://github.com/test-org/test-repo/pull/42',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      const openUpdate = updateCalls.find((c) => (c.setValues as any).prLifecycleStatus === 'pr_open');
      expect(openUpdate).toBeDefined();
    });

    it('sets prLifecycleStatus=merged (and mergedAt) when PR is merged', async () => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w-merged',
        workspaceId: 'ws1',
        taskId: 'task-merged',
        prNumber: 55,
        task: {
          id: 'task-merged',
          status: 'in_progress',
          workspaceId: 'ws1',
          release: 'false',
          missionId: null,
        },
      });

      const payload = {
        action: 'closed',
        pull_request: {
          number: 55,
          merged: true,
          draft: false,
          head: { ref: 'buildd/abc-fix', sha: 'sha-55' },
          html_url: 'https://github.com/test-org/test-repo/pull/55',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      const mergeUpdate = updateCalls.find(
        (c) => (c.setValues as any).prLifecycleStatus === 'merged' && (c.setValues as any).mergedAt instanceof Date,
      );
      expect(mergeUpdate).toBeDefined();
    });

    it('sets prLifecycleStatus=closed when PR is closed without merge', async () => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w-closed',
        workspaceId: 'ws1',
        taskId: 'task-closed',
        prNumber: 60,
        task: {
          id: 'task-closed',
          status: 'in_progress',
          workspaceId: 'ws1',
          release: 'false',
          missionId: null,
        },
      });

      const payload = {
        action: 'closed',
        pull_request: {
          number: 60,
          merged: false,
          draft: false,
          head: { ref: 'buildd/abc-fix', sha: 'sha-60' },
          html_url: 'https://github.com/test-org/test-repo/pull/60',
        },
        repository: { full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('pull_request', payload));
      expect(res.status).toBe(200);

      const closedUpdate = updateCalls.find((c) => (c.setValues as any).prLifecycleStatus === 'closed');
      expect(closedUpdate).toBeDefined();
      // mergedAt must NOT be set on an abandoned PR
      expect(closedUpdate!.setValues.mergedAt).toBeUndefined();
      // The task must NOT be auto-completed on a non-merged close
      const taskUpdate = updateCalls.find((c) => (c.setValues as any).status === 'completed');
      expect(taskUpdate).toBeUndefined();
    });

    it('sets prLifecycleStatus=ci_running on check_suite requested', async () => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w-ci',
        workspaceId: 'ws1',
        taskId: 'task-ci',
        prNumber: 42,
      });

      const payload = {
        action: 'requested',
        check_suite: {
          id: 1,
          head_sha: 'sha-ci',
          status: 'queued',
          conclusion: null,
          pull_requests: [{ number: 42, head: { sha: 'sha-ci', ref: 'buildd/fix' }, base: { sha: 'base', ref: 'dev' } }],
        },
        repository: { id: 100, full_name: 'test-org/test-repo' },
        installation: { id: 5000 },
      };

      const res = await POST(createWebhookRequest('check_suite', payload));
      expect(res.status).toBe(200);

      const ciUpdate = updateCalls.find((c) => (c.setValues as any).prLifecycleStatus === 'ci_running');
      expect(ciUpdate).toBeDefined();
    });

    it('sets prLifecycleStatus=ci_failed on check_suite completed failure', async () => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w-ci-fail',
        workspaceId: 'ws1',
        taskId: 'task-ci-fail',
        prNumber: 42,
        task: { id: 'task-ci-fail', status: 'in_progress', workspaceId: 'ws1', missionId: null, title: 'Fix bug' },
      });
      mockWorkspacesFindFirst.mockReturnValue({ id: 'ws1', gitConfig: {} });
      // CI logs fetch
      mockGithubApi.mockReturnValue(Promise.resolve({ workflow_runs: [] }));

      const payload = makeCheckSuitePayload({ check_suite: { conclusion: 'failure' } });
      const res = await POST(createWebhookRequest('check_suite', payload));
      expect(res.status).toBe(200);

      const failUpdate = updateCalls.find((c) => (c.setValues as any).prLifecycleStatus === 'ci_failed');
      expect(failUpdate).toBeDefined();
    });
  });

  // ── Reviewer invocation (Phase 2) ──────────────────────────────────────────
  describe('pull_request reviewer dispatch (agent-review policy)', () => {
    function makePROpenedPayload(overrides: Record<string, any> = {}) {
      return {
        action: 'opened',
        pull_request: {
          number: 42,
          merged: false,
          draft: false,
          head: { ref: 'buildd/abc12345-feat', sha: 'sha-42' },
          html_url: 'https://github.com/test-org/test-repo/pull/42',
          ...overrides.pull_request,
        },
        repository: { full_name: 'test-org/test-repo', ...overrides.repository },
        installation: { id: 5000, ...overrides.installation },
      };
    }

    function withAgentReviewWorkspaceAndWorker() {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w1',
        workspaceId: 'ws1',
        taskId: 'task-1',
        branch: 'buildd/abc12345-feat',
        prNumber: 42,
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws1',
        gitConfig: { mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } } },
      });
      mockTasksFindFirst.mockReturnValue({
        id: 'task-1',
        title: 'Add feature X',
        description: 'Build feature X',
        missionId: 'mission-1',
        pathManifest: ['apps/web/src/lib/feature-x.ts'],
        context: { iteration: 0, maxIterations: 3 },
      });
      mockMissionsFindFirst.mockReturnValue({ mergePolicy: null });
      mockResolvePolicy.mockReturnValue({
        tier: 'agent-review',
        agentReview: { reviewerRole: 'reviewer', escalateToPaths: [], maxConfidenceThreshold: 0.6 },
      });
      // PR files fetch — normal files (no schema)
      mockGithubApi.mockReturnValue(Promise.resolve([
        { filename: 'apps/web/src/lib/feature-x.ts', additions: 50, deletions: 5, status: 'added' },
      ]));
    }

    it('creates reviewer task on PR open with agent-review policy', async () => {
      withAgentReviewWorkspaceAndWorker();
      mockPreflightEscalationCheck.mockReturnValue({ shouldEscalate: false });

      const res = await POST(createWebhookRequest('pull_request', makePROpenedPayload()));

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
      expect(mockCreateReviewerTask.mock.calls[0][0]).toMatchObject({
        prNumber: 42,
        reviewerRole: 'reviewer',
        originalTaskId: 'task-1',
      });
      // Auto-merge must NOT be called when reviewer is dispatched
      expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
    });

    it('skips reviewer task and escalates when pre-flight detects schema file', async () => {
      withAgentReviewWorkspaceAndWorker();
      mockGithubApi.mockReturnValue(Promise.resolve([
        { filename: 'packages/core/db/schema.ts', additions: 10, deletions: 2, status: 'modified' },
      ]));
      mockPreflightEscalationCheck.mockReturnValue({
        shouldEscalate: true,
        reason: 'PR touches schema migration file: packages/core/db/schema.ts',
      });

      const res = await POST(createWebhookRequest('pull_request', makePROpenedPayload()));

      expect(res.status).toBe(200);
      // No reviewer task created — pre-flight escalated
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
      // Auto-merge also not called
      expect(mockTryAutoMergeWorkerPr).not.toHaveBeenCalled();
      // Mission notification fired
      expect(mockNotifyMissionPrReady).toHaveBeenCalledTimes(1);
    });

    it('falls through to normal auto-merge path when policy is auto-threshold', async () => {
      mockWorkersFindFirst.mockReturnValue({
        id: 'w1',
        workspaceId: 'ws1',
        taskId: 'task-1',
        branch: 'buildd/abc12345-feat',
        prNumber: 42,
      });
      mockWorkspacesFindFirst.mockReturnValue({
        id: 'ws1',
        gitConfig: { autoMergePR: true },
      });
      mockTasksFindFirst.mockReturnValue({
        id: 'task-1',
        title: 'Fix bug',
        description: null,
        missionId: null,
        mission: null,
      });
      mockResolvePolicy.mockReturnValue({ tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } });
      mockWorkspacesFindMany.mockReturnValue([{ id: 'ws1', gitConfig: { autoMergePR: true } }]);
      mockHasCheckSuites.mockReturnValue(Promise.resolve(false));
      mockGithubApi.mockReturnValue(Promise.resolve([]));

      const res = await POST(createWebhookRequest('pull_request', makePROpenedPayload()));

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
    });

    it('does not dispatch reviewer when PR has no worker', async () => {
      // Worker not found
      mockWorkersFindFirst.mockReturnValue(null);
      mockWorkspacesFindMany.mockReturnValue([]);

      const res = await POST(createWebhookRequest('pull_request', makePROpenedPayload()));

      expect(res.status).toBe(200);
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
    });
  });
});

// ── Inbound work-tracker: issues → tasks (spec §3) ───────────────────────────
describe('inbound issues → tasks', () => {
  beforeEach(resetAll);

  function issuePayload(action: string, overrides: Record<string, any> = {}) {
    return {
      action,
      issue: {
        id: 555,
        number: 7,
        title: 'Fix the thing',
        body: 'details',
        state: action === 'closed' ? 'closed' : 'open',
        html_url: 'https://github.com/acme/widgets/issues/7',
        labels: overrides.labels ?? [{ name: 'buildd' }],
      },
      repository: { id: 1, full_name: 'acme/widgets' },
      installation: { id: 12345 },
    };
  }

  it('creates a work-tracker-linked task when a github-tracked issue is labeled', async () => {
    mockWorkspacesFindFirst.mockReturnValue({
      id: 'ws1', repo: 'acme/widgets', workTrackerConfig: { provider: 'github' },
    });
    const res = await POST(createWebhookRequest('issues', issuePayload('labeled')));
    expect(res.status).toBe(200);

    const taskInsert = insertCalls.find((c) => c.table === schemaMock.tasks);
    expect(taskInsert).toBeDefined();
    expect(taskInsert!.values.externalId).toBe('issue-555');
    // github tracker → linked so the outbound completion loop can fire on merge
    expect(taskInsert!.values.externalIssueUrl).toBe('https://github.com/acme/widgets/issues/7');
  });

  it('is idempotent — no insert when a task already exists for the issue', async () => {
    mockWorkspacesFindFirst.mockReturnValue({
      id: 'ws1', repo: 'acme/widgets', workTrackerConfig: { provider: 'github' },
    });
    mockTasksFindFirst.mockReturnValue({ id: 'existing' });
    const res = await POST(createWebhookRequest('issues', issuePayload('labeled')));
    expect(res.status).toBe(200);
    expect(insertCalls.find((c) => c.table === schemaMock.tasks)).toBeUndefined();
  });

  it('does not create a task when the trigger label is absent', async () => {
    mockWorkspacesFindFirst.mockReturnValue({
      id: 'ws1', repo: 'acme/widgets', workTrackerConfig: { provider: 'github' },
    });
    const res = await POST(createWebhookRequest('issues', issuePayload('labeled', { labels: [{ name: 'bug' }] })));
    expect(res.status).toBe(200);
    expect(insertCalls.find((c) => c.table === schemaMock.tasks)).toBeUndefined();
  });

  it('honors a custom inbound label from config', async () => {
    mockWorkspacesFindFirst.mockReturnValue({
      id: 'ws1', repo: 'acme/widgets', workTrackerConfig: { provider: 'github', inboundLabel: 'agent' },
    });
    // default 'buildd' label should NOT trigger when a custom label is configured
    const res = await POST(createWebhookRequest('issues', issuePayload('labeled', { labels: [{ name: 'buildd' }] })));
    expect(res.status).toBe(200);
    expect(insertCalls.find((c) => c.table === schemaMock.tasks)).toBeUndefined();
  });

  it('cancels a linked task when its issue is closed', async () => {
    mockWorkspacesFindFirst.mockReturnValue({
      id: 'ws1', repo: 'acme/widgets', workTrackerConfig: { provider: 'github' },
    });
    const res = await POST(createWebhookRequest('issues', issuePayload('closed')));
    expect(res.status).toBe(200);
    const cancel = updateCalls.find((c) => (c.setValues as any).status === 'cancelled' && c.table === schemaMock.tasks);
    expect(cancel).toBeDefined();
  });
});
