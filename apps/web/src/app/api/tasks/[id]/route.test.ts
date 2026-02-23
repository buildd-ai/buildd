import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockTasksUpdate = mock(() => ({ set: mock(() => ({ where: mock(() => ({ returning: mock(() => []) })) })) }));
const mockTasksDelete = mock(() => ({ where: mock(() => Promise.resolve()) }));
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));

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

// Mock team-access
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: mockAccountsFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
    },
    update: mockTasksUpdate,
    delete: mockTasksDelete,
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  accounts: { apiKey: 'apiKey' },
  tasks: { id: 'id' },
  workspaces: {},
}));

// Import handlers AFTER mocks
import { GET, PATCH, DELETE } from './route';

// Helper to create mock NextRequest
function createMockRequest(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
} = {}): NextRequest {
  const { method = 'GET', headers = {}, body } = options;

  const url = 'http://localhost:3000/api/tasks/test-task-id';
  const init: RequestInit = {
    method,
    headers: new Headers(headers),
  };

  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Headers).set('content-type', 'application/json');
  }

  return new NextRequest(url, init);
}

// Helper to call route handler with params
async function callHandler(
  handler: Function,
  request: NextRequest,
  id: string
) {
  return handler(request, { params: Promise.resolve({ id }) });
}

describe('GET /api/tasks/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();

    // Default: grant access
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await callHandler(GET, request, 'task-123');

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns task for API key auth', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      description: 'Test description',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await callHandler(GET, request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('task-123');
    expect(data.title).toBe('Test Task');
  });

  it('returns task for session auth when user owns workspace', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      description: 'Test description',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest();
    const response = await callHandler(GET, request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('task-123');
  });

  it('returns 404 when task not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await callHandler(GET, request, 'nonexistent-task');

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('returns 404 when session user does not own workspace', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await callHandler(GET, request, 'task-123');

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('allows API key auth to access tasks regardless of workspace ownership', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await callHandler(GET, request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('task-123');
  });

  it('prefers API key auth over session auth when both present', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    // Session auth would fail (different owner), but API key should succeed
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await callHandler(GET, request, 'task-123');

    // Should succeed because API key auth bypasses ownership check
    expect(response.status).toBe(200);
  });
});

