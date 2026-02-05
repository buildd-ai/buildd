import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockTriggerEvent = mock(() => Promise.resolve());

// Mock auth-helpers
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// Mock pusher
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: {
    workspace: (id: string) => `workspace-${id}`,
    task: (id: string) => `task-${id}`,
    worker: (id: string) => `worker-${id}`,
  },
  events: {
    TASK_CREATED: 'task:created',
    TASK_ASSIGNED: 'task:assigned',
    TASK_CLAIMED: 'task:claimed',
    TASK_COMPLETED: 'task:completed',
    TASK_FAILED: 'task:failed',
    WORKER_STARTED: 'worker:started',
    WORKER_PROGRESS: 'worker:progress',
    WORKER_COMPLETED: 'worker:completed',
    WORKER_FAILED: 'worker:failed',
  },
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTasksFindFirst },
    },
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id', workspaceId: 'workspaceId', status: 'status' },
}));

// Import handler AFTER mocks
import { POST } from './route';

// Helper to create mock NextRequest
function createMockRequest(options: {
  body?: any;
} = {}): NextRequest {
  const { body } = options;

  const url = 'http://localhost:3000/api/tasks/task-123/start';
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
  };

  if (body) {
    init.body = JSON.stringify(body);
  }

  return new NextRequest(url, init);
}

// Helper to call route handler with params
async function callHandler(request: NextRequest, id: string) {
  return POST(request, { params: Promise.resolve({ id }) });
}

describe('POST /api/tasks/[id]/start', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockTasksFindFirst.mockReset();
    mockTriggerEvent.mockReset();
  });

  it('returns 401 when no session auth (API key not supported)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when task not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await callHandler(request, 'nonexistent-task');

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('returns 404 when user does not own workspace', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', ownerId: 'other-user' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('starts pending task and broadcasts TASK_ASSIGNED event', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.started).toBe(true);
    expect(data.taskId).toBe('task-123');
    expect(data.targetLocalUiUrl).toBeNull();

    // Should trigger TASK_ASSIGNED event
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'workspace-ws-1',
      'task:assigned',
      { task: mockTask, targetLocalUiUrl: null }
    );
  });

  it('includes targetLocalUiUrl in TASK_ASSIGNED event when provided', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest({
      body: { targetLocalUiUrl: 'http://localhost:3456' },
    });
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.started).toBe(true);
    expect(data.targetLocalUiUrl).toBe('http://localhost:3456');

    // Should trigger TASK_ASSIGNED with the targetLocalUiUrl
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'workspace-ws-1',
      'task:assigned',
      { task: mockTask, targetLocalUiUrl: 'http://localhost:3456' }
    );
  });

  it('returns 400 when task status is not pending', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Cannot start task with status: assigned');
    expect(data.status).toBe('assigned');
  });

  it('returns 400 when task is running', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'running',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Cannot start task with status: running');
  });

  it('returns 400 when task is completed', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'completed',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Cannot start task with status: completed');
  });

  it('handles empty body gracefully', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    // Create request without body
    const request = new NextRequest('http://localhost:3000/api/tasks/task-123/start', {
      method: 'POST',
    });
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.started).toBe(true);
    expect(data.targetLocalUiUrl).toBeNull();
  });
});
