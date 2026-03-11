import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockWorkersFindMany = mock(() => [] as any[]);
const mockTasksFindMany = mock(() => [] as any[]);

// Mock auth-helpers
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// Mock team-access
mock.module('@/lib/team-access', () => ({
  getUserWorkspaceIds: mockGetUserWorkspaceIds,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      tasks: { findMany: mockTasksFindMany },
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id', status: 'status', workspaceId: 'workspaceId' },
  workers: { status: 'status', taskId: 'taskId', workspaceId: 'workspaceId' },
}));

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ type: 'eq', args }),
  inArray: (...args: any[]) => ({ type: 'inArray', args }),
}));

// Import route handler after mocks
const { GET } = await import('./route');

describe('GET /api/tasks/waiting-input', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockWorkersFindMany.mockReset();
    mockTasksFindMany.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockReturnValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns empty tasks when user has no workspaces', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserWorkspaceIds.mockResolvedValue([]);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toEqual([]);
  });

  it('returns empty tasks when no workers are waiting_input', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockReturnValue([]);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toEqual([]);
  });

  it('returns waiting tasks with waitingFor data', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockReturnValue([
      {
        taskId: 'task-1',
        workspaceId: 'ws-1',
        waitingFor: { type: 'question', prompt: 'Which database?' },
      },
    ]);
    mockTasksFindMany.mockReturnValue([
      {
        id: 'task-1',
        title: 'Setup database',
        status: 'running',
        workspaceId: 'ws-1',
      },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0]).toEqual({
      id: 'task-1',
      title: 'Setup database',
      workspaceId: 'ws-1',
      waitingFor: { type: 'question', prompt: 'Which database?' },
    });
  });

  it('excludes completed/failed tasks', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockReturnValue([
      {
        taskId: 'task-1',
        workspaceId: 'ws-1',
        waitingFor: { type: 'question', prompt: 'Test?' },
      },
    ]);
    mockTasksFindMany.mockReturnValue([
      {
        id: 'task-1',
        title: 'Completed task',
        status: 'completed',
        workspaceId: 'ws-1',
      },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toHaveLength(0);
  });

  it('filters workers to user workspaces only', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockReturnValue([
      {
        taskId: 'task-1',
        workspaceId: 'ws-1',
        waitingFor: { type: 'question', prompt: 'Yes?' },
      },
      {
        taskId: 'task-2',
        workspaceId: 'ws-other', // Not user's workspace
        waitingFor: { type: 'question', prompt: 'No?' },
      },
    ]);
    mockTasksFindMany.mockReturnValue([
      {
        id: 'task-1',
        title: 'My task',
        status: 'running',
        workspaceId: 'ws-1',
      },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe('task-1');
  });
});
