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

mock.module('@/lib/task-dependencies', () => ({
  resolveCompletedTask: mock(() => Promise.resolve()),
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

  it('returns 409 when worker is already completed and update is not reactivation', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'completed',
      workspaceId: 'ws-1',
      pendingInstructions: null,
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'completed' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('Worker already completed');
  });

  it('allows reactivation of completed worker with running status', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'completed',
      workspaceId: 'ws-1',
      pendingInstructions: null,
      taskId: 'task-1',
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'running', currentAction: 'Processing follow-up...' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
  });

  it('returns 409 when worker has failed and update is not reactivation', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'failed',
      error: 'Reassigned',
      workspaceId: 'ws-1',
      pendingInstructions: null,
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'completed' },
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

  it('merges appendMilestones with existing milestones', async () => {
    let capturedSet: any = null;
    mockWorkersUpdate.mockReturnValue({
      set: mock((updates: any) => {
        capturedSet = updates;
        return {
          where: mock(() => ({
            returning: mock(() => [{ id: 'worker-1', status: 'running', accountId: 'account-1', workspaceId: 'ws-1' }]),
          })),
        };
      }),
    });

    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'running',
      workspaceId: 'ws-1',
      milestones: [{ type: 'status', label: 'Existing', ts: 1000 }],
      pendingInstructions: null,
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: {
        status: 'running',
        appendMilestones: [{ type: 'status', label: 'New milestone', progress: 50, ts: 2000 }],
      },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(capturedSet.milestones).toHaveLength(2);
    expect(capturedSet.milestones[0].label).toBe('Existing');
    expect(capturedSet.milestones[1].label).toBe('New milestone');
    expect(capturedSet.milestones[1].progress).toBe(50);
  });

  it('caps appendMilestones at 50 entries', async () => {
    let capturedSet: any = null;
    mockWorkersUpdate.mockReturnValue({
      set: mock((updates: any) => {
        capturedSet = updates;
        return {
          where: mock(() => ({
            returning: mock(() => [{ id: 'worker-1', status: 'running', accountId: 'account-1', workspaceId: 'ws-1' }]),
          })),
        };
      }),
    });

    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    // 48 existing milestones
    const existing = Array.from({ length: 48 }, (_, i) => ({ type: 'status', label: `m${i}`, ts: i }));
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'running',
      workspaceId: 'ws-1',
      milestones: existing,
      pendingInstructions: null,
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: {
        status: 'running',
        appendMilestones: [
          { type: 'status', label: 'new1', ts: 100 },
          { type: 'status', label: 'new2', ts: 101 },
          { type: 'status', label: 'new3', ts: 102 },
        ],
      },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    // 48 + 3 = 51, capped to last 50
    expect(capturedSet.milestones).toHaveLength(50);
    expect(capturedSet.milestones[49].label).toBe('new3');
  });

  it('appendMilestones handles null existing milestones', async () => {
    let capturedSet: any = null;
    mockWorkersUpdate.mockReturnValue({
      set: mock((updates: any) => {
        capturedSet = updates;
        return {
          where: mock(() => ({
            returning: mock(() => [{ id: 'worker-1', status: 'running', accountId: 'account-1', workspaceId: 'ws-1' }]),
          })),
        };
      }),
    });

    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      accountId: 'account-1',
      status: 'running',
      workspaceId: 'ws-1',
      milestones: null,
      pendingInstructions: null,
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: {
        status: 'running',
        appendMilestones: [{ type: 'status', label: 'First milestone', ts: 1000 }],
      },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(capturedSet.milestones).toHaveLength(1);
    expect(capturedSet.milestones[0].label).toBe('First milestone');
  });

  it('includes phases and lastQuestion in task.result on completion', async () => {
    let capturedTaskSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((updates: any) => {
        capturedTaskSet = updates;
        return {
          where: mock(() => Promise.resolve()),
        };
      }),
    });

    const updatedWorker = {
      id: 'worker-1',
      status: 'completed',
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
      taskId: 'task-1',
      branch: 'feature/test',
      milestones: [
        { type: 'phase', label: 'Exploring codebase', toolCount: 5, ts: 1000 },
        { type: 'status', label: 'Commit: fix bug', ts: 2000 },
        { type: 'phase', label: 'Running tests', toolCount: 2, ts: 3000 },
      ],
      waitingFor: { prompt: 'Which auth method?', type: 'question' },
      pendingInstructions: null,
      commitCount: 1,
      filesChanged: 3,
      linesAdded: 20,
      linesRemoved: 5,
      lastCommitSha: 'abc1234',
      prUrl: null,
      prNumber: null,
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'completed' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(capturedTaskSet).not.toBeNull();
    expect(capturedTaskSet.result.phases).toHaveLength(2);
    expect(capturedTaskSet.result.phases[0].label).toBe('Exploring codebase');
    expect(capturedTaskSet.result.phases[0].toolCount).toBe(5);
    expect(capturedTaskSet.result.phases[1].label).toBe('Running tests');
    expect(capturedTaskSet.result.phases[1].toolCount).toBe(2);
    expect(capturedTaskSet.result.lastQuestion).toBe('Which auth method?');
  });

  it('omits phases from task.result when there are no phase milestones', async () => {
    let capturedTaskSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((updates: any) => {
        capturedTaskSet = updates;
        return {
          where: mock(() => Promise.resolve()),
        };
      }),
    });

    const updatedWorker = {
      id: 'worker-1',
      status: 'completed',
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
      taskId: 'task-1',
      branch: 'feature/test',
      milestones: [
        { type: 'status', label: 'Commit: fix', ts: 1000 },
      ],
      waitingFor: null,
      pendingInstructions: null,
    });

    const req = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_test' },
      body: { status: 'completed' },
    });
    const res = await PATCH(req, { params: mockParams });

    expect(res.status).toBe(200);
    expect(capturedTaskSet.result.phases).toBeUndefined();
    expect(capturedTaskSet.result.lastQuestion).toBeUndefined();
  });
});
