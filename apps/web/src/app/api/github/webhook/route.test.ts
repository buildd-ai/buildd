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

// Track DB operations for assertions
let insertCalls: Array<{ table: any; values: any; conflict: string | null }> = [];
let deleteCalls: Array<{ table: any }> = [];
let updateCalls: Array<{ table: any; setValues: any }> = [];

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
              returning: () => Promise.resolve([{ id: 'task-1', ...values }]),
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
          where: (condition: any) => Promise.resolve(),
        };
      },
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  sql: Object.assign((strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }), {}),
}));

mock.module('@buildd/core/db/schema', () => ({
  githubInstallations: { id: 'id', installationId: 'installationId' },
  githubRepos: { id: 'id', repoId: 'repoId', installationId: 'installationId' },
  tasks: { id: 'id', externalId: 'externalId', parentTaskId: 'parentTaskId', status: 'status' },
  workers: { id: 'id', prNumber: 'prNumber', workspaceId: 'workspaceId' },
  workspaces: { id: 'id', repo: 'repo' },
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

  insertCalls = [];
  deleteCalls = [];
  updateCalls = [];

  // Defaults
  mockVerifyWebhookSignature.mockReturnValue(Promise.resolve(true));
  mockDispatchNewTask.mockReturnValue(Promise.resolve());
  mockInstallationsFindFirst.mockReturnValue(null);
  mockWorkspacesFindFirst.mockReturnValue(null);
  mockWorkspacesFindMany.mockReturnValue([]);
  mockWorkersFindFirst.mockReturnValue(null);
  mockTasksFindFirst.mockReturnValue(null);
  mockGithubApi.mockReturnValue(Promise.resolve({ draft: false }));
  mockAllCheckSuitesPassed.mockReturnValue(Promise.resolve(true));
  mockHasCheckSuites.mockReturnValue(Promise.resolve(false));
  mockMergePullRequest.mockReturnValue(Promise.resolve({ merged: true, message: 'ok' }));
  mockNotifyMissionPrReady.mockReturnValue(Promise.resolve());
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

  it('handles issues closed - updates task to completed', async () => {
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
    expect(updateCalls[0].setValues.status).toBe('completed');
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
      expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
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
      expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
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
      expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
    });

    it('does nothing when autoMergeOnGreenCI is false, even if autoMergePR is true', async () => {
      withAutoMergeWorkspaceAndWorker({ autoMergeOnGreenCI: false, autoMergePR: true });
      mockHasCheckSuites.mockReturnValue(Promise.resolve(false));

      const res = await POST(createWebhookRequest('pull_request', makePullRequestPayload()));

      expect(res.status).toBe(200);
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('completes task and triggers release workflow when task.release is "true"', async () => {
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
        releaseConfig: { enabled: true, prodBranch: 'main' },
        gitConfig: { defaultBranch: 'dev' },
      });
      mockGithubApi.mockReturnValue(Promise.resolve({}));

      const res = await POST(createWebhookRequest('pull_request', payload));

      expect(res.status).toBe(200);
      expect(updateCalls.some((c) => (c.setValues as any).status === 'completed')).toBe(true);
      const dispatchCall = (mockGithubApi.mock.calls as any[][]).find(
        (c) => typeof c[1] === 'string' && (c[1] as string).includes('dispatches'),
      );
      expect(dispatchCall).toBeDefined();
    });

    it('blocks merge and notifies when the diff exceeds the line budget', async () => {
      mockWorkspacesFindMany.mockReturnValue([{ id: 'ws1', gitConfig: { autoMergePR: true, autoMergeMaxLines: 10 } }]);
      mockWorkersFindFirst.mockReturnValue({ id: 'w1', taskId: 't1', prNumber: 7 });
      mockHasCheckSuites.mockReturnValue(Promise.resolve(false));
      mockTasksFindFirst.mockReturnValue({ missionId: 'm1', title: 'Big task' });
      // Oversized diff → safety rail trips
      mockGithubApi.mockReturnValue(Promise.resolve([{ filename: 'src/big.ts', additions: 500, deletions: 0 }]));

      const res = await POST(createWebhookRequest('pull_request', makePullRequestPayload()));

      expect(res.status).toBe(200);
      expect(mockMergePullRequest).not.toHaveBeenCalled();
      expect(mockNotifyMissionPrReady).toHaveBeenCalledTimes(1);
    });
  });
});
