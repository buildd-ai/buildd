import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockWorkersFindMany = mock(() => [] as any[]);

// Mock auth-helpers
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTasksFindFirst },
      workers: { findMany: mockWorkersFindMany },
    },
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  desc: (field: any) => ({ field, type: 'desc' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id', workspaceId: 'workspaceId' },
  workers: { id: 'id', taskId: 'taskId', createdAt: 'createdAt' },
}));

// Import handler AFTER mocks
import { GET } from './route';

// Helper to create mock NextRequest
function createMockRequest(): NextRequest {
  const url = 'http://localhost:3000/api/tasks/task-123/workers';
  return new NextRequest(url, { method: 'GET' });
}

// Helper to call route handler with params
async function callHandler(request: NextRequest, id: string) {
  return GET(request, { params: Promise.resolve({ id }) });
}

describe('GET /api/tasks/[id]/workers', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockTasksFindFirst.mockReset();
    mockWorkersFindMany.mockReset();
  });

  it('returns 401 when no session auth (session only)', async () => {
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

  it('returns workers ordered by createdAt desc', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    const mockWorkers = [
      {
        id: 'worker-2',
        name: 'Worker 2',
        branch: 'branch-2',
        status: 'running',
        progress: 50,
        currentAction: 'Processing',
        localUiUrl: 'http://localhost:3456',
        prUrl: null,
        prNumber: null,
        createdAt: new Date('2024-01-02'),
        startedAt: new Date('2024-01-02'),
        completedAt: null,
      },
      {
        id: 'worker-1',
        name: 'Worker 1',
        branch: 'branch-1',
        status: 'completed',
        progress: 100,
        currentAction: null,
        localUiUrl: 'http://localhost:3457',
        prUrl: 'https://github.com/org/repo/pull/1',
        prNumber: 1,
        createdAt: new Date('2024-01-01'),
        startedAt: new Date('2024-01-01'),
        completedAt: new Date('2024-01-01'),
      },
    ];

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockWorkersFindMany.mockResolvedValue(mockWorkers);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.workers).toHaveLength(2);
    // Newest first (worker-2 created on Jan 2)
    expect(data.workers[0].id).toBe('worker-2');
    expect(data.workers[1].id).toBe('worker-1');
  });

  it('returns only safe columns', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    const mockWorkers = [
      {
        id: 'worker-1',
        name: 'Worker 1',
        branch: 'branch-1',
        status: 'running',
        progress: 50,
        currentAction: 'Processing',
        localUiUrl: 'http://localhost:3456',
        prUrl: null,
        prNumber: null,
        createdAt: new Date(),
        startedAt: new Date(),
        completedAt: null,
        // These should NOT be included in the response:
        // accountId, taskId, workspaceId, error, summary, etc.
      },
    ];

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockWorkersFindMany.mockResolvedValue(mockWorkers);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();

    // Verify safe columns are present
    const worker = data.workers[0];
    expect(worker.id).toBe('worker-1');
    expect(worker.name).toBe('Worker 1');
    expect(worker.branch).toBe('branch-1');
    expect(worker.status).toBe('running');
    expect(worker.progress).toBe(50);
    expect(worker.currentAction).toBe('Processing');
    expect(worker.localUiUrl).toBe('http://localhost:3456');
  });

  it('returns empty array when no workers', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockWorkersFindMany.mockResolvedValue([]);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.workers).toHaveLength(0);
  });

  it('includes PR information when available', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', ownerId: 'user-123' },
    };

    const mockWorkers = [
      {
        id: 'worker-1',
        name: 'Worker 1',
        branch: 'feature-branch',
        status: 'completed',
        progress: 100,
        currentAction: null,
        localUiUrl: 'http://localhost:3456',
        prUrl: 'https://github.com/org/repo/pull/42',
        prNumber: 42,
        createdAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
      },
    ];

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockWorkersFindMany.mockResolvedValue(mockWorkers);

    const request = createMockRequest();
    const response = await callHandler(request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.workers[0].prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(data.workers[0].prNumber).toBe(42);
  });
});
