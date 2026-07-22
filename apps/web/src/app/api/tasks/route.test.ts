import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockAccountWorkspacesFindMany = mock(() => [] as any[]);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockTasksFindMany = mock(() => [] as any[]);
const mockTasksFindFirst = mock(() => null as any);
const mockTasksInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() => []),
  })),
}));
// db.update(tasks).set({...}).where(...) chain
const mockTasksUpdateWhere = mock(() => Promise.resolve());
const mockTasksUpdateSet = mock(() => ({ where: mockTasksUpdateWhere }));
const mockTasksUpdate = mock(() => ({ set: mockTasksUpdateSet }));
const mockMissionsFindFirst = mock(() => null as any);
const mockWorkspaceSkillsFindFirst = mock(() => null as any);
const mockTriggerEvent = mock(() => Promise.resolve());
const mockResolveCreatorContext = mock(() =>
  Promise.resolve({
    createdByAccountId: null,
    createdByWorkerId: null,
    creationSource: 'api',
    parentTaskId: null,
  })
);
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));
const mockDispatchNewTask = mock(() => Promise.resolve());

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

const mockGetAccountWorkspacePermissions = mock(() => Promise.resolve([] as any[]));
mock.module('@/lib/account-workspace-cache', () => ({
  getAccountWorkspacePermissions: mockGetAccountWorkspacePermissions,
}));

// Mock team-access
mock.module('@/lib/team-access', () => ({
  getUserWorkspaceIds: mockGetUserWorkspaceIds,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

// Mock task-service
mock.module('@/lib/task-service', () => ({
  resolveCreatorContext: mockResolveCreatorContext,
}));

// Mock task-dispatch
mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: mockDispatchNewTask,
}));

// Mock workspace-resolver
const mockResolveWorkspace = mock(() => null as any);
const mockAutoResolveAccountWorkspace = mock(() => Promise.resolve({ workspaceId: 'ws-1' } as any));
mock.module('@/lib/workspace-resolver', () => ({
  resolveWorkspace: mockResolveWorkspace,
  autoResolveAccountWorkspace: mockAutoResolveAccountWorkspace,
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
      accounts: { findFirst: mockAccountsFindFirst },
      accountWorkspaces: { findMany: mockAccountWorkspacesFindMany },
      workspaces: { findMany: mockWorkspacesFindMany, findFirst: mockWorkspacesFindFirst },
      tasks: { findMany: mockTasksFindMany, findFirst: mockTasksFindFirst },
      missions: { findFirst: mockMissionsFindFirst },
      workspaceSkills: { findFirst: mockWorkspaceSkillsFindFirst },
    },
    insert: mockTasksInsert,
    update: mockTasksUpdate,
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  desc: (field: any) => ({ field, type: 'desc' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  or: (...args: any[]) => ({ args, type: 'or' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  notInArray: (field: any, values: any[]) => ({ field, values, type: 'notInArray' }),
  gte: (field: any, value: any) => ({ field, value, type: 'gte' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
  like: (field: any, pattern: any) => ({ field, pattern, type: 'like' }),
  sql: (strings: any, ...values: any[]) => ({ strings, values, type: 'sql' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  accounts: { apiKey: 'apiKey', id: 'id' },
  accountWorkspaces: { accountId: 'accountId' },
  workspaces: { id: 'id', teamId: 'teamId', accessMode: 'accessMode' },
  tasks: {
    id: 'id',
    workspaceId: 'workspaceId',
    createdAt: 'createdAt',
    title: 'title',
    status: 'status',
    description: 'description',
    context: 'context',
    updatedAt: 'updatedAt',
    pathManifest: 'pathManifest',
  },
  missions: { id: 'id' },
}));

// Import handlers AFTER mocks
import { GET, POST } from './route';

// Helper to create mock NextRequest
function createMockRequest(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  searchParams?: Record<string, string>;
} = {}): NextRequest {
  const { method = 'GET', headers = {}, body, searchParams = {} } = options;

  let url = 'http://localhost:3000/api/tasks';
  const params = new URLSearchParams(searchParams);
  if (params.toString()) {
    url += `?${params.toString()}`;
  }

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

describe('GET /api/tasks', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockAccountWorkspacesFindMany.mockReset();
    mockGetAccountWorkspacePermissions.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockTasksFindMany.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockMissionsFindFirst.mockReset();

    // Default: session auth gets workspace access
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockGetAccountWorkspacePermissions.mockResolvedValue([]);
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await GET(request);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns tasks for API key auth (linked + open workspaces)', async () => {
    const mockTasks = [
      { id: 'task-1', title: 'Task 1', workspaceId: 'ws-1', workspace: { id: 'ws-1' } },
      { id: 'task-2', title: 'Task 2', workspaceId: 'ws-2', workspace: { id: 'ws-2' } },
    ];

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
    ]);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-2' }, // Open workspace
    ]);
    mockTasksFindMany.mockResolvedValue(mockTasks);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tasks).toHaveLength(2);
    expect(data.tasks[0].id).toBe('task-1');
  });

  it('returns tasks for session auth (owned workspaces)', async () => {
    const mockTasks = [
      { id: 'task-1', title: 'Task 1', workspaceId: 'ws-1', workspace: { id: 'ws-1' } },
    ];

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockTasksFindMany.mockResolvedValue(mockTasks);

    const request = createMockRequest();
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe('task-1');
  });

  it('returns empty array when no workspaces', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockGetUserWorkspaceIds.mockResolvedValue([]);

    const request = createMockRequest();
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tasks).toHaveLength(0);
  });

  it('deduplicates workspace IDs for API key auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    // Same workspace appears in both linked and open
    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
    ]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockTasksFindMany.mockResolvedValue([
      { id: 'task-1', title: 'Task 1', workspaceId: 'ws-1' },
    ]);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await GET(request);

    expect(response.status).toBe(200);
    // Should still work without errors due to deduplication
  });
});

