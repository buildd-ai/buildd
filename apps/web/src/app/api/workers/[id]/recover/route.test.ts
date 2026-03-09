import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// --- Mocks ---
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetCurrentUser = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockWorkersFindMany = mock(() => [] as any[]);
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
const mockTriggerEvent = mock(() => Promise.resolve());
const mockDiagnoseWorker = mock(() => Promise.resolve({
  workerId: 'w1',
  taskId: 't1',
  diagnosis: 'Test diagnosis',
  recommendedAction: 'restart',
  confidence: 'high',
  details: {
    workerStatus: 'failed',
    staleDurationMs: 1000,
    hasProgress: false,
    hasPR: false,
    hasCommits: false,
    lastAction: null,
    error: null,
  },
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: {
    workspace: (id: string) => `workspace-${id}`,
    worker: (id: string) => `worker-${id}`,
  },
  events: {
    WORKER_COMMAND: 'worker:command',
    WORKER_COMPLETED: 'worker:completed',
    WORKER_FAILED: 'worker:failed',
  },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: {
        findFirst: mockWorkersFindFirst,
        findMany: mockWorkersFindMany,
      },
    },
    update: (table: any) => {
      if (table === 'workers') return mockWorkersUpdate();
      return mockTasksUpdate();
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers',
  tasks: 'tasks',
}));

mock.module('@/lib/worker-doctor', () => ({
  diagnoseWorker: mockDiagnoseWorker,
}));

import { GET, POST } from './route';

const makeRequest = (method: string, body?: any) =>
  new NextRequest(`http://localhost/api/workers/w1/recover`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-key',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const mockWorker = {
  id: 'w1',
  taskId: 't1',
  accountId: 'acc1',
  workspaceId: 'ws1',
  status: 'running',
  workspace: { id: 'ws1' },
  task: { id: 't1' },
};

describe('GET /api/workers/[id]/recover', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockGetCurrentUser.mockReset();
    mockWorkersFindFirst.mockReset();
    mockDiagnoseWorker.mockReset();

    mockGetCurrentUser.mockResolvedValue(null);
  });

  it('returns 401 when unauthorized', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const req = makeRequest('GET');
    const res = await GET(req, { params: Promise.resolve({ id: 'w1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 when worker not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc1' });
    mockWorkersFindFirst.mockResolvedValue(null);
    const req = makeRequest('GET');
    const res = await GET(req, { params: Promise.resolve({ id: 'w1' }) });
    expect(res.status).toBe(404);
  });

  it('returns diagnosis for valid worker', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc1' });
    mockWorkersFindFirst.mockResolvedValue(mockWorker);
    mockDiagnoseWorker.mockResolvedValue({
      workerId: 'w1',
      taskId: 't1',
      diagnosis: 'Worker failed, restart recommended.',
      recommendedAction: 'restart',
      confidence: 'high',
      details: {
        workerStatus: 'failed',
        staleDurationMs: 5000,
        hasProgress: false,
        hasPR: false,
        hasCommits: false,
        lastAction: null,
        error: 'timeout',
      },
    });

    const req = makeRequest('GET');
    const res = await GET(req, { params: Promise.resolve({ id: 'w1' }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.recommendedAction).toBe('restart');
    expect(json.diagnosis).toContain('restart');
  });
});

describe('POST /api/workers/[id]/recover', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockGetCurrentUser.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkersFindMany.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockTriggerEvent.mockReset();

    mockGetCurrentUser.mockResolvedValue(null);
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
  });

  it('returns 401 when unauthorized', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    const req = makeRequest('POST', { mode: 'diagnose' });
    const res = await POST(req, { params: Promise.resolve({ id: 'w1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid mode', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc1' });
    mockWorkersFindFirst.mockResolvedValue(mockWorker);
    const req = makeRequest('POST', { mode: 'invalid' });
    const res = await POST(req, { params: Promise.resolve({ id: 'w1' }) });
    expect(res.status).toBe(400);
  });

  it('diagnose: sends command to runner via Pusher', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc1' });
    mockWorkersFindFirst.mockResolvedValue(mockWorker);
    const req = makeRequest('POST', { mode: 'diagnose' });
    const res = await POST(req, { params: Promise.resolve({ id: 'w1' }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode).toBe('diagnose');
    expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
  });

  it('diagnose: returns 400 for terminal worker', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc1' });
    mockWorkersFindFirst.mockResolvedValue({ ...mockWorker, status: 'completed' });
    const req = makeRequest('POST', { mode: 'diagnose' });
    const res = await POST(req, { params: Promise.resolve({ id: 'w1' }) });
    expect(res.status).toBe(400);
  });

  it('complete: updates worker and task status', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc1' });
    mockWorkersFindFirst.mockResolvedValue(mockWorker);
    const req = makeRequest('POST', { mode: 'complete', context: 'Work is done' });
    const res = await POST(req, { params: Promise.resolve({ id: 'w1' }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode).toBe('complete');
    // Should update both worker and task
    expect(mockWorkersUpdate).toHaveBeenCalled();
    expect(mockTasksUpdate).toHaveBeenCalled();
  });

  it('restart: fails worker and resets task', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc1' });
    mockWorkersFindFirst.mockResolvedValue(mockWorker);
    mockWorkersFindMany.mockResolvedValue([]); // No other active workers
    const req = makeRequest('POST', { mode: 'restart' });
    const res = await POST(req, { params: Promise.resolve({ id: 'w1' }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode).toBe('restart');
    expect(json.taskReset).toBe(true);
  });

  it('restart: works for terminal workers', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc1' });
    mockWorkersFindFirst.mockResolvedValue({ ...mockWorker, status: 'failed' });
    mockWorkersFindMany.mockResolvedValue([]); // No other active workers
    const req = makeRequest('POST', { mode: 'restart' });
    const res = await POST(req, { params: Promise.resolve({ id: 'w1' }) });
    expect(res.status).toBe(200);
    // Should NOT send Pusher command for terminal workers
    const pusherCalls = mockTriggerEvent.mock.calls.filter(
      (call: any) => call[0] === 'worker-w1'
    );
    expect(pusherCalls.length).toBe(0);
  });
});
