import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockWorkersUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mock(() => []),
    })),
  })),
}));
const mockTasksUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockTriggerEvent = mock(() => Promise.resolve());

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: {
    workspace: (id: string) => `workspace-${id}`,
    task: (id: string) => `task-${id}`,
    worker: (id: string) => `worker-${id}`,
  },
  events: {
    WORKER_STARTED: 'worker:started',
    WORKER_PROGRESS: 'worker:progress',
    WORKER_COMPLETED: 'worker:completed',
    WORKER_FAILED: 'worker:failed',
  },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
    },
    update: (table: any) => {
      if (table === 'tasks') return mockTasksUpdate();
      return mockWorkersUpdate();
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers',
  tasks: 'tasks',
}));

import { GET, PATCH } from './route';

function createMockRequest(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
} = {}): NextRequest {
  const { method = 'GET', headers = {}, body } = options;
  const init: RequestInit = {
    method,
    headers: new Headers(headers),
  };
  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Headers).set('content-type', 'application/json');
  }
  return new NextRequest('http://localhost:3000/api/workers/worker-1', init);
}

const mockParams = Promise.resolve({ id: 'worker-1' });

describe('GET /api/workers/[id]', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest();
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when worker not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue(null);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
    });
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('Worker not found');
  });

  it('returns 403 when worker belongs to different account', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-2',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
    });
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Forbidden');
  });

  it('returns worker when authenticated and authorized', async () => {
    const mockWorker = {
      id: 'worker-1',
      accountId: 'account-1',
      status: 'running',
      task: { id: 'task-1', title: 'Test Task' },
      workspace: { id: 'ws-1' },
    };
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue(mockWorker);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
    });
    const res = await GET(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe('worker-1');
    expect(data.status).toBe('running');
  });
});

describe('PATCH /api/workers/[id]', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockTriggerEvent.mockReset();

    // Default update chain
    const updatedWorker = { id: 'worker-1', status: 'running', accountId: 'account-1', workspaceId: 'ws-1' };
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [updatedWorker]),
        })),
      })),
    });

    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest({
      method: 'PATCH',
      body: { status: 'running' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when worker not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue(null);

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'running' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns 403 when worker belongs to different account', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-2',
      status: 'running',
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'running' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(403);
  });

  it('returns 409 when worker is already completed', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'completed',
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'running' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('Worker already completed');
  });

  it('returns 409 when worker has failed (possibly reassigned)', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'failed',
      error: 'Reassigned',
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'running' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.abort).toBe(true);
  });

  it('updates worker status successfully', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'running',
      workspaceId: 'ws-1',
      pendingInstructions: null,
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'running', currentAction: 'Editing files' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(mockTriggerEvent).toHaveBeenCalled();
  });

  it('delivers and clears pending instructions', async () => {
    const updatedWorker = {
      id: 'worker-1',
      status: 'running',
      accountId: 'account-1',
      workspaceId: 'ws-1',
    };
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [updatedWorker]),
        })),
      })),
    });

    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'running',
      workspaceId: 'ws-1',
      pendingInstructions: 'Do something specific',
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'running' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.instructions).toBe('Do something specific');
  });
});
