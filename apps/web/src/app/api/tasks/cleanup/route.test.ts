import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindMany = mock(() => [] as any[]);
const mockTasksFindMany = mock(() => [] as any[]);
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

const mockHeartbeatsFindMany = mock(() => [] as any[]);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      tasks: { findMany: mockTasksFindMany },
      workerHeartbeats: { findMany: mockHeartbeatsFindMany },
    },
    update: (table: any) => {
      if (table === 'workers') return mockWorkersUpdate();
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
  workers: 'workers',
  tasks: 'tasks',
  workerHeartbeats: { id: 'id', accountId: 'accountId', lastHeartbeatAt: 'lastHeartbeatAt' },
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
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockHeartbeatsFindMany.mockReset();
    mockHeartbeatsDelete.mockReset();
    mockCleanupStaleWorkers.mockReset();
    mockCleanupStaleWorkers.mockResolvedValue(undefined);
    mockCleanupStuckWaitingInput.mockReset();
    mockCleanupStuckWaitingInput.mockResolvedValue({ failedWorkers: 0, retriedTasks: 0 });
    mockGetWorkerArtifactCount.mockReset();
    mockGetWorkerArtifactCount.mockResolvedValue(0);
    mockCheckWorkerDeliverables.mockReset();
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none',
    });

    // Default: no stale heartbeats
    mockHeartbeatsFindMany.mockResolvedValue([]);

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

  it('includes stuck waiting_input counts in response', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockWorkersFindMany.mockResolvedValue([]);
    mockTasksFindMany.mockResolvedValue([]);
    mockCleanupStuckWaitingInput.mockResolvedValue({ failedWorkers: 3, retriedTasks: 2 });

    const req = createMockRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cleaned.stuckWaitingInput).toBe(3);
    expect(data.cleaned.retriedTasks).toBe(2);
  });

  it('clears claimedBy, claimedAt, and expiresAt when resetting orphaned tasks to pending', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);

    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);

    // Call sequence for mockWorkersFindMany:
    // 1. Stalled running workers → empty
    // 2. Workers for orphan task → all failed (no active)
    // 3. Active account IDs for per-account cleanup → empty
    mockWorkersFindMany
      .mockResolvedValueOnce([])  // stalled running
      .mockResolvedValueOnce([{ id: 'w-old', status: 'failed' }])  // task workers - all failed
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
      ]);

    mockTasksFindMany.mockResolvedValue([]); // No orphaned tasks

    // Stale heartbeats found
    mockHeartbeatsFindMany.mockResolvedValue([
      { id: 'hb-1', accountId: 'account-offline' },
    ]);

    const req = createMockRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cleaned.heartbeatOrphans).toBe(2);
  });
});
