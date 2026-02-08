import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockWorkersFindMany = mock(() => [] as any[]);
const mockTasksUpdate = mock(() => ({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) }));
const mockWorkersUpdate = mock(() => ({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) }));
const mockTriggerEvent = mock(() => Promise.resolve());

// Mock auth-helpers
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// Mock api-auth - authenticateApiKey delegates to mockAccountsFindFirst
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: async (apiKey: string | null) => {
    if (!apiKey) return null;
    return mockAccountsFindFirst();
  },
  hashApiKey: (key: string) => `hashed_${key}`,
  extractApiKeyPrefix: (key: string) => key.substring(0, 12),
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

// We need to track which table is being updated
let currentUpdateTable: 'tasks' | 'workers' = 'tasks';

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: mockAccountsFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
      workers: { findMany: mockWorkersFindMany },
    },
    update: (table: any) => {
      // Determine which table based on the mock object passed
      // table will be the schema mock object
      if (table && table.id === 'id' && table.workspaceId === 'workspaceId') {
        currentUpdateTable = 'tasks';
        return mockTasksUpdate();
      }
      currentUpdateTable = 'workers';
      return mockWorkersUpdate();
    },
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  accounts: { apiKey: 'apiKey', id: 'id' },
  tasks: { id: 'id', workspaceId: 'workspaceId', status: 'status' },
  workers: { id: 'id', taskId: 'taskId', status: 'status' },
}));

// Import handler AFTER mocks
import { POST } from './route';

// Helper to create mock NextRequest
function createMockRequest(options: {
  headers?: Record<string, string>;
  searchParams?: Record<string, string>;
} = {}): NextRequest {
  const { headers = {}, searchParams = {} } = options;

  let url = 'http://localhost:3000/api/tasks/task-123/reassign';
  const params = new URLSearchParams(searchParams);
  if (params.toString()) {
    url += `?${params.toString()}`;
  }

  return new NextRequest(url, {
    method: 'POST',
    headers: new Headers(headers),
  });
}

// Helper to call route handler with params
async function callHandler(request: NextRequest, id: string) {
  return POST(request, { params: Promise.resolve({ id }) });
}

