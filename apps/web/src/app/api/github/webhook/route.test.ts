process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── Mock functions ──────────────────────────────────────────────────────────
const mockVerifyWebhookSignature = mock(() => Promise.resolve(true));
const mockDispatchNewTask = mock(() => Promise.resolve());
const mockInstallationsFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);

// Track DB operations for assertions
let insertCalls: Array<{ table: any; values: any; conflict: string | null }> = [];
let deleteCalls: Array<{ table: any }> = [];
let updateCalls: Array<{ table: any; setValues: any }> = [];

// ── Module mocks (must be before route import) ──────────────────────────────
mock.module('@/lib/github', () => ({
  verifyWebhookSignature: mockVerifyWebhookSignature,
}));

mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: mockDispatchNewTask,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      githubInstallations: { findFirst: mockInstallationsFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
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
          returning: () => Promise.resolve([{ id: 'inst-1', ...values }]),
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
}));

mock.module('@buildd/core/db/schema', () => ({
  githubInstallations: { id: 'id', installationId: 'installationId' },
  githubRepos: { id: 'id', repoId: 'repoId', installationId: 'installationId' },
  tasks: { externalId: 'externalId' },
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

function makeRepo(overrides: Record<string, any> = {}) {
  return {
    id: 100,
    full_name: 'test-org/test-repo',
    name: 'test-repo',
    private: false,
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

/** Return the last insert call whose values match a given key/value. */
function findInsertCall(key: string, value: any) {
  return insertCalls.find((c) => c.values && c.values[key] === value);
}

/** Return the last update call that set a given key. */
function findUpdateCall(key: string) {
  return updateCalls.find((c) => c.setValues && key in c.setValues);
}

// ── Tests ───────────────────────────────────────────────────────────────────
describe('POST /api/github/webhook', () => {
  beforeEach(() => {
    mockVerifyWebhookSignature.mockReset();
    mockDispatchNewTask.mockReset();
    mockInstallationsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();

    insertCalls = [];
    deleteCalls = [];
    updateCalls = [];

    // Defaults
    mockVerifyWebhookSignature.mockReturnValue(Promise.resolve(true));
    mockDispatchNewTask.mockReturnValue(Promise.resolve());
    mockInstallationsFindFirst.mockReturnValue(null);
    mockWorkspacesFindFirst.mockReturnValue(null);
  });

  // ── 1. Returns 401 on invalid signature ─────────────────────────────────
  it('returns 401 on invalid signature', async () => {
    const req = createWebhookRequest('ping', {}, false);
    const res = await POST(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid signature');
  });

  // ── 2. Returns 200 for ping event ───────────────────────────────────────
  it('returns 200 for ping event', async () => {
    const req = createWebhookRequest('ping', { zen: 'hello' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  // ── 3. Handles installation created ─────────────────────────────────────
  it('handles installation created - inserts installation only', async () => {
    const payload = {
      action: 'created',
      installation: makeInstallation(),
    };

    const req = createWebhookRequest('installation', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    // Only one insert: the installation itself (onConflictDoUpdate, no returning)
    expect(insertCalls.length).toBe(1);
    const installationInsert = insertCalls[0];
    expect(installationInsert.values.installationId).toBe(12345);
    expect(installationInsert.conflict).toBe('update');
  });

  // ── 4. Handles installation deleted ─────────────────────────────────────
  it('handles installation deleted', async () => {
    const payload = {
      action: 'deleted',
      installation: makeInstallation(),
    };

    const req = createWebhookRequest('installation', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(deleteCalls.length).toBe(1);
  });

  // ── 5. Handles installation suspend / unsuspend ─────────────────────────
  it('handles installation suspend', async () => {
    const payload = {
      action: 'suspend',
      installation: makeInstallation(),
    };

    const req = createWebhookRequest('installation', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].setValues.suspendedAt).toBeInstanceOf(Date);
    expect(updateCalls[0].setValues.updatedAt).toBeInstanceOf(Date);
  });

  it('handles installation unsuspend', async () => {
    const payload = {
      action: 'unsuspend',
      installation: makeInstallation(),
    };

    const req = createWebhookRequest('installation', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].setValues.suspendedAt).toBeNull();
    expect(updateCalls[0].setValues.updatedAt).toBeInstanceOf(Date);
  });

  // ── 6. Handles installation_repositories removed ────────────────────────
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

  // ── 7. Handles issues opened with buildd label ──────────────────────────
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

    const taskInsert = insertCalls[0];
    expect(taskInsert.values.workspaceId).toBe('ws-1');
    expect(taskInsert.values.title).toBe('Test Issue');
    expect(taskInsert.values.description).toBe('Issue body content');
    expect(taskInsert.values.externalId).toBe('issue-999');
    expect(taskInsert.values.externalUrl).toBe('https://github.com/test-org/test-repo/issues/42');
    expect(taskInsert.values.status).toBe('pending');
    expect(taskInsert.values.mode).toBe('execution');
    expect(taskInsert.values.creationSource).toBe('github');
    expect(taskInsert.values.createdByAccountId).toBeNull();
    expect(taskInsert.conflict).toBe('nothing');

    // dispatchNewTask should have been called with the new task and workspace
    expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
  });

  // ── 8. Handles issues opened WITHOUT buildd label ───────────────────────
  it('handles issues opened without buildd label - no task created', async () => {
    mockWorkspacesFindFirst.mockReturnValue(
      Promise.resolve({ id: 'ws-1', repo: 'test-org/test-repo' })
    );

    const payload = {
      action: 'opened',
      issue: makeIssue({ labels: [{ name: 'bug' }, { name: 'enhancement' }] }),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(insertCalls.length).toBe(0);
  });

  // ── 9. Handles issues opened with buildd:plan label ────────────────────
  it('handles issues opened with buildd:plan label - creates planning mode task', async () => {
    mockWorkspacesFindFirst.mockReturnValue(
      Promise.resolve({ id: 'ws-1', repo: 'test-org/test-repo' })
    );

    const payload = {
      action: 'opened',
      issue: makeIssue({ labels: [{ name: 'buildd' }, { name: 'buildd:plan' }] }),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      installation: { id: 5000 },
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0].values.mode).toBe('planning');
  });

  // ── 10. Handles issues closed ───────────────────────────────────────────
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
    expect(updateCalls[0].setValues.updatedAt).toBeInstanceOf(Date);
  });

  // ── 11. Handles issues reopened ─────────────────────────────────────────
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
    expect(updateCalls[0].setValues.updatedAt).toBeInstanceOf(Date);
  });

  // ── 12. Ignores issues event without installation ───────────────────────
  it('ignores issues event without installation', async () => {
    const payload = {
      action: 'opened',
      issue: makeIssue(),
      repository: { id: 100, full_name: 'test-org/test-repo' },
      // No installation field
    };

    const req = createWebhookRequest('issues', payload);
    const res = await POST(req);

    expect(res.status).toBe(200);
    // No DB operations should have been attempted
    expect(insertCalls.length).toBe(0);
    expect(updateCalls.length).toBe(0);
    expect(deleteCalls.length).toBe(0);
    // findFirst for workspaces should not even be called
    expect(mockWorkspacesFindFirst).not.toHaveBeenCalled();
  });

  // ── 13. Returns 500 when handler throws ─────────────────────────────────
  it('returns 500 when handler throws', async () => {
    // Make the workspace findFirst throw to simulate an error in the handler
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
    const body = await res.json();
    expect(body.error).toBe('Webhook processing failed');
  });

  // ── Additional edge-case coverage ───────────────────────────────────────
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
    expect(insertCalls[0].values.title).toBe('Test Issue');
    expect(insertCalls[0].values.mode).toBe('execution');
  });

  it('returns 200 for unhandled event types', async () => {
    const req = createWebhookRequest('push', { ref: 'refs/heads/main' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('ignores issues when no workspace is linked to the repo', async () => {
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
});
