import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindMany = mock(() => [] as any[]);
const mockTasksFindMany = mock(() => [] as any[]);
const mockTasksFindFirst = mock(() => null as any);
const mockWorkersUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockTasksUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockHeartbeatsDelete = mock(() => ({
  where: mock(() => ({
    returning: mock(() => []),
  })),
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

const mockCleanupStaleWorkers = mock(() => Promise.resolve());
const mockCleanupStuckWaitingInput = mock(() => Promise.resolve({ failedWorkers: 0, retriedTasks: 0 }));
mock.module('@/lib/stale-workers', () => ({
  cleanupStaleWorkers: mockCleanupStaleWorkers,
  cleanupStuckWaitingInput: mockCleanupStuckWaitingInput,
}));

// Mock worker-deliverables to prevent cross-file mock contamination from stale-workers.test.ts
const mockGetWorkerArtifactCount = mock(() => Promise.resolve(0));
const mockCheckWorkerDeliverables = mock(() => ({
  hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none',
}));
mock.module('@/lib/worker-deliverables', () => ({
  checkWorkerDeliverables: mockCheckWorkerDeliverables,
  getWorkerArtifactCount: mockGetWorkerArtifactCount,
}));

// A task the retry cap fails must still cascade to its dependents — otherwise
// they sit pending forever behind a task that will never complete.
const mockResolveCompletedTask = mock((_taskId: string, _workspaceId: string) => Promise.resolve());
mock.module('@/lib/task-dependencies', () => ({
  resolveCompletedTask: mockResolveCompletedTask,
}));

const mockReleaseAndNotify = mock((_taskId: string, _reason: string) => Promise.resolve());
mock.module('@/lib/path-claim-release', () => ({
  releaseAndNotify: mockReleaseAndNotify,
}));

const mockHeartbeatsFindMany = mock(() => [] as any[]);
const mockAccountsFindMany = mock(() => [] as any[]);
const mockWorkspacesFindMany = mock(() => [] as any[]);

// The caller's reach: every team the session user belongs to, or the API
// key's own team. The route turns this into account/workspace id sets.
const mockResolveAccountTeamIds = mock((_user: any, _apiAccount: any) => Promise.resolve(['team-a']));
mock.module('@/lib/team-access', () => ({
  resolveAccountTeamIds: mockResolveAccountTeamIds,
}));

// Tables are proxies so every column reference is a readable string
// (e.g. 'workers.accountId') — that keeps the WHERE scoping observable
// through the stubbed predicate builders below.
function table(name: string): any {
  return new Proxy({ __table: name }, {
    get: (target: any, prop) => (prop in target ? target[prop] : `${name}.${String(prop)}`),
  });
}
const workersTable = table('workers');
const tasksTable = table('tasks');
const heartbeatsTable = table('workerHeartbeats');
const accountsTable = table('accounts');
const workspacesTable = table('workspaces');

/** Every inArray(field, values) predicate nested anywhere in a where clause. */
function inArrays(where: any): Array<{ field: string; values: any[] }> {
  if (!where || typeof where !== 'object') return [];
  if (where.type === 'inArray') return [{ field: where.field, values: where.values }];
  if (where.type === 'and') return where.args.flatMap(inArrays);
  return [];
}

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      tasks: { findMany: mockTasksFindMany, findFirst: mockTasksFindFirst },
      workerHeartbeats: { findMany: mockHeartbeatsFindMany },
      accounts: { findMany: mockAccountsFindMany },
      workspaces: { findMany: mockWorkspacesFindMany },
    },
    update: (t: any) => {
      if (t === workersTable) return mockWorkersUpdate();
      return mockTasksUpdate();
    },
    delete: () => mockHeartbeatsDelete(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  lt: (field: any, value: any) => ({ field, value, type: 'lt' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: workersTable,
  tasks: tasksTable,
  workerHeartbeats: heartbeatsTable,
  accounts: accountsTable,
  workspaces: workspacesTable,
}));

import { POST } from './route';

function createMockRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/tasks/cleanup', {
    method: 'POST',
    headers: new Headers(headers),
  });
}

