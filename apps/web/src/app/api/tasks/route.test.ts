import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockAccountWorkspacesFindMany = mock(() => [] as any[]);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockTasksFindMany = mock(() => [] as any[]);
const mockTasksInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() => []),
  })),
}));
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
      tasks: { findMany: mockTasksFindMany },
    },
    insert: mockTasksInsert,
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  desc: (field: any) => ({ field, type: 'desc' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  accounts: { apiKey: 'apiKey', id: 'id' },
  accountWorkspaces: { accountId: 'accountId' },
  workspaces: { id: 'id', teamId: 'teamId', accessMode: 'accessMode' },
  tasks: { id: 'id', workspaceId: 'workspaceId', createdAt: 'createdAt' },
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
    mockWorkspacesFindMany.mockReset();
    mockTasksFindMany.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();

    // Default: session auth gets workspace access
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
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
    mockAccountWorkspacesFindMany.mockResolvedValue([
      { workspaceId: 'ws-1' },
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
    mockAccountWorkspacesFindMany.mockResolvedValue([{ workspaceId: 'ws-1' }]);
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
    mockTasksInsert.mockReset();
    mockTriggerEvent.mockReset();
    mockResolveCreatorContext.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockDispatchNewTask.mockReset();

    // Default: API key auth has workspace access
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);

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
    expect(data.error).toContain('Workspace and title are required');
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
    expect(data.error).toContain('Workspace and title are required');
  });

  it('returns 400 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'POST',
      body: { workspaceId: 'non-existent', title: 'Test Task' },
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Workspace not found');
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
});