describe('POST /api/tasks', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockTasksInsert.mockReset();
    mockTasksUpdate.mockReset();
    mockTasksUpdateSet.mockReset();
    mockTasksUpdateWhere.mockReset();
    mockTriggerEvent.mockReset();
    mockResolveCreatorContext.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockDispatchNewTask.mockReset();
    mockMissionsFindFirst.mockReset();
    mockResolveWorkspace.mockReset();
    mockAutoResolveAccountWorkspace.mockReset();

    // Default: no open friction task (miss path)
    mockTasksFindFirst.mockResolvedValue(null);
    // Default: no in-flight tasks for path-overlap check
    mockTasksFindMany.mockResolvedValue([]);
    // Default: update chain returns cleanly
    mockTasksUpdateWhere.mockResolvedValue(undefined);
    mockTasksUpdateSet.mockReturnValue({ where: mockTasksUpdateWhere });
    mockTasksUpdate.mockReturnValue({ set: mockTasksUpdateSet });

    // Default: API key auth has workspace access
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    // Default: resolveWorkspace returns workspace with matching id
    mockResolveWorkspace.mockImplementation(async (raw: string) => ({ id: raw }));

    // Default mock for resolveCreatorContext
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: null,
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'POST',
      body: { workspaceId: 'ws-1', title: 'Test Task' },
    });
    const response = await POST(request);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 when workspaceId missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });

    const request = createMockRequest({
      method: 'POST',
      body: { title: 'Test Task' },
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('workspaceId is required');
  });

  it('returns 400 when title missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });

    const request = createMockRequest({
      method: 'POST',
      body: { workspaceId: 'ws-1' },
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Title is required');
  });

  it('returns 400 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockResolveWorkspace.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'POST',
      body: { workspaceId: 'non-existent', title: 'Test Task' },
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('No workspace found matching');
  });

  it('creates task with API key auth', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      description: null,
      status: 'pending',
      priority: 0,
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' }); // Workspace exists, no webhook

    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Test Task' },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('task-123');
    expect(data.title).toBe('Test Task');
  });

  it('creates task with session auth', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      description: null,
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'user-account-123',
      createdByWorkerId: null,
      creationSource: 'dashboard',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: { workspaceId: 'ws-1', title: 'Test Task' },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('task-123');
  });

  it('creates task with all optional fields', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      description: 'Test description',
      priority: 5,
      status: 'pending',
      context: {
        attachments: [
          { filename: 'test.png', mimeType: 'image/png', data: 'data:image/png;base64,xxx' },
        ],
      },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: {
        workspaceId: 'ws-1',
        title: 'Test Task',
        description: 'Test description',
        priority: 5,
        attachments: [
          { filename: 'test.png', mimeType: 'image/png', data: 'data:image/png;base64,xxx' },
        ],
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.description).toBe('Test description');
    expect(data.priority).toBe(5);
  });

  it('creates task with assignToLocalUiUrl and triggers dispatch', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: {
        workspaceId: 'ws-1',
        title: 'Test Task',
        assignToLocalUiUrl: 'http://localhost:3456',
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);

    // dispatchNewTask should be called with the task, workspace, and options
    expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
    expect(mockDispatchNewTask.mock.calls[0][0]).toEqual(createdTask);
    expect(mockDispatchNewTask.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        assignToLocalUiUrl: 'http://localhost:3456',
      })
    );
  });

  it('dispatches task on successful creation', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: { workspaceId: 'ws-1', title: 'Test Task' },
    });
    await POST(request);

    expect(mockDispatchNewTask).toHaveBeenCalledWith(
      createdTask,
      { id: 'ws-1' },
      expect.any(Object)
    );
  });

  it('sets createdByAccountId from resolveCreatorContext', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      createdByAccountId: 'account-123',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Test Task' },
    });
    await POST(request);

    expect(capturedValues.createdByAccountId).toBe('account-123');
  });

  it('sets creationSource correctly', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      creationSource: 'mcp',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'mcp',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Test Task', creationSource: 'mcp' },
    });
    await POST(request);

    expect(capturedValues.creationSource).toBe('mcp');
  });

  it('validates createdByWorkerId belongs to account', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      createdByWorkerId: 'worker-1',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: 'worker-1',
      creationSource: 'mcp',
      parentTaskId: 'parent-task-1',
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Test Task',
        createdByWorkerId: 'worker-1',
      },
    });
    await POST(request);

    // resolveCreatorContext is called with the worker ID
    expect(mockResolveCreatorContext).toHaveBeenCalledWith(
      expect.objectContaining({
        createdByWorkerId: 'worker-1',
      })
    );
  });

  it('auto-derives parentTaskId from worker', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      parentTaskId: 'parent-task-1',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: 'worker-1',
      creationSource: 'mcp',
      parentTaskId: 'parent-task-1', // Derived from worker's current task
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Test Task',
        createdByWorkerId: 'worker-1',
      },
    });
    await POST(request);

    expect(capturedValues.parentTaskId).toBe('parent-task-1');
  });

  it('passes workspace with webhook config to dispatchNewTask', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      description: 'Test description',
      status: 'pending',
    };

    const workspace = {
      id: 'ws-1',
      webhookConfig: {
        enabled: true,
        url: 'https://webhook.example.com',
        token: 'webhook-token',
      },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue(workspace);

    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: {
        workspaceId: 'ws-1',
        title: 'Test Task',
        description: 'Test description',
      },
    });
    await POST(request);

    // dispatchNewTask receives the workspace with webhook config
    expect(mockDispatchNewTask).toHaveBeenCalledWith(
      createdTask,
      workspace,
      expect.any(Object)
    );
  });

  it('creates task with project field set', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      project: '@mono/web',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: { workspaceId: 'ws-1', title: 'Test Task', project: '@mono/web' },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.project).toBe('@mono/web');
  });

  it('creates task without project (remains null)', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: { workspaceId: 'ws-1', title: 'Test Task' },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.project).toBeUndefined();
  });

  it('passes project field through to db.insert values', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      project: '@mono/web',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Test Task', project: '@mono/web' },
    });
    await POST(request);

    expect(capturedValues.project).toBe('@mono/web');
  });

  // ── agent backend resolution ─────────────────────────────────────────

  function backendCase() {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({ createdByAccountId: 'account-123', createdByWorkerId: null, creationSource: 'api', parentTaskId: null });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    let capturedValues: any = null;
    const mockValues = mock((values: any) => { capturedValues = values; return { returning: mock(() => [{ id: 'task-123', workspaceId: 'ws-1', title: 'T' }]) }; });
    mockTasksInsert.mockReturnValue({ values: mockValues });
    return () => capturedValues;
  }

  it('inherits backend from the role default when not explicitly set', async () => {
    const captured = backendCase();
    mockWorkspaceSkillsFindFirst.mockResolvedValue({ defaultBackend: 'codex' });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', roleSlug: 'builder' },
    });
    await POST(request);
    expect(captured().backend).toBe('codex');
  });

  it('explicit task.backend overrides the role default', async () => {
    const captured = backendCase();
    mockWorkspaceSkillsFindFirst.mockResolvedValue({ defaultBackend: 'codex' });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', roleSlug: 'builder', backend: 'claude' },
    });
    await POST(request);
    expect(captured().backend).toBe('claude');
  });

  it('omits backend (schema default applies) when neither task nor role specify one', async () => {
    const captured = backendCase();
    mockWorkspaceSkillsFindFirst.mockResolvedValue({ defaultBackend: null });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T' },
    });
    await POST(request);
    expect(captured().backend).toBeUndefined();
  });

  it('inherits backend from the mission default when not explicitly set', async () => {
    const captured = backendCase();
    mockMissionsFindFirst.mockResolvedValue({ defaultBackend: 'codex' });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', missionId: 'm-1' },
    });
    await POST(request);
    expect(captured().backend).toBe('codex');
  });

  it('mission default backend overrides the role default', async () => {
    const captured = backendCase();
    mockMissionsFindFirst.mockResolvedValue({ defaultBackend: 'codex' });
    mockWorkspaceSkillsFindFirst.mockResolvedValue({ defaultBackend: 'claude' });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', missionId: 'm-1', roleSlug: 'builder' },
    });
    await POST(request);
    expect(captured().backend).toBe('codex');
  });

  it('explicit task.backend overrides the mission default', async () => {
    const captured = backendCase();
    mockMissionsFindFirst.mockResolvedValue({ defaultBackend: 'codex' });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', missionId: 'm-1', backend: 'claude' },
    });
    await POST(request);
    expect(captured().backend).toBe('claude');
  });

  it('falls through to the role default when the mission has no backend', async () => {
    const captured = backendCase();
    mockMissionsFindFirst.mockResolvedValue({ defaultBackend: null });
    mockWorkspaceSkillsFindFirst.mockResolvedValue({ defaultBackend: 'codex' });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', missionId: 'm-1', roleSlug: 'builder' },
    });
    await POST(request);
    expect(captured().backend).toBe('codex');
  });

  it('falls back to the workspace gitConfig.defaultBackend when task, mission, and role do not specify', async () => {
    const captured = backendCase();
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', gitConfig: { defaultBackend: 'codex' } });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T' },
    });
    await POST(request);
    expect(captured().backend).toBe('codex');
  });

  it('role default takes precedence over the workspace default', async () => {
    const captured = backendCase();
    mockWorkspaceSkillsFindFirst.mockResolvedValue({ defaultBackend: 'claude' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', gitConfig: { defaultBackend: 'codex' } });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', roleSlug: 'builder' },
    });
    await POST(request);
    expect(captured().backend).toBe('claude');
  });

  // ── outputRequirement inheritance from missions ──────────────────────

  it('inherits outputRequirement from mission when not explicitly set', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      outputRequirement: 'pr_required',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockMissionsFindFirst.mockResolvedValue({ defaultOutputRequirement: 'pr_required' });

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Test Task', missionId: 'obj-1' },
    });
    await POST(request);

    expect(capturedValues.outputRequirement).toBe('pr_required');
  });

  it('uses explicit outputRequirement when provided, ignoring mission default', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      outputRequirement: 'none',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    // Mission has pr_required, but explicit 'none' should win
    mockMissionsFindFirst.mockResolvedValue({ defaultOutputRequirement: 'pr_required' });

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Test Task', missionId: 'obj-1', outputRequirement: 'none' },
    });
    await POST(request);

    expect(capturedValues.outputRequirement).toBe('none');
    // Should NOT have queried the mission since explicit value was provided
    // (Note: due to mock structure, findFirst may still be callable but outputRequirement should be 'none')
  });

  it('falls back to auto when mission has no defaultOutputRequirement', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      outputRequirement: 'auto',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockMissionsFindFirst.mockResolvedValue({ defaultOutputRequirement: null });

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Test Task', missionId: 'obj-1' },
    });
    await POST(request);

    expect(capturedValues.outputRequirement).toBe('auto');
  });

  it('does not look up mission when no missionId provided', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockMissionsFindFirst.mockClear();

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Test Task' },
    });
    await POST(request);

    // Should NOT have queried missions table
    expect(mockMissionsFindFirst).not.toHaveBeenCalled();
    // outputRequirement should not be set (DB default 'auto' applies)
    expect(capturedValues.outputRequirement).toBeUndefined();
  });

  it('does not dispatch to webhook when assignToLocalUiUrl is set', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    // Even with webhook config, should not dispatch
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      webhookConfig: {
        enabled: true,
        url: 'https://webhook.example.com',
        token: 'webhook-token',
      },
    });

    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const originalFetch = global.fetch;
    const mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
    );
    global.fetch = mockFetch as any;

    try {
      const request = createMockRequest({
        method: 'POST',
        body: {
          workspaceId: 'ws-1',
          title: 'Test Task',
          assignToLocalUiUrl: 'http://localhost:3456',
        },
      });
      await POST(request);

      // Webhook should NOT be called when assignToLocalUiUrl is set
      // (workspace findFirst is not even called in this case since we skip webhook check)
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('forwards requiresReview: true to the DB insert', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Review Task',
      requiresReview: true,
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Review Task', requiresReview: true },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(capturedValues.requiresReview).toBe(true);
  });

  it('does not set requiresReview in insert when not provided (DB default applies)', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Normal Task',
      requiresReview: false,
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Normal Task' },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    // requiresReview not set in insert values — DB default (false) applies
    expect(capturedValues.requiresReview).toBeUndefined();
  });

  // ── outputSchema content-field denylist (sensitive workspaces) ──────────────

  it('rejects outputSchema with denylist field "subject" in sensitive workspace', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-sensitive',
      gitConfig: { dataClass: 'sensitive' },
    });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-sensitive',
        title: 'Triage Email',
        outputSchema: {
          type: 'object',
          properties: {
            subject: { type: 'string' },
            messageId: { type: 'string' },
          },
        },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('subject');
    expect(data.error).toContain('sensitive workspaces');
  });

  it('rejects outputSchema with multiple denylist fields in sensitive workspace', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-sensitive',
      gitConfig: { dataClass: 'sensitive' },
    });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-sensitive',
        title: 'Bad Schema Task',
        outputSchema: {
          type: 'object',
          properties: {
            body: { type: 'string' },
            sender: { type: 'string' },
            correlationKey: { type: 'string' },
          },
        },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('body');
    expect(data.error).toContain('sender');
  });

  it('allows operational-only outputSchema in sensitive workspace', async () => {
    const createdTask = { id: 'task-123', workspaceId: 'ws-sensitive', title: 'Heartbeat' };
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-sensitive',
      gitConfig: { dataClass: 'sensitive' },
    });
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-sensitive',
        title: 'Heartbeat',
        outputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok', 'action_taken', 'error'] },
            tasksCreated: { type: 'integer' },
            actionCount: { type: 'integer' },
          },
          required: ['status'],
        },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
  });

  it('allows denylist field names that are non-string typed in sensitive workspace', async () => {
    // e.g. an integer field named "to" should not be flagged
    const createdTask = { id: 'task-123', workspaceId: 'ws-sensitive', title: 'Count Task' };
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-sensitive',
      gitConfig: { dataClass: 'sensitive' },
    });
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-sensitive',
        title: 'Count Task',
        outputSchema: {
          type: 'object',
          properties: {
            // "email" typed as integer (e.g. email count) — not content-bearing
            email: { type: 'integer' },
            status: { type: 'string', enum: ['ok'] },
          },
        },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
  });

  it('allows content-field names in non-sensitive workspace outputSchema', async () => {
    // Standard workspace: denylist check does not apply
    const createdTask = { id: 'task-123', workspaceId: 'ws-standard', title: 'Any Task' };
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-standard',
      gitConfig: { dataClass: 'standard' },
    });
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-standard',
        title: 'Any Task',
        outputSchema: {
          type: 'object',
          properties: {
            subject: { type: 'string' },
            body: { type: 'string' },
          },
        },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
  });

  // ── friction task dedup gate ─────────────────────────────────────────────

  function frictionSetup() {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'mcp',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
  }

  it('bwrap replay: first filing creates a task and stamps frictionSignature', async () => {
    frictionSetup();
    // No existing open task with the same signature
    mockTasksFindFirst.mockResolvedValue(null);

    const createdTask = {
      id: 'task-T1',
      workspaceId: 'ws-1',
      title: '[friction] bwrap namespace denied',
      context: { frictionSignature: 'bwrap_namespace_denied' },
    };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] bwrap namespace denied',
        description: 'bwrap: No permissions to create a new namespace',
        context: { frictionSignature: 'bwrap_namespace_denied', frictionExcerpt: 'bwrap: No permissions...' },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('task-T1');
    // No deduplicated flag on fresh create
    expect(data.deduplicated).toBeUndefined();
    // db.insert was called (task was created)
    expect(mockTasksInsert).toHaveBeenCalledTimes(1);
    // db.update was NOT called
    expect(mockTasksUpdate).not.toHaveBeenCalled();
  });

  it('bwrap replay: second filing deduplicates and appends to existing task', async () => {
    frictionSetup();
    const existingTask = {
      id: 'task-T1',
      title: '[friction] bwrap namespace denied',
      description: 'bwrap: No permissions to create a new namespace',
    };
    // Open task with same signature exists
    mockTasksFindFirst.mockResolvedValue(existingTask);

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] bwrap namespace denied',
        description: 'Worker B also hit bwrap namespace denied',
        context: { frictionSignature: 'bwrap_namespace_denied', frictionExcerpt: 'bwrap: No permissions...' },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    // Returns existing task id
    expect(data.id).toBe('task-T1');
    expect(data.deduplicated).toBe(true);
    // db.insert was NOT called (no new task)
    expect(mockTasksInsert).not.toHaveBeenCalled();
    // db.update was called to append the report
    expect(mockTasksUpdate).toHaveBeenCalledTimes(1);
    expect(mockTasksUpdateSet).toHaveBeenCalledTimes(1);
    expect(mockTasksUpdateWhere).toHaveBeenCalledTimes(1);
  });

  it('bwrap replay: third filing also deduplicates — still exactly one task', async () => {
    frictionSetup();
    const existingTask = {
      id: 'task-T1',
      title: '[friction] bwrap namespace denied',
      description: 'bwrap: No permissions (+ Worker B report)',
    };
    mockTasksFindFirst.mockResolvedValue(existingTask);

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] bwrap namespace denied',
        description: 'Worker C also hit bwrap namespace denied',
        context: { frictionSignature: 'bwrap_namespace_denied' },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('task-T1');
    expect(data.deduplicated).toBe(true);
    expect(mockTasksInsert).not.toHaveBeenCalled();
    expect(mockTasksUpdate).toHaveBeenCalledTimes(1);
  });

  it('same signature in different workspace creates a fresh task (no dedup cross-workspace)', async () => {
    frictionSetup();
    // Simulate: no match in ws-2 (different workspace from ws-1 where T1 lives)
    mockTasksFindFirst.mockResolvedValue(null);

    const createdTask = {
      id: 'task-T2',
      workspaceId: 'ws-2',
      title: '[friction] bwrap namespace denied',
    };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });
    // ws-2 resolveWorkspace
    mockResolveWorkspace.mockResolvedValue({ id: 'ws-2' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-2' });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-2',
        title: '[friction] bwrap namespace denied',
        description: 'bwrap: No permissions to create a new namespace',
        context: { frictionSignature: 'bwrap_namespace_denied' },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('task-T2');
    expect(data.deduplicated).toBeUndefined();
    // Fresh task created in ws-2
    expect(mockTasksInsert).toHaveBeenCalledTimes(1);
    expect(mockTasksUpdate).not.toHaveBeenCalled();
  });

  it('matched task already completed → files fresh task (open-only dedup window)', async () => {
    frictionSetup();
    // findFirst returns null because the completed task is excluded by the NOT IN filter
    // (the route's query already filters out completed/failed/cancelled)
    mockTasksFindFirst.mockResolvedValue(null);

    const createdTask = {
      id: 'task-T3',
      workspaceId: 'ws-1',
      title: '[friction] bwrap namespace denied',
    };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] bwrap namespace denied',
        context: { frictionSignature: 'bwrap_namespace_denied' },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('task-T3');
    expect(data.deduplicated).toBeUndefined();
    expect(mockTasksInsert).toHaveBeenCalledTimes(1);
  });

  it('friction task without frictionSignature in context bypasses dedup and creates normally', async () => {
    frictionSetup();

    const createdTask = {
      id: 'task-T4',
      workspaceId: 'ws-1',
      title: '[friction] some untraced error',
    };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] some untraced error',
        description: 'Something weird happened',
        // No frictionSignature in context
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    // db.query.tasks.findFirst should NOT have been called (no signature → no dedup check)
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
    expect(mockTasksInsert).toHaveBeenCalledTimes(1);
  });

  it('non-friction task with frictionSignature bypasses dedup gate', async () => {
    frictionSetup();

    const createdTask = { id: 'task-T5', workspaceId: 'ws-1', title: 'Normal task' };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Normal task',
        context: { frictionSignature: 'bwrap_namespace_denied' },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    // Gate only triggers when title starts with '[friction] '
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
    expect(mockTasksInsert).toHaveBeenCalledTimes(1);
  });

  // ── manifest inference on the dedup-miss (new friction task) path ─────────

  it('manifest inference: explicit path in frictionExcerpt → pathManifest on created task', async () => {
    frictionSetup();
    mockTasksFindFirst.mockResolvedValue(null); // dedup miss

    let capturedValues: any = null;
    const createdTask = { id: 'task-M1', workspaceId: 'ws-1', title: '[friction] enoent in runner' };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] enoent in runner',
        description: "ENOENT: no such file or directory, 'apps/runner/src/env-scan.ts'",
        context: {
          frictionSignature: 'enoent',
          frictionExcerpt: "ENOENT: no such file or directory, 'apps/runner/src/env-scan.ts'",
        },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    // The inferred manifest must be stamped on the task row
    expect(capturedValues.pathManifest).toEqual(['apps/runner/src/env-scan.ts']);
  });

  it('manifest inference: pathless trace → fallback component table (bwrap_namespace_denied)', async () => {
    frictionSetup();
    mockTasksFindFirst.mockResolvedValue(null);

    let capturedValues: any = null;
    const createdTask = { id: 'task-M2', workspaceId: 'ws-1', title: '[friction] bwrap namespace denied' };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] bwrap namespace denied',
        description: 'bwrap: No permissions to create a new namespace',
        context: {
          frictionSignature: 'bwrap_namespace_denied',
          frictionExcerpt: 'bwrap: No permissions to create a new namespace',
        },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    // Fallback table for bwrap_namespace_denied includes both runner files
    expect(capturedValues.pathManifest).toEqual([
      'apps/runner/src/env-scan.ts',
      'apps/runner/src/workers.ts',
    ]);
  });

  it('bwrap fixture: env-scan.ts origin → manifest contains apps/runner/src/env-scan.ts', async () => {
    frictionSetup();
    mockTasksFindFirst.mockResolvedValue(null);

    let capturedValues: any = null;
    const createdTask = { id: 'task-M3', workspaceId: 'ws-1', title: '[friction] bwrap namespace denied' };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] bwrap namespace denied',
        description: 'bwrap: No permissions to create a new namespace',
        // frictionExcerpt names env-scan.ts explicitly — path extraction wins
        context: {
          frictionSignature: 'bwrap_namespace_denied',
          frictionExcerpt:
            'bwrap: No permissions to create a new namespace — from apps/runner/src/env-scan.ts',
        },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(capturedValues.pathManifest).toContain('apps/runner/src/env-scan.ts');
  });

  it('inferred manifest overlapping a sibling pending task → auto-dependsOn edge created', async () => {
    frictionSetup();
    mockTasksFindFirst.mockResolvedValue(null); // dedup miss

    // Sibling task in-flight that touches apps/runner/src/workers.ts
    mockTasksFindMany.mockResolvedValue([
      { id: 'sibling-task-99', pathManifest: ['apps/runner/src/workers.ts'] },
    ]);

    let capturedValues: any = null;
    const createdTask = { id: 'task-M4', workspaceId: 'ws-1', title: '[friction] bwrap namespace denied' };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] bwrap namespace denied',
        description: 'bwrap: No permissions to create a new namespace',
        context: {
          frictionSignature: 'bwrap_namespace_denied',
          frictionExcerpt: 'bwrap: No permissions to create a new namespace',
        },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    // pathManifest was inferred (fallback table)
    expect(capturedValues.pathManifest).toEqual([
      'apps/runner/src/env-scan.ts',
      'apps/runner/src/workers.ts',
    ]);
    // The overlap with the sibling task triggered the auto-dependsOn edge
    expect(capturedValues.dependsOn).toContain('sibling-task-99');
  });

  it('manifest inference skipped when caller already provides pathManifest', async () => {
    frictionSetup();
    mockTasksFindFirst.mockResolvedValue(null);

    let capturedValues: any = null;
    const createdTask = { id: 'task-M5', workspaceId: 'ws-1', title: '[friction] bwrap namespace denied' };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] bwrap namespace denied',
        context: {
          frictionSignature: 'bwrap_namespace_denied',
          frictionExcerpt: 'bwrap: No permissions to create a new namespace',
        },
        // Caller explicitly provides a manifest
        pathManifest: ['apps/runner/src/sandbox.ts'],
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    // The caller-supplied manifest is used as-is; inference is skipped
    expect(capturedValues.pathManifest).toEqual(['apps/runner/src/sandbox.ts']);
  });
});