describe('POST /api/tasks/cleanup', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindMany.mockReset();
    mockTasksFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindFirst.mockResolvedValue({ context: {}, workspaceId: 'ws-1' });
    mockResolveCompletedTask.mockReset();
    mockResolveCompletedTask.mockResolvedValue(undefined);
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockHeartbeatsFindMany.mockReset();
    mockHeartbeatsDelete.mockReset();
    mockCleanupStaleWorkers.mockReset();
    mockCleanupStaleWorkers.mockResolvedValue(undefined);
    mockCleanupStuckWaitingInput.mockReset();
    mockCleanupStuckWaitingInput.mockResolvedValue({ failedWorkers: 0, retriedTasks: 0 });
    mockReleaseAndNotify.mockReset();
    mockReleaseAndNotify.mockResolvedValue(undefined);
    mockGetWorkerArtifactCount.mockReset();
    mockGetWorkerArtifactCount.mockResolvedValue(0);
    mockCheckWorkerDeliverables.mockReset();
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none',
    });

    // Default: no stale heartbeats
    mockHeartbeatsFindMany.mockResolvedValue([]);

    // Default caller scope: team-a, which owns account-1 and ws-1.
    mockResolveAccountTeamIds.mockReset();
    mockResolveAccountTeamIds.mockResolvedValue(['team-a']);
    mockAccountsFindMany.mockReset();
    mockAccountsFindMany.mockResolvedValue([{ id: 'account-1' }]);
    mockWorkspacesFindMany.mockReset();
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);

    // Default mock chains
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
    mockHeartbeatsDelete.mockReturnValue({
      where: mock(() => ({
        returning: mock(() => []),
      })),
    });
  });

  it('returns 401 when no session and no admin token', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest();
    const res = await POST(req);

    expect(res.status).toBe(401);
  });

  it('returns 401 when API key is worker level', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', level: 'worker' });

    const req = createMockRequest({ Authorization: 'Bearer bld_test' });
    const res = await POST(req);

    expect(res.status).toBe(401);
  });

  it('allows session auth', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockWorkersFindMany.mockResolvedValue([]);
    mockTasksFindMany.mockResolvedValue([]);

    const req = createMockRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cleaned).toBeDefined();
  });

  it('allows admin API token', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', level: 'admin' });
    mockWorkersFindMany.mockResolvedValue([]);
    mockTasksFindMany.mockResolvedValue([]);

    const req = createMockRequest({ Authorization: 'Bearer bld_admin' });
    const res = await POST(req);

    expect(res.status).toBe(200);
  });

  it('returns cleanup counts when nothing to clean', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockWorkersFindMany.mockResolvedValue([]); // No stalled workers
    mockTasksFindMany.mockResolvedValue([]); // No orphaned tasks

    const req = createMockRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cleaned.stalledWorkers).toBe(0);
    expect(data.cleaned.orphanedTasks).toBe(0);
    expect(data.cleaned.heartbeatOrphans).toBe(0);
    expect(data.cleaned.staleHeartbeats).toBe(0);
  });

  it('cleans up stalled workers', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);

    // First findMany: stalled running workers
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'w1', status: 'running', updatedAt: new Date(0) },
        { id: 'w2', status: 'starting', updatedAt: new Date(0) },
      ])
      // Second findMany: active account IDs for per-account cleanup
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([]);

    const req = createMockRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cleaned.stalledWorkers).toBe(2);
  });

  // Path-claims leak regression: these workers are terminated here, outside
  // PATCH /api/workers/[id], so this sweep must release their path claims
  // itself — otherwise a stale claim blocks any sibling task overlapping the
  // same files forever.
  it('releases path claims for stalled workers with a task', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);

    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'w1', taskId: 'task-1', status: 'running', updatedAt: new Date(0) },
        { id: 'w2', taskId: 'task-2', status: 'starting', updatedAt: new Date(0) },
      ])
      .mockResolvedValueOnce([]); // active account IDs

    mockTasksFindMany.mockResolvedValue([]);

    const req = createMockRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockReleaseAndNotify).toHaveBeenCalledTimes(2);
    expect(mockReleaseAndNotify).toHaveBeenCalledWith('task-1', 'abandoned');
    expect(mockReleaseAndNotify).toHaveBeenCalledWith('task-2', 'abandoned');
  });

  it('includes stuck waiting_input counts in response', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockWorkersFindMany
      .mockResolvedValueOnce([])                            // stalled running
      .mockResolvedValueOnce([{ accountId: 'account-1' }])  // active accounts
      .mockResolvedValue([]);
    mockTasksFindMany.mockResolvedValue([]);
    mockCleanupStuckWaitingInput.mockResolvedValue({ failedWorkers: 3, retriedTasks: 2 });

    const req = createMockRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cleaned.stuckWaitingInput).toBe(3);
    expect(data.cleaned.retriedTasks).toBe(2);
  });

  it('sweeps waiting_input per account instead of globally', async () => {
    // The sweep used to be called once with no arguments and queried every
    // account's waiting_input workers, so this endpoint timed out other
    // tenants' workers. It now runs once per account the route already
    // resolved for cleanupStaleWorkers.
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockWorkersFindMany
      .mockResolvedValueOnce([])  // stalled running
      .mockResolvedValueOnce([    // active accounts
        { accountId: 'account-1' },
        { accountId: 'account-2' },
      ])
      .mockResolvedValue([]);
    mockTasksFindMany.mockResolvedValue([]);
    mockCleanupStuckWaitingInput.mockResolvedValue({ failedWorkers: 1, retriedTasks: 1 });

    const req = createMockRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    // Aggregated across both accounts, not a single global pass.
    expect(data.cleaned.stuckWaitingInput).toBe(2);
    expect(data.cleaned.retriedTasks).toBe(2);
    expect(mockCleanupStuckWaitingInput).toHaveBeenCalledTimes(2);
    expect(mockCleanupStuckWaitingInput).toHaveBeenCalledWith('account-1');
    expect(mockCleanupStuckWaitingInput).toHaveBeenCalledWith('account-2');
  });

  it('clears claimedBy, claimedAt, and expiresAt when resetting orphaned tasks to pending', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);

    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);

    // Call sequence for mockWorkersFindMany:
    // 1. Stalled running workers → empty
    // 2. Workers for orphan task → all failed (no active)
    // 3. resetOrFailTask failure-count → 1 prior failure (under MAX_TASK_FAILURES)
    // 4. Active account IDs for per-account cleanup → empty
    mockWorkersFindMany
      .mockResolvedValueOnce([])  // stalled running
      .mockResolvedValueOnce([{ id: 'w-old', status: 'failed' }])  // task workers - all failed
      .mockResolvedValueOnce([{ id: 'w-old' }])  // resetOrFailTask prior failures count
      .mockResolvedValueOnce([]);  // active account IDs

    // Orphaned task: assigned, stale > 2 hours
    mockTasksFindMany.mockResolvedValue([
      {
        id: 'orphan-task-1',
        status: 'assigned',
        claimedBy: 'account-1',
        claimedAt: new Date(),
        expiresAt: new Date(),
        updatedAt: threeHoursAgo,
      },
    ]);

    // Capture the set() argument for the task update
    let capturedSetData: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((data: any) => {
        capturedSetData = data;
        return {
          where: mock(() => Promise.resolve()),
        };
      }),
    });

    const req = createMockRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    // Verify claim fields were cleared so task is claimable again
    expect(capturedSetData).not.toBeNull();
    expect(capturedSetData.status).toBe('pending');
    expect(capturedSetData.claimedBy).toBeNull();
    expect(capturedSetData.claimedAt).toBeNull();
    expect(capturedSetData.expiresAt).toBeNull();
  });

  it('marks task failed (not pending) once worker failures hit the retry cap', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);

    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);

    // Sequence: stalled empty → task workers (all failed) → prior failures (3, at cap) → active accounts empty
    mockWorkersFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'w-old', status: 'failed' }])
      .mockResolvedValueOnce([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }])  // at cap
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([
      {
        id: 'loop-task',
        status: 'assigned',
        claimedBy: 'account-1',
        claimedAt: new Date(),
        expiresAt: new Date(),
        updatedAt: threeHoursAgo,
      },
    ]);
    mockTasksFindFirst.mockResolvedValue({ context: { prior: 'context' }, workspaceId: 'ws-1' });

    let capturedSetData: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((data: any) => {
        capturedSetData = data;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    const req = createMockRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(capturedSetData).not.toBeNull();
    expect(capturedSetData.status).toBe('failed');
    expect(capturedSetData.context.terminalError).toBe('retry_cap_exceeded');
    expect(capturedSetData.context.prior).toBe('context');  // preserves existing context
  });

  it('cascades to dependents when the retry cap fails a task', async () => {
    // Regression: this writer set status='failed' without calling
    // resolveCompletedTask, so cascadeDependencyFailure never ran and every
    // task depending on it stayed pending forever behind a task that can
    // never complete ('failed' is not in DEP_SATISFYING_STATUSES).
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);

    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);

    mockWorkersFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'w-old', status: 'failed' }])
      .mockResolvedValueOnce([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]) // at cap
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([
      {
        id: 'loop-task',
        status: 'assigned',
        claimedBy: 'account-1',
        claimedAt: new Date(),
        expiresAt: new Date(),
        updatedAt: threeHoursAgo,
      },
    ]);
    mockTasksFindFirst.mockResolvedValue({ context: {}, workspaceId: 'ws-9' });

    const res = await POST(createMockRequest());

    expect(res.status).toBe(200);
    expect(mockResolveCompletedTask).toHaveBeenCalledTimes(1);
    expect(mockResolveCompletedTask.mock.calls[0]).toEqual(['loop-task', 'ws-9']);
  });

  it('does not cascade when the task is only reset to pending', async () => {
    // Under the cap the task returns to pending — a non-terminal state. Firing
    // the terminal resolver here would cascade a failure that never happened.
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);

    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);

    mockWorkersFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'w-old', status: 'failed' }])
      .mockResolvedValueOnce([{ id: 'w-old' }]) // 1 prior failure, under cap
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([
      {
        id: 'retryable-task',
        status: 'assigned',
        claimedBy: 'account-1',
        claimedAt: new Date(),
        expiresAt: new Date(),
        updatedAt: threeHoursAgo,
      },
    ]);

    const res = await POST(createMockRequest());

    expect(res.status).toBe(200);
    expect(mockResolveCompletedTask).not.toHaveBeenCalled();
  });

  it('survives a cascade failure without aborting the cleanup pass', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);

    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);

    mockWorkersFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'w-old', status: 'failed' }])
      .mockResolvedValueOnce([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }])
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([
      {
        id: 'loop-task',
        status: 'assigned',
        claimedBy: 'account-1',
        claimedAt: new Date(),
        expiresAt: new Date(),
        updatedAt: threeHoursAgo,
      },
    ]);
    mockResolveCompletedTask.mockRejectedValue(new Error('cascade blew up'));

    const res = await POST(createMockRequest());

    expect(res.status).toBe(200);
  });

  it('fails workers when their heartbeat is stale (runner offline)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);

    // No stalled running/starting workers
    mockWorkersFindMany
      .mockResolvedValueOnce([])  // stalled running
      .mockResolvedValueOnce([])  // active account IDs for per-account cleanup
      // heartbeat orphan check: workers with stale heartbeat accounts
      .mockResolvedValueOnce([
        { id: 'w1', taskId: 'task-1' },
        { id: 'w2', taskId: 'task-2' },
      ])
      // resetOrFailTask prior-failure counts (one per orphan task, both under cap)
      .mockResolvedValueOnce([{ id: 'w1' }])
      .mockResolvedValueOnce([{ id: 'w2' }]);

    mockTasksFindMany
      .mockResolvedValueOnce([]) // No orphaned assigned tasks
      // Both orphan tasks are in the caller's workspaces
      .mockResolvedValueOnce([{ id: 'task-1' }, { id: 'task-2' }]);
    mockTasksUpdate.mockClear();

    // Stale heartbeats found
    mockHeartbeatsFindMany.mockResolvedValue([
      { id: 'hb-1', accountId: 'account-offline' },
    ]);

    const req = createMockRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cleaned.heartbeatOrphans).toBe(2);
    // Both in-scope tasks were reset to pending.
    expect(mockTasksUpdate).toHaveBeenCalledTimes(2);
    // Path-claims leak regression: these workers are terminated here, outside
    // PATCH /api/workers/[id], so this sweep must release their path claims
    // itself.
    expect(mockReleaseAndNotify).toHaveBeenCalledTimes(2);
    expect(mockReleaseAndNotify).toHaveBeenCalledWith('task-1', 'abandoned');
    expect(mockReleaseAndNotify).toHaveBeenCalledWith('task-2', 'abandoned');
  });

  it('releases path claims with pending_merge when a heartbeat-orphaned worker had an open PR', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);

    mockWorkersFindMany
      .mockResolvedValueOnce([])  // stalled running
      .mockResolvedValueOnce([])  // active account IDs
      .mockResolvedValueOnce([
        { id: 'w1', taskId: 'task-1', prNumber: 42 },
      ]);

    mockTasksFindMany
      .mockResolvedValueOnce([]) // No orphaned assigned tasks
      .mockResolvedValueOnce([{ id: 'task-1' }]);
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: true, hasArtifacts: false, hasStructuredOutput: false, hasCommits: true, hasAny: true, details: 'pr',
    });

    mockHeartbeatsFindMany.mockResolvedValue([
      { id: 'hb-1', accountId: 'account-offline' },
    ]);

    const req = createMockRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockReleaseAndNotify).toHaveBeenCalledWith('task-1', 'pending_merge');
  });
});

