import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockBuildObjectiveContext = mock(() => Promise.resolve(null as any));
const mockDispatchNewTask = mock(() => Promise.resolve());

const mockObjectivesFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockInsertReturning = mock(() => [] as any[]);
const mockInsertValues = mock(() => ({ returning: mockInsertReturning }));
const mockInsert = mock(() => ({ values: mockInsertValues }));

// Mock auth-helpers
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// Mock api-auth
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
  hashApiKey: (key: string) => `hashed_${key}`,
  extractApiKeyPrefix: (key: string) => key.substring(0, 12),
}));

// Mock team-access
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
}));

// Mock objective-context
mock.module('@/lib/objective-context', () => ({
  buildObjectiveContext: mockBuildObjectiveContext,
}));

// Mock task-dispatch
mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: mockDispatchNewTask,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      objectives: { findFirst: mockObjectivesFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    insert: mockInsert,
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  objectives: { id: 'id', teamId: 'teamId', workspaceId: 'workspaceId' },
  tasks: { id: 'id', workspaceId: 'workspaceId', objectiveId: 'objectiveId' },
  taskSchedules: { id: 'id' },
  workspaces: { id: 'id' },
}));

// Import handler AFTER mocks
import { POST } from './route';

function createMockRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/objectives/obj-123/run', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
  });
}

async function callHandler(request: NextRequest, id: string) {
  return POST(request, { params: Promise.resolve({ id }) });
}

describe('POST /api/objectives/[id]/run', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockBuildObjectiveContext.mockReset();
    mockDispatchNewTask.mockReset();
    mockObjectivesFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockInsert.mockReset();
    mockInsertValues.mockReset();
    mockInsertReturning.mockReset();

    // Restore mock chain
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockInsertValues.mockReturnValue({ returning: mockInsertReturning });

    // Default auth
    mockAuthenticateApiKey.mockResolvedValue(null);
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);

    const response = await callHandler(createMockRequest(), 'obj-123');
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when objective not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockObjectivesFindFirst.mockResolvedValue(null);

    const response = await callHandler(createMockRequest(), 'nonexistent');
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Objective not found');
  });

  it('returns 404 when objective belongs to different team', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockObjectivesFindFirst.mockResolvedValue({
      id: 'obj-123',
      teamId: 'team-other',
      workspaceId: 'ws-1',
      status: 'active',
    });

    const response = await callHandler(createMockRequest(), 'obj-123');
    expect(response.status).toBe(404);
  });

  it('returns 400 when objective has no workspaceId', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockObjectivesFindFirst.mockResolvedValue({
      id: 'obj-123',
      teamId: 'team-1',
      workspaceId: null,
      status: 'active',
      schedule: null,
    });

    const response = await callHandler(createMockRequest(), 'obj-123');
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('workspace');
  });

  it('returns 400 when objective is not active', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockObjectivesFindFirst.mockResolvedValue({
      id: 'obj-123',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'paused',
      schedule: null,
    });

    const response = await callHandler(createMockRequest(), 'obj-123');
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('paused');
  });

  it('creates planning task and returns it with 201', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockObjectivesFindFirst.mockResolvedValue({
      id: 'obj-123',
      title: 'My Objective',
      description: 'Do stuff',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      priority: 5,
      schedule: null,
    });

    mockBuildObjectiveContext.mockResolvedValue({
      description: '## Objective: My Objective\nDo stuff',
      context: { objectiveId: 'obj-123', objectiveTitle: 'My Objective', recentCompletions: [], activeTasks: [] },
    });

    const createdTask = {
      id: 'task-new',
      title: 'Objective: My Objective',
      workspaceId: 'ws-1',
      status: 'pending',
      mode: 'planning',
      objectiveId: 'obj-123',
    };
    mockInsertReturning.mockResolvedValue([createdTask]);

    const mockWorkspace = { id: 'ws-1', name: 'Test WS' };
    mockWorkspacesFindFirst.mockResolvedValue(mockWorkspace);

    const response = await callHandler(createMockRequest(), 'obj-123');
    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data.task.id).toBe('task-new');
    expect(data.task.mode).toBe('planning');
    expect(data.task.objectiveId).toBe('obj-123');

    // Verify dispatch was called
    expect(mockDispatchNewTask).toHaveBeenCalledWith(createdTask, mockWorkspace);
  });

  it('works with API key auth (admin level)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'admin' });
    mockObjectivesFindFirst.mockResolvedValue({
      id: 'obj-123',
      title: 'My Objective',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      priority: 0,
      schedule: null,
    });

    mockBuildObjectiveContext.mockResolvedValue({
      description: '## Objective: My Objective',
      context: { objectiveId: 'obj-123', objectiveTitle: 'My Objective', recentCompletions: [], activeTasks: [] },
    });

    const createdTask = { id: 'task-new', title: 'Objective: My Objective', workspaceId: 'ws-1', status: 'pending' };
    mockInsertReturning.mockResolvedValue([createdTask]);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'WS' });

    const request = new NextRequest('http://localhost:3000/api/objectives/obj-123/run', {
      method: 'POST',
      headers: new Headers({
        'content-type': 'application/json',
        'authorization': 'Bearer bld_testapikey',
      }),
    });

    const response = await callHandler(request, 'obj-123');
    expect(response.status).toBe(201);
  });

  it('returns 403 for non-admin API key', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'worker' });

    const request = new NextRequest('http://localhost:3000/api/objectives/obj-123/run', {
      method: 'POST',
      headers: new Headers({
        'authorization': 'Bearer bld_testapikey',
      }),
    });

    const response = await callHandler(request, 'obj-123');
    expect(response.status).toBe(403);
  });
});
