import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockArtifactsFindFirst = mock(() => null as any);
const mockArtifactsUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockTasksUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockWorkersUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mock(() => [{ id: 'worker-1', status: 'running' }]),
    })),
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
    worker: (id: string) => `worker-${id}`,
  },
  events: {
    WORKER_PROGRESS: 'worker:progress',
  },
}));

mock.module('@buildd/shared', () => ({
  ArtifactType: { TASK_PLAN: 'task_plan' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
      artifacts: { findFirst: mockArtifactsFindFirst },
    },
    update: (table: any) => {
      if (table === 'artifacts') return mockArtifactsUpdate();
      if (table === 'tasks') return mockTasksUpdate();
      return mockWorkersUpdate();
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers',
  artifacts: 'artifacts',
  tasks: 'tasks',
}));

import { POST } from './route';

function createMockRequest(apiKey?: string, body?: Record<string, unknown>): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return new NextRequest('http://localhost:3000/api/workers/worker-1/plan/approve', {
    method: 'POST',
    headers: new Headers(headers),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const mockParams = Promise.resolve({ id: 'worker-1' });

describe('POST /api/workers/[id]/plan/approve', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
    mockArtifactsFindFirst.mockReset();
    mockTriggerEvent.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();

    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'worker-1', status: 'running', workspaceId: 'ws-1' }]),
        })),
      })),
    });
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
    mockArtifactsUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest();
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(401);
  });

  it('returns 404 when worker not found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue(null);

    const req = createMockRequest('bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns 400 when worker is not awaiting plan approval', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'running',
      task: { title: 'Test' },
    });

    const req = createMockRequest('bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Worker is not awaiting plan approval');
  });

  it('returns 404 when no plan found', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'awaiting_plan_approval',
      task: { title: 'Test' },
    });
    mockArtifactsFindFirst.mockResolvedValue(null);

    const req = createMockRequest('bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('No plan found to approve');
  });

  it('approves plan and transitions worker to running', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'awaiting_plan_approval',
      taskId: 'task-1',
      workspaceId: 'ws-1',
      task: { title: 'Test Task' },
    });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      type: 'task_plan',
      content: 'Step 1: Do things',
      metadata: {},
    });

    const req = createMockRequest('bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toContain('Plan approved');
  });

  it('triggers realtime events on approval', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'awaiting_plan_approval',
      taskId: 'task-1',
      workspaceId: 'ws-1',
      task: { title: 'Test' },
    });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      content: 'Plan content',
      metadata: {},
    });

    const req = createMockRequest('bld_test');
    await POST(req, { params: mockParams });

    // Should trigger worker:plan_approved and worker:command events
    expect(mockTriggerEvent).toHaveBeenCalled();
  });

  it('accepts bypass mode parameter', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'awaiting_plan_approval',
      taskId: 'task-1',
      workspaceId: 'ws-1',
      task: { title: 'Test' },
    });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      content: 'Step 1',
      metadata: {},
    });

    const req = createMockRequest('bld_test', { mode: 'bypass' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);

    // Verify the Pusher command includes the bypass mode in the message text
    const commandCalls = mockTriggerEvent.mock.calls.filter(
      (call: any[]) => call[1] === 'worker:command'
    );
    expect(commandCalls.length).toBeGreaterThanOrEqual(1);
    const commandData = commandCalls[0][2] as any;
    expect(commandData.text).toContain('bypass permissions');
  });

  it('accepts review mode parameter', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'awaiting_plan_approval',
      taskId: 'task-1',
      workspaceId: 'ws-1',
      task: { title: 'Test' },
    });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      content: 'Step 1',
      metadata: {},
    });

    const req = createMockRequest('bld_test', { mode: 'review' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);

    const commandCalls = mockTriggerEvent.mock.calls.filter(
      (call: any[]) => call[1] === 'worker:command'
    );
    expect(commandCalls.length).toBeGreaterThanOrEqual(1);
    const commandData = commandCalls[0][2] as any;
    expect(commandData.text).toContain('with review');
  });

  it('defaults to review mode when no mode specified', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      id: 'worker-1',
      status: 'awaiting_plan_approval',
      taskId: 'task-1',
      workspaceId: 'ws-1',
      task: { title: 'Test' },
    });
    mockArtifactsFindFirst.mockResolvedValue({
      id: 'artifact-1',
      content: 'Step 1',
      metadata: {},
    });

    // No body at all
    const req = createMockRequest('bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);

    const commandCalls = mockTriggerEvent.mock.calls.filter(
      (call: any[]) => call[1] === 'worker:command'
    );
    expect(commandCalls.length).toBeGreaterThanOrEqual(1);
    const commandData = commandCalls[0][2] as any;
    expect(commandData.text).toContain('with review');
  });
});
