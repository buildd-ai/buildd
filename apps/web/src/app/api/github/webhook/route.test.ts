process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── Mock functions ──────────────────────────────────────────────────────────
const mockVerifyWebhookSignature = mock(() => Promise.resolve(true));
const mockGithubApi = mock(() => Promise.resolve(null) as any);
const mockDispatchNewTask = mock(() => Promise.resolve());
const mockBuildCIRetryTask = mock(() => null as any);
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
  allCheckSuitesPassed: mock(() => Promise.resolve(true)),
  mergePullRequest: mock(() => Promise.resolve({ merged: true, message: 'ok' })),
  githubApi: mockGithubApi,
}));

mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: mockDispatchNewTask,
}));

mock.module('@/lib/ci-retry', () => ({
  buildCIRetryTask: mockBuildCIRetryTask,
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
  sql: Object.assign((strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }), {}),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
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
  mockDispatchNewTask.mockReset();
  mockBuildCIRetryTask.mockReset();
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
  mockBuildCIRetryTask.mockReturnValue(null);
  mockGithubApi.mockReturnValue(Promise.resolve({ draft: false }));
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

  // ── Check suite CI failure → retry ──────────────────────────────────────
  describe('check_suite failure handling', () => {
    const workerWithTask = {
      id: 'worker-1',
      branch: 'buildd/task-1-fix-bug',
      prNumber: 42,
      task: {
        id: 'task-1',
        title: 'Fix the bug',
        description: 'Fix it',
        workspaceId: 'ws-1',
        status: 'completed',
        context: { iteration: 0 },
        objectiveId: 'obj-1',
      },
    };

    const workspace = {
      id: 'ws-1',
      repo: 'test-org/test-repo',
      gitConfig: { maxCiRetries: 3 },
    };

    it('creates retry task on CI failure', async () => {
      mockWorkersFindFirst.mockReturnValue(Promise.resolve(workerWithTask));
      mockWorkspacesFindFirst.mockReturnValue(Promise.resolve(workspace));
      mockTasksFindFirst.mockReturnValue(Promise.resolve(null)); // no existing retry
      mockGithubApi.mockReturnValue(Promise.resolve({ draft: false })); // not draft
      mockBuildCIRetryTask.mockReturnValue({
        title: '[CI Retry #1] Fix the bug',
        description: 'CI failed...',
        workspaceId: 'ws-1',
        parentTaskId: 'task-1',
        creationSource: 'webhook',
        objectiveId: 'obj-1',
        context: { iteration: 1, maxIterations: 3, baseBranch: 'buildd/task-1-fix-bug' },
      });

      const req = createWebhookRequest('check_suite', makeCheckSuitePayload());
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(1);
      expect(insertCalls[0].values.title).toBe('[CI Retry #1] Fix the bug');
      expect(insertCalls[0].values.status).toBe('pending');
      expect(insertCalls[0].values.priority).toBe(7);
      expect(insertCalls[0].values.parentTaskId).toBe('task-1');
      expect(insertCalls[0].values.objectiveId).toBe('obj-1');
      expect(insertCalls[0].values.creationSource).toBe('webhook');
      expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
    });

    it('skips retry for draft PRs', async () => {
      mockWorkersFindFirst.mockReturnValue(Promise.resolve(workerWithTask));
      mockWorkspacesFindFirst.mockReturnValue(Promise.resolve(workspace));
      mockGithubApi.mockReturnValue(Promise.resolve({ draft: true })); // draft PR

      const req = createWebhookRequest('check_suite', makeCheckSuitePayload());
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
      expect(mockBuildCIRetryTask).not.toHaveBeenCalled();
    });

    it('skips retry when pending child task already exists (duplicate prevention)', async () => {
      mockWorkersFindFirst.mockReturnValue(Promise.resolve(workerWithTask));
      mockWorkspacesFindFirst.mockReturnValue(Promise.resolve(workspace));
      mockGithubApi.mockReturnValue(Promise.resolve({ draft: false }));
      mockTasksFindFirst.mockReturnValue(Promise.resolve({ id: 'existing-retry-1' })); // existing retry

      const req = createWebhookRequest('check_suite', makeCheckSuitePayload());
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
      expect(mockBuildCIRetryTask).not.toHaveBeenCalled();
    });

    it('marks task as failed when max retries reached', async () => {
      mockWorkersFindFirst.mockReturnValue(Promise.resolve(workerWithTask));
      mockWorkspacesFindFirst.mockReturnValue(Promise.resolve(workspace));
      mockTasksFindFirst.mockReturnValue(Promise.resolve(null));
      mockGithubApi.mockReturnValue(Promise.resolve({ draft: false }));
      mockBuildCIRetryTask.mockReturnValue(null); // max retries reached

      const req = createWebhookRequest('check_suite', makeCheckSuitePayload());
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
      // Task should be marked as failed
      expect(updateCalls.length).toBe(1);
      expect(updateCalls[0].setValues.status).toBe('failed');
      expect(updateCalls[0].setValues.result).toBeDefined();
    });

    it('skips when no worker found for PR', async () => {
      mockWorkersFindFirst.mockReturnValue(Promise.resolve(null)); // no worker

      const req = createWebhookRequest('check_suite', makeCheckSuitePayload());
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
    });

    it('skips when no workspace found for task', async () => {
      mockWorkersFindFirst.mockReturnValue(Promise.resolve(workerWithTask));
      mockWorkspacesFindFirst.mockReturnValue(Promise.resolve(null)); // no workspace

      const req = createWebhookRequest('check_suite', makeCheckSuitePayload());
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(insertCalls.length).toBe(0);
    });

    it('ignores non-completed check_suite actions', async () => {
      const payload = makeCheckSuitePayload();
      payload.action = 'requested';

      const req = createWebhookRequest('check_suite', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockWorkersFindFirst).not.toHaveBeenCalled();
    });

    it('ignores check_suite without installation', async () => {
      const payload = makeCheckSuitePayload();
      delete (payload as any).installation;

      const req = createWebhookRequest('check_suite', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockWorkersFindFirst).not.toHaveBeenCalled();
    });

    it('ignores check_suite with non-failure conclusion', async () => {
      const payload = makeCheckSuitePayload({
        check_suite: { conclusion: 'neutral' },
      });

      const req = createWebhookRequest('check_suite', payload);
      const res = await POST(req);

      expect(res.status).toBe(200);
      // For non-failure, non-success conclusions, no retry and no auto-merge
      expect(insertCalls.length).toBe(0);
    });

    it('passes workspace maxCiRetries to buildCIRetryTask', async () => {
      const wsWithRetries = { ...workspace, gitConfig: { maxCiRetries: 5 } };
      mockWorkersFindFirst.mockReturnValue(Promise.resolve(workerWithTask));
      mockWorkspacesFindFirst.mockReturnValue(Promise.resolve(wsWithRetries));
      mockTasksFindFirst.mockReturnValue(Promise.resolve(null));
      mockGithubApi.mockReturnValue(Promise.resolve({ draft: false }));
      mockBuildCIRetryTask.mockReturnValue(null);

      const req = createWebhookRequest('check_suite', makeCheckSuitePayload());
      await POST(req);

      expect(mockBuildCIRetryTask).toHaveBeenCalledTimes(1);
      const args = mockBuildCIRetryTask.mock.calls[0][0] as any;
      expect(args.workspaceMaxCiRetries).toBe(5);
    });

    it('fetches CI failure logs from GitHub API', async () => {
      mockWorkersFindFirst.mockReturnValue(Promise.resolve(workerWithTask));
      mockWorkspacesFindFirst.mockReturnValue(Promise.resolve(workspace));
      mockTasksFindFirst.mockReturnValue(Promise.resolve(null));

      // Mock githubApi calls in order: draft check, then CI logs
      let callCount = 0;
      mockGithubApi.mockImplementation((_installationId: any, path: string) => {
        callCount++;
        if (path.includes('/pulls/')) {
          return Promise.resolve({ draft: false });
        }
        if (path.includes('/actions/runs?')) {
          return Promise.resolve({
            workflow_runs: [{
              id: 123,
              html_url: 'https://github.com/test-org/test-repo/actions/runs/123',
            }],
          });
        }
        if (path.includes('/actions/runs/123/jobs')) {
          return Promise.resolve({
            jobs: [{
              name: 'build',
              conclusion: 'failure',
              steps: [{ name: 'Run tests', conclusion: 'failure' }],
            }],
          });
        }
        return Promise.resolve(null);
      });

      mockBuildCIRetryTask.mockReturnValue({
        title: '[CI Retry #1] Fix the bug',
        description: 'CI failed...',
        workspaceId: 'ws-1',
        parentTaskId: 'task-1',
        creationSource: 'webhook',
        objectiveId: null,
        context: { iteration: 1 },
      });

      const req = createWebhookRequest('check_suite', makeCheckSuitePayload());
      await POST(req);

      expect(mockBuildCIRetryTask).toHaveBeenCalledTimes(1);
      const args = mockBuildCIRetryTask.mock.calls[0][0] as any;
      // Should contain formatted CI logs, not the generic fallback
      expect(args.failureContext).toContain('Job "build" failed');
      expect(args.failureContext).toContain('Step "Run tests" failed');
    });

    it('falls back to generic message when CI logs unavailable', async () => {
      mockWorkersFindFirst.mockReturnValue(Promise.resolve(workerWithTask));
      mockWorkspacesFindFirst.mockReturnValue(Promise.resolve(workspace));
      mockTasksFindFirst.mockReturnValue(Promise.resolve(null));
      mockGithubApi.mockImplementation((_installationId: any, path: string) => {
        if (path.includes('/pulls/')) {
          return Promise.resolve({ draft: false });
        }
        // CI logs API returns empty
        return Promise.resolve({ workflow_runs: [] });
      });

      mockBuildCIRetryTask.mockReturnValue(null); // will hit max retries

      const req = createWebhookRequest('check_suite', makeCheckSuitePayload());
      await POST(req);

      expect(mockBuildCIRetryTask).toHaveBeenCalledTimes(1);
      const args = mockBuildCIRetryTask.mock.calls[0][0] as any;
      // Should use fallback generic message
      expect(args.failureContext).toContain('CI check suite failed');
      expect(args.failureContext).toContain('test-org/test-repo');
    });
  });
});