describe('PATCH /api/tasks/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksUpdate.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();

    // Default: grant access
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'PATCH',
      body: { title: 'Updated Title' },
    });
    const response = await callHandler(PATCH, request, 'task-123');

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when task not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'PATCH',
      body: { title: 'Updated Title' },
    });
    const response = await callHandler(PATCH, request, 'task-123');

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('returns 404 when session user does not own workspace', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'PATCH',
      body: { title: 'Updated Title' },
    });
    const response = await callHandler(PATCH, request, 'task-123');

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('updates title only', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Original Title',
      description: 'Original description',
      priority: 5,
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = { ...mockTask, title: 'Updated Title', updatedAt: expect.any(Date) };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { title: 'Updated Title' },
    });
    const response = await callHandler(PATCH, request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.title).toBe('Updated Title');
  });

  it('updates description only', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      description: 'Original description',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = { ...mockTask, description: 'New description' };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { description: 'New description' },
    });
    const response = await callHandler(PATCH, request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.description).toBe('New description');
  });

  it('updates priority only', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      priority: 5,
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = { ...mockTask, priority: 10 };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { priority: 10 },
    });
    const response = await callHandler(PATCH, request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.priority).toBe(10);
  });

  it('updates multiple fields at once', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Original Title',
      description: 'Original description',
      priority: 5,
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = {
      ...mockTask,
      title: 'New Title',
      description: 'New description',
      priority: 10,
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { title: 'New Title', description: 'New description', priority: 10 },
    });
    const response = await callHandler(PATCH, request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.title).toBe('New Title');
    expect(data.description).toBe('New description');
    expect(data.priority).toBe(10);
  });

  it('ignores undefined fields in update', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Original Title',
      description: 'Original description',
      priority: 5,
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    let capturedSetData: any = null;
    const mockReturning = mock(() => [mockTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock((data: any) => {
      capturedSetData = data;
      return { where: mockWhere };
    });
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { title: 'New Title' }, // Only title, not description or priority
    });
    await callHandler(PATCH, request, 'task-123');

    // The set data should only contain title and updatedAt, not description/priority
    expect(capturedSetData.title).toBe('New Title');
    expect(capturedSetData.updatedAt).toBeInstanceOf(Date);
    expect(capturedSetData.description).toBeUndefined();
    expect(capturedSetData.priority).toBeUndefined();
  });

  it('updates task project field', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      project: null,
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = { ...mockTask, project: '@mono/web' };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { project: '@mono/web' },
    });
    const response = await callHandler(PATCH, request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.project).toBe('@mono/web');
  });

  it('can clear project to null', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      project: '@mono/web',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = { ...mockTask, project: null };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    let capturedSetData: any = null;
    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock((data: any) => {
      capturedSetData = data;
      return { where: mockWhere };
    });
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { project: null },
    });
    const response = await callHandler(PATCH, request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.project).toBeNull();
    expect(capturedSetData.project).toBeNull();
  });

  it('omitting project does not change existing value', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Original Title',
      project: '@mono/web',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    let capturedSetData: any = null;
    const mockReturning = mock(() => [mockTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock((data: any) => {
      capturedSetData = data;
      return { where: mockWhere };
    });
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { title: 'New Title' },
    });
    await callHandler(PATCH, request, 'task-123');

    expect(capturedSetData.title).toBe('New Title');
    expect(capturedSetData.project).toBeUndefined();
  });

  it('allows API key auth to update task', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = { ...mockTask, title: 'Updated Title' };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { title: 'Updated Title' },
    });
    const response = await callHandler(PATCH, request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.title).toBe('Updated Title');
  });
});

describe('DELETE /api/tasks/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksDelete.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();

    // Default: grant access
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest({ method: 'DELETE' });
    const response = await callHandler(DELETE, request, 'task-123');

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when task not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(null);

    const request = createMockRequest({ method: 'DELETE' });
    const response = await callHandler(DELETE, request, 'task-123');

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('returns 404 when session user does not own workspace', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const request = createMockRequest({ method: 'DELETE' });
    const response = await callHandler(DELETE, request, 'task-123');

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('deletes pending task successfully', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockWhere = mock(() => Promise.resolve());
    mockTasksDelete.mockReturnValue({ where: mockWhere });

    const request = createMockRequest({ method: 'DELETE' });
    const response = await callHandler(DELETE, request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it('deletes assigned task successfully', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockWhere = mock(() => Promise.resolve());
    mockTasksDelete.mockReturnValue({ where: mockWhere });

    const request = createMockRequest({ method: 'DELETE' });
    const response = await callHandler(DELETE, request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it('deletes failed task successfully', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'failed',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockWhere = mock(() => Promise.resolve());
    mockTasksDelete.mockReturnValue({ where: mockWhere });

    const request = createMockRequest({ method: 'DELETE' });
    const response = await callHandler(DELETE, request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it('returns 400 when trying to delete running task', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'running',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest({ method: 'DELETE' });
    const response = await callHandler(DELETE, request, 'task-123');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Cannot delete running tasks');
  });

  it('deletes completed task successfully', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'completed',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockWhere = mock(() => Promise.resolve());
    mockTasksDelete.mockReturnValue({ where: mockWhere });

    const request = createMockRequest({ method: 'DELETE' });
    const response = await callHandler(DELETE, request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it('allows API key auth to delete task', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockWhere = mock(() => Promise.resolve());
    mockTasksDelete.mockReturnValue({ where: mockWhere });

    const request = createMockRequest({
      method: 'DELETE',
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await callHandler(DELETE, request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });
});
