process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── Mock functions ──────────────────────────────────────────────────────────
const mockVerifyWebhookSignature = mock(() => Promise.resolve(true));
const mockGithubApi = mock(() => Promise.resolve(null) as any);
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
  allCheckSuitesPassed: mock(() => Promise.resolve(true)),
  mergePullRequest: mock(() => Promise.resolve({ merged: true, message: 'ok' })),
  githubApi: mockGithubApi,
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
    it('logs CI failure without creating retry tasks', async () => {
      const req = createWebhookRequest('check_suite', makeCheckSuitePayload());
      const res = await POST(req);

      expect(res.status).toBe(200);
      // No retry tasks created — CI retry infrastructure removed
      expect(insertCalls.length).toBe(0);
      expect(mockDispatchNewTask).not.toHaveBeenCalled();
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
});