describe('POST /api/tasks/cleanup — caller scope', () => {
  // Reuses the module-level mocks; reset the ones these tests read.
  beforeEach(() => {
    for (const m of [mockGetCurrentUser, mockAuthenticateApiKey, mockWorkersFindMany, mockTasksFindMany,
      mockHeartbeatsFindMany, mockAccountsFindMany, mockWorkspacesFindMany, mockResolveAccountTeamIds,
      mockCleanupStaleWorkers, mockCleanupStuckWaitingInput, mockHeartbeatsDelete] as any[]) m.mockReset();
    mockWorkersFindMany.mockResolvedValue([]);
    mockTasksFindMany.mockResolvedValue([]);
    mockTasksFindFirst.mockResolvedValue({ context: {}, workspaceId: 'ws-a' });
    mockHeartbeatsFindMany.mockResolvedValue([]);
    mockCleanupStaleWorkers.mockResolvedValue(undefined);
    mockCleanupStuckWaitingInput.mockResolvedValue({ failedWorkers: 0, retriedTasks: 0 });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
    mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
    mockHeartbeatsDelete.mockReturnValue({ where: mock(() => ({ returning: mock(() => []) })) });
  });

  function adminKeyForTeamA() {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-a', teamId: 'team-a', level: 'admin' });
    mockResolveAccountTeamIds.mockResolvedValue(['team-a']);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-a' }]);
    // Team A has a second account; an API key still only reaches its own.
    mockAccountsFindMany.mockResolvedValue([{ id: 'account-a' }, { id: 'account-a2' }]);
  }

  it("does not touch other tenants' stalled workers or assigned tasks", async () => {
    adminKeyForTeamA();

    await POST(createMockRequest({ Authorization: 'Bearer bld_admin' }));

    // Phase 1: the stalled-worker query is bounded to the key's own account.
    const stalledWhere = (mockWorkersFindMany.mock.calls[0] as any[])[0].where;
    expect(inArrays(stalledWhere)).toContainEqual({ field: 'workers.accountId', values: ['account-a'] });

    // Phase 2: the assigned-task query is bounded to the caller's workspaces.
    const assignedWhere = (mockTasksFindMany.mock.calls[0] as any[])[0].where;
    expect(inArrays(assignedWhere)).toContainEqual({ field: 'tasks.workspaceId', values: ['ws-a'] });
    expect(mockResolveAccountTeamIds).toHaveBeenCalled();
  });

  it('runs the per-account sweeps only for accounts in scope', async () => {
    adminKeyForTeamA();
    mockWorkersFindMany
      .mockResolvedValueOnce([])                           // stalled running
      .mockResolvedValueOnce([{ accountId: 'account-a' }]) // active accounts (scoped by the query)
      .mockResolvedValue([]);

    await POST(createMockRequest({ Authorization: 'Bearer bld_admin' }));

    const activeWhere = (mockWorkersFindMany.mock.calls[1] as any[])[0].where;
    expect(inArrays(activeWhere)).toContainEqual({ field: 'workers.accountId', values: ['account-a'] });
    expect(mockCleanupStaleWorkers.mock.calls.map(c => (c as any[])[0])).toEqual(['account-a']);
  });

  it('scopes session callers to their own teams', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-a' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockResolveAccountTeamIds.mockResolvedValue(['team-a']);
    mockAccountsFindMany.mockResolvedValue([{ id: 'account-a' }, { id: 'account-a2' }]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-a' }]);

    await POST(createMockRequest());

    expect(mockResolveAccountTeamIds).toHaveBeenCalledWith({ id: 'user-a' }, null);
    const accountsWhere = (mockAccountsFindMany.mock.calls[0] as any[])[0].where;
    expect(inArrays(accountsWhere)).toContainEqual({ field: 'accounts.teamId', values: ['team-a'] });
    const workspacesWhere = (mockWorkspacesFindMany.mock.calls[0] as any[])[0].where;
    expect(inArrays(workspacesWhere)).toContainEqual({ field: 'workspaces.teamId', values: ['team-a'] });

    const stalledWhere = (mockWorkersFindMany.mock.calls[0] as any[])[0].where;
    expect(inArrays(stalledWhere)).toContainEqual({ field: 'workers.accountId', values: ['account-a', 'account-a2'] });
    const assignedWhere = (mockTasksFindMany.mock.calls[0] as any[])[0].where;
    expect(inArrays(assignedWhere)).toContainEqual({ field: 'tasks.workspaceId', values: ['ws-a'] });
  });

  it('only reads and deletes heartbeats for the caller account', async () => {
    adminKeyForTeamA();
    const deleteWhere = mock((_w: any) => ({ returning: mock(() => []) }));
    mockHeartbeatsDelete.mockReturnValue({ where: deleteWhere });

    await POST(createMockRequest({ Authorization: 'Bearer bld_admin' }));

    const hbWhere = (mockHeartbeatsFindMany.mock.calls[0] as any[])[0].where;
    expect(inArrays(hbWhere)).toContainEqual({ field: 'workerHeartbeats.accountId', values: ['account-a'] });
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    expect(inArrays(deleteWhere.mock.calls[0][0])).toContainEqual({
      field: 'workerHeartbeats.accountId', values: ['account-a'],
    });
  });

  it("does not reset a stalled worker's task that lives outside the caller's workspaces", async () => {
    adminKeyForTeamA();
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-b' }]) // stalled running (own account)
      .mockResolvedValue([]);
    // The DB applies the workspace filter; a task in another team's workspace is not returned.
    mockTasksFindMany.mockResolvedValue([]);
    mockTasksUpdate.mockClear();

    await POST(createMockRequest({ Authorization: 'Bearer bld_admin' }));

    const stillAssignedWhere = (mockTasksFindMany.mock.calls[0] as any[])[0].where;
    expect(inArrays(stillAssignedWhere)).toContainEqual({ field: 'tasks.id', values: ['task-b'] });
    expect(inArrays(stillAssignedWhere)).toContainEqual({ field: 'tasks.workspaceId', values: ['ws-a'] });
    expect(mockTasksUpdate).not.toHaveBeenCalled();
  });

  it("does not change a heartbeat orphan's task that lives outside the caller's workspaces", async () => {
    adminKeyForTeamA();
    mockHeartbeatsFindMany.mockResolvedValue([{ id: 'hb-1', accountId: 'account-a' }]);
    mockWorkersFindMany
      .mockResolvedValueOnce([])                               // stalled running
      .mockResolvedValueOnce([])                               // active accounts
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-b' }]) // heartbeat orphans (own account)
      .mockResolvedValue([]);
    mockTasksFindMany.mockResolvedValue([]);
    mockTasksUpdate.mockClear();

    const res = await POST(createMockRequest({ Authorization: 'Bearer bld_admin' }));

    // The orphaned worker itself is still the caller's to fail...
    expect((await res.json()).cleaned.heartbeatOrphans).toBe(1);
    // ...but its task is only touched if it is in one of the caller's workspaces.
    const lookup = mockTasksFindMany.mock.calls
      .map(c => inArrays((c as any[])[0].where))
      .find(preds => preds.some(p => p.field === 'tasks.id'));
    expect(lookup).toBeDefined();
    expect(lookup).toContainEqual({ field: 'tasks.id', values: ['task-b'] });
    expect(lookup).toContainEqual({ field: 'tasks.workspaceId', values: ['ws-a'] });
    expect(mockTasksUpdate).not.toHaveBeenCalled();
  });

  it('touches nothing when the caller has no accounts or workspaces in scope', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-lonely' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockResolveAccountTeamIds.mockResolvedValue([]);
    mockAccountsFindMany.mockResolvedValue([]);
    mockWorkspacesFindMany.mockResolvedValue([]);

    const res = await POST(createMockRequest());

    expect(res.status).toBe(200);
    expect(mockWorkersFindMany).not.toHaveBeenCalled();
    expect(mockTasksFindMany).not.toHaveBeenCalled();
    expect(mockHeartbeatsFindMany).not.toHaveBeenCalled();
    expect(mockHeartbeatsDelete).not.toHaveBeenCalled();
    expect(mockCleanupStaleWorkers).not.toHaveBeenCalled();
  });
});