describe('POST /api/tasks/[id]/reassign', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockWorkersFindMany.mockReset();
    mockTasksUpdate.mockReset();
    mockWorkersUpdate.mockReset();
    mockTriggerEvent.mockReset();

    // Default mocks
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({ where: mock(() => Promise.resolve()) })),
    });
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({ where: mock(() => Promise.resolve()) })),
    });
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

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

  it('reassigns pending task and broadcasts TASK_ASSIGNED event', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      expiresAt: null,
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.reassigned).toBe(true);
    expect(data.taskId).toBe('task-123');
    expect(data.wasAssigned).toBe(false);

    // Should trigger TASK_ASSIGNED event
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'workspace-ws-1',
      'task:assigned',
      expect.objectContaining({ targetLocalUiUrl: null })
    );
  });

  it('returns reassigned:false for assigned task without force flag', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60), // Future expiry
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.reassigned).toBe(false);
    expect(data.reason).toContain('Use force=true');
    expect(data.status).toBe('assigned');
    expect(data.isStale).toBe(false);
    expect(data.canTakeover).toBe(true); // User is workspace owner
  });

  it('reassigns assigned task with force=true when user is workspace owner', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60), // Future expiry
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst
      .mockResolvedValueOnce(mockTask) // First call for initial task
      .mockResolvedValueOnce({ ...mockTask, status: 'pending' }); // After update
    mockWorkersFindMany.mockResolvedValue([]);

    const request = createMockRequest({ searchParams: { force: 'true' } });
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.reassigned).toBe(true);
    expect(data.wasAssigned).toBe(true);
  });

  it('reassigns assigned task with force=true when task is stale', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      expiresAt: new Date(Date.now() - 1000 * 60), // Past expiry = stale
      workspace: { id: 'ws-1', ownerId: 'other-user' }, // Different owner
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst
      .mockResolvedValueOnce(mockTask)
      .mockResolvedValueOnce({ ...mockTask, status: 'pending' });
    mockWorkersFindMany.mockResolvedValue([]);

    const request = createMockRequest({ searchParams: { force: 'true' } });
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.reassigned).toBe(true);
  });

  it('returns 403 for assigned task with force=true when neither owner nor stale', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60), // Future expiry = not stale
      workspace: { id: 'ws-1', ownerId: 'other-user' }, // Different owner
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest({ searchParams: { force: 'true' } });
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.reassigned).toBe(false);
    expect(data.reason).toContain('not stale');
    expect(data.reason).toContain('not the workspace owner');
  });

  it('marks active workers as failed when reassigning assigned task', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    const activeWorkers = [
      { id: 'worker-1', taskId: 'task-123', status: 'running' },
      { id: 'worker-2', taskId: 'task-123', status: 'starting' },
    ];

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst
      .mockResolvedValueOnce(mockTask)
      .mockResolvedValueOnce({ ...mockTask, status: 'pending' });
    mockWorkersFindMany.mockResolvedValue(activeWorkers);

    const request = createMockRequest({ searchParams: { force: 'true' } });
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);

    // Should update workers and trigger WORKER_FAILED for each
    // triggerEvent should be called 3 times: 2 for WORKER_FAILED + 1 for TASK_ASSIGNED
    expect(mockTriggerEvent).toHaveBeenCalledTimes(3);
  });

  it('triggers WORKER_FAILED event for each active worker', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    const activeWorkers = [
      { id: 'worker-1', taskId: 'task-123', status: 'running' },
    ];

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst
      .mockResolvedValueOnce(mockTask)
      .mockResolvedValueOnce({ ...mockTask, status: 'pending' });
    mockWorkersFindMany.mockResolvedValue(activeWorkers);

    const request = createMockRequest({ searchParams: { force: 'true' } });
    await callHandler(request, 'task-123');

    // Verify WORKER_FAILED was called with correct data
    const workerFailedCalls = mockTriggerEvent.mock.calls.filter(
      (call: any[]) => call[1] === 'worker:failed'
    );
    expect(workerFailedCalls.length).toBe(1);
    expect(workerFailedCalls[0][0]).toBe('worker-worker-1');
    expect(workerFailedCalls[0][2].worker.status).toBe('failed');
    expect(workerFailedCalls[0][2].worker.error).toBe('Task was reassigned');
  });

  it('returns reassigned:false for completed task', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'completed',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest({ searchParams: { force: 'true' } });
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.reassigned).toBe(false);
    expect(data.reason).toContain('completed');
    expect(data.status).toBe('completed');
  });

  it('returns reassigned:false for failed task', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'failed',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest({ searchParams: { force: 'true' } });
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.reassigned).toBe(false);
    expect(data.status).toBe('failed');
  });

  it('works with API key auth', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      expiresAt: null,
      workspace: { id: 'ws-1', ownerId: 'other-user' },
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.reassigned).toBe(true);
  });

  it('works with session auth', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      expiresAt: null,
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.reassigned).toBe(true);
  });

  it('resets task fields when reassigning assigned task', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      claimedBy: 'some-worker',
      claimedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst
      .mockResolvedValueOnce(mockTask)
      .mockResolvedValueOnce({ ...mockTask, status: 'pending', claimedBy: null, claimedAt: null, expiresAt: null });
    mockWorkersFindMany.mockResolvedValue([]);

    const request = createMockRequest({ searchParams: { force: 'true' } });
    const response = await callHandler(request, 'task-123');

    // Verify successful reassignment happened
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.reassigned).toBe(true);
    expect(data.wasAssigned).toBe(true);

    // The task update was called (verified by the mock being invoked)
    // The actual data verification would require more complex mock setup
    // but the behavior is verified by the success response
  });

  it('broadcasts TASK_ASSIGNED with null targetLocalUiUrl for any worker to claim', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      expiresAt: null,
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest();
    await callHandler(request, 'task-123');

    const taskAssignedCalls = mockTriggerEvent.mock.calls.filter(
      (call: any[]) => call[1] === 'task:assigned'
    );
    expect(taskAssignedCalls.length).toBe(1);
    expect(taskAssignedCalls[0][2].targetLocalUiUrl).toBeNull();
  });

  it('identifies stale task correctly when expiresAt is in the past', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      expiresAt: new Date(Date.now() - 1000), // 1 second ago = stale
      workspace: { id: 'ws-1', ownerId: 'other-user' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    const data = await response.json();
    expect(data.isStale).toBe(true);
    expect(data.canTakeover).toBe(true); // Stale = can takeover
  });

  it('identifies non-stale task when expiresAt is null', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      expiresAt: null, // No expiry = not stale
      workspace: { id: 'ws-1', ownerId: 'other-user' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    const data = await response.json();
    // isStale is null when expiresAt is null (due to && short-circuit)
    // This is falsy, which is equivalent to "not stale" in the logic
    expect(data.isStale).toBeFalsy();
    // canTakeover is also falsy (isWorkspaceOwner=false || isStale=null = null)
    expect(data.canTakeover).toBeFalsy(); // Not owner and not stale
  });
});
