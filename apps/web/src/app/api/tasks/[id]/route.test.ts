import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockWorkersFindFirst = mock(() => Promise.resolve(null as any));
const mockWorkersFindMany = mock(() => Promise.resolve([] as any[]));
const mockArtifactsFindMany = mock(() => Promise.resolve([] as any[]));
const mockTasksUpdate = mock(() => ({ set: mock(() => ({ where: mock(() => ({ returning: mock(() => []) })) })) }));
const mockTasksDelete = mock(() => ({ where: mock(() => Promise.resolve()) }));
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));
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
      workers: { findFirst: mockWorkersFindFirst, findMany: mockWorkersFindMany },
      artifacts: { findMany: mockArtifactsFindMany },
    },
    update: mockTasksUpdate,
    delete: mockTasksDelete,
  },
}));

// Mock Pusher
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: {
    workspace: (id: string) => `workspace-${id}`,
    task: (id: string) => `task-${id}`,
    worker: (id: string) => `worker-${id}`,
    mission: (id: string) => `mission-${id}`,
  },
  events: {
    WORKER_COMMAND: 'worker:command',
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ type: 'and', args }),
  inArray: (field: any, values: any) => ({ field, values, type: 'inArray' }),
  desc: (field: any) => ({ field, type: 'desc' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  accounts: { apiKey: 'apiKey' },
  tasks: { id: 'id' },
  workers: { taskId: 'taskId', createdAt: 'createdAt' },
  artifacts: { workerId: 'workerId', updatedAt: 'updatedAt' },
  workspaces: {},
}));

// Import handlers AFTER mocks
import { GET, PATCH, DELETE } from './route';

// Helper to create mock NextRequest
function createMockRequest(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  search?: string;
} = {}): NextRequest {
  const { method = 'GET', headers = {}, body, search = '' } = options;

  const url = `http://localhost:3000/api/tasks/test-task-id${search}`;
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

  it('returns workers and artifacts when include=workers,artifacts', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w-1', status: 'completed', branch: 'feat/x', prUrl: 'https://github.com/o/r/pull/1' },
    ] as any);
    mockArtifactsFindMany.mockResolvedValue([
      { id: 'a-1', title: 'Summary', type: 'summary', shareToken: 'tok1', workerId: 'w-1' },
    ] as any);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
      search: '?include=workers,artifacts',
    });
    const response = await callHandler(GET, request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(Array.isArray(data.workers)).toBe(true);
    expect(data.workers[0].id).toBe('w-1');
    expect(Array.isArray(data.artifacts)).toBe(true);
    expect(data.artifacts[0].id).toBe('a-1');
    expect(data.artifacts[0].shareUrl).toContain('/share/tok1');
  });

  it('omits workers/artifacts when include is not requested', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockWorkersFindMany.mockReset();

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await callHandler(GET, request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.workers).toBeUndefined();
    expect(data.artifacts).toBeUndefined();
    expect(mockWorkersFindMany).not.toHaveBeenCalled();
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
    mockWorkersFindFirst.mockReset();
    mockTasksUpdate.mockReset();
    mockTriggerEvent.mockReset();
    mockTriggerEvent.mockResolvedValue(undefined);
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();

    // Default: grant access, no active worker
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockWorkersFindFirst.mockResolvedValue(null);
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

  it('links the task to an external issue (externalIssueId + url)', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    let capturedSet: any = null;
    const mockReturning = mock(() => [{ ...mockTask, externalIssueId: 'ISSUE-42' }]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock((v: any) => { capturedSet = v; return { where: mockWhere }; });
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { externalIssueId: 'ISSUE-42', externalIssueUrl: 'https://tracker.example.com/ISSUE-42' },
    });
    const response = await callHandler(PATCH, request, 'task-123');

    expect(response.status).toBe(200);
    expect(capturedSet.externalIssueId).toBe('ISSUE-42');
    expect(capturedSet.externalIssueUrl).toBe('https://tracker.example.com/ISSUE-42');
  });

  it('unlinks the task when externalIssueId is empty', async () => {
    const mockTask = {
      id: 'task-123', title: 'Test Task', workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    let capturedSet: any = null;
    const mockWhere = mock(() => ({ returning: mock(() => [mockTask]) }));
    const mockSet = mock((v: any) => { capturedSet = v; return { where: mockWhere }; });
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({ method: 'PATCH', body: { externalIssueId: '' } });
    const response = await callHandler(PATCH, request, 'task-123');

    expect(response.status).toBe(200);
    expect(capturedSet.externalIssueId).toBeNull();
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

  it('clears claimedBy, claimedAt, and expiresAt when resetting status to pending', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'assigned',
      claimedBy: 'account-1',
      claimedAt: new Date(),
      expiresAt: new Date(),
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    let capturedSetData: any = null;
    const updatedTask = { ...mockTask, status: 'pending', claimedBy: null, claimedAt: null, expiresAt: null };
    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock((data: any) => {
      capturedSetData = data;
      return { where: mockWhere };
    });
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { status: 'pending' },
    });
    const response = await callHandler(PATCH, request, 'task-123');

    expect(response.status).toBe(200);
    // Regression test: claim fields must be cleared so the task is claimable again
    expect(capturedSetData.status).toBe('pending');
    expect(capturedSetData.claimedBy).toBeNull();
    expect(capturedSetData.claimedAt).toBeNull();
    expect(capturedSetData.expiresAt).toBeNull();
  });

  it('allows setting status to cancelled with no active worker', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = { ...mockTask, status: 'cancelled' };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockWorkersFindFirst.mockResolvedValue(null); // no active worker

    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { status: 'cancelled' },
    });
    const response = await callHandler(PATCH, request, 'task-123');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe('cancelled');
    // No active worker → no Pusher abort event
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('pushes abort command to active worker on cancel', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = { ...mockTask, status: 'cancelled' };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockWorkersFindFirst.mockResolvedValue({ id: 'worker-456' }); // active worker found

    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { status: 'cancelled' },
    });
    const response = await callHandler(PATCH, request, 'task-123');

    expect(response.status).toBe(200);
    // Verify abort was pushed to the worker's Pusher channel
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'worker-worker-456',
      'worker:command',
      expect.objectContaining({ action: 'abort', reason: 'task_cancelled' })
    );
  });

  it('rejects unknown status values', async () => {
    const mockTask = {
      id: 'task-123',
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest({
      method: 'PATCH',
      body: { status: 'invalid_status' },
    });
    const response = await callHandler(PATCH, request, 'task-123');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Invalid status');
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
