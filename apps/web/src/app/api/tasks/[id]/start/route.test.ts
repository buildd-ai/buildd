import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockWorkersFindMany = mock(() => [] as any[]);
const mockTasksUpdate = mock(() => Promise.resolve());
const mockTriggerEvent = mock(() => Promise.resolve());
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));

// Mock auth-helpers
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// Mock api-auth
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: async () => null,
  hashApiKey: (key: string) => `hashed_${key}`,
  extractApiKeyPrefix: (key: string) => key.substring(0, 12),
}));

// Mock team-access
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
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
const mockDbUpdate = {
  set: mock(() => ({ where: mock(() => Promise.resolve()) })),
};
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTasksFindFirst },
      workers: { findMany: mockWorkersFindMany },
    },
    update: mock(() => mockDbUpdate),
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ type: 'and', args }),
  isNull: (field: any) => ({ field, type: 'isNull' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id', workspaceId: 'workspaceId', status: 'status', context: 'context', dependsOn: 'dependsOn', updatedAt: 'updatedAt' },
  workers: { taskId: 'taskId', prUrl: 'prUrl', mergedAt: 'mergedAt' },
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
    mockWorkersFindMany.mockReset();
    mockTriggerEvent.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();

    // Default: grant access, no blocking dep workers
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockWorkersFindMany.mockResolvedValue([]);
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
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

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
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'Test Workspace', repo: 'test/repo' },
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

    // Should trigger TASK_ASSIGNED event with minimal payload
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'workspace-ws-1',
      'task:assigned',
      {
        task: {
          id: 'task-123',
          title: 'Test Task',
          description: undefined,
          workspaceId: 'ws-1',
          status: 'pending',
          mode: undefined,
          priority: undefined,
          workspace: {
            name: 'Test Workspace',
            repo: 'test/repo',
          },
        },
        targetLocalUiUrl: null,
      }
    );
  });

  it('includes targetLocalUiUrl in TASK_ASSIGNED event when provided', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'Test Workspace', repo: 'test/repo' },
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

    // Should trigger TASK_ASSIGNED with the targetLocalUiUrl and minimal payload
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'workspace-ws-1',
      'task:assigned',
      {
        task: {
          id: 'task-123',
          title: 'Test Task',
          description: undefined,
          workspaceId: 'ws-1',
          status: 'pending',
          mode: undefined,
          priority: undefined,
          workspace: {
            name: 'Test Workspace',
            repo: 'test/repo',
          },
        },
        targetLocalUiUrl: 'http://localhost:3456',
      }
    );
  });

  it('returns 400 when task status is not pending', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
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
      workspace: { id: 'ws-1', teamId: 'team-1' },
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
      workspace: { id: 'ws-1', teamId: 'team-1' },
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
      workspace: { id: 'ws-1', teamId: 'team-1' },
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

  it('requires confirmation before manually starting a deferred task', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-123',
      title: 'Later task',
      status: 'pending',
      workspaceId: 'ws-1',
      startAt: new Date(Date.now() + 60 * 60 * 1000),
      context: {},
      workspace: { id: 'ws-1', teamId: 'team-1' },
    });

    const response = await callHandler(createMockRequest(), 'task-123');
    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.gateReason).toBe('deferred_start');
    expect(data.canForce).toBe(true);
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('starts a deferred task when the human confirms the override', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-123',
      title: 'Later task',
      description: null,
      status: 'pending',
      mode: 'execution',
      priority: 0,
      workspaceId: 'ws-1',
      startAt: new Date(Date.now() + 60 * 60 * 1000),
      context: {},
      workspace: { id: 'ws-1', teamId: 'team-1' },
    });

    const response = await callHandler(createMockRequest({ body: { forceOverride: true } }), 'task-123');
    expect(response.status).toBe(200);
    expect(mockTriggerEvent).toHaveBeenCalled();
    expect(mockDbUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      startAt: null,
      context: expect.objectContaining({ bypassStartGate: true }),
    }));
  });

  it('returns 422 when a completed dependency has an unmerged PR', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      dependsOn: ['dep-task-1'],
      context: {},
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'Test Workspace', repo: 'test/repo' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    // Simulate a worker with open PR on the completed dep task
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'worker-1',
        taskId: 'dep-task-1',
        prUrl: 'https://github.com/org/repo/pull/94',
        prNumber: 94,
        task: { id: 'dep-task-1', title: 'Spec task', status: 'completed' },
      },
    ]);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.gateReason).toBe('unmerged_dep_pr');
    expect(data.canForce).toBe(true);
    expect(data.blockingDeps).toHaveLength(1);
    expect(data.blockingDeps[0].prUrl).toBe('https://github.com/org/repo/pull/94');
    expect(data.blockingDeps[0].prNumber).toBe(94);
    // Should NOT have broadcast Pusher
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('does not gate when dep worker is not completed (status check handles it)', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      dependsOn: ['dep-task-1'],
      context: {},
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'Test Workspace', repo: 'test/repo' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    // Worker has open PR but dep task is not yet completed — not a PR gate issue
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'worker-1',
        taskId: 'dep-task-1',
        prUrl: 'https://github.com/org/repo/pull/90',
        prNumber: 90,
        task: { id: 'dep-task-1', title: 'Still running task', status: 'in_progress' },
      },
    ]);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    // No PR gate — should proceed to broadcast (dep status check is at claim time)
    expect(response.status).toBe(200);
    expect(mockTriggerEvent).toHaveBeenCalled();
  });

  it('bypasses gate and broadcasts when forceOverride is true', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      dependsOn: ['dep-task-1'],
      context: {},
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'Test Workspace', repo: 'test/repo' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    // Has a blocking dep PR, but user sends forceOverride
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'worker-1',
        taskId: 'dep-task-1',
        prUrl: 'https://github.com/org/repo/pull/94',
        prNumber: 94,
        task: { id: 'dep-task-1', title: 'Spec task', status: 'completed' },
      },
    ]);

    const request = createMockRequest({ body: { forceOverride: true } });
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.started).toBe(true);
    // Should have broadcast Pusher
    expect(mockTriggerEvent).toHaveBeenCalled();
  });
});
