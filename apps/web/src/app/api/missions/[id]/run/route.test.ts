import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockBuildMissionContext = mock(() => Promise.resolve(null as any));
const mockDispatchNewTask = mock(() => Promise.resolve());
const mockGetOrCreateCoordinationWorkspace = mock(() => Promise.resolve({ id: 'orchestrator-ws' }));

const mockMissionsFindFirst = mock(() => null as any);
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

// Mock mission-context
mock.module('@/lib/mission-context', () => ({
  buildMissionContext: mockBuildMissionContext,
}));

// Mock task-dispatch
mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: mockDispatchNewTask,
}));

// Mock orchestrator-workspace
mock.module('@/lib/orchestrator-workspace', () => ({
  getOrCreateCoordinationWorkspace: mockGetOrCreateCoordinationWorkspace,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst },
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
  missions: { id: 'id', teamId: 'teamId', workspaceId: 'workspaceId' },
  tasks: { id: 'id', workspaceId: 'workspaceId', missionId: 'missionId' },
  taskSchedules: { id: 'id' },
  workspaces: { id: 'id' },
}));

// Import handler AFTER mocks
import { POST } from './route';

function createMockRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/missions/obj-123/run', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
  });
}

async function callHandler(request: NextRequest, id: string) {
  return POST(request, { params: Promise.resolve({ id }) });
}

describe('POST /api/missions/[id]/run', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockBuildMissionContext.mockReset();
    mockDispatchNewTask.mockReset();
    mockGetOrCreateCoordinationWorkspace.mockReset();
    mockGetOrCreateCoordinationWorkspace.mockResolvedValue({ id: 'orchestrator-ws' });
    mockMissionsFindFirst.mockReset();
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

  it('returns 404 when mission not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue(null);

    const response = await callHandler(createMockRequest(), 'nonexistent');
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Mission not found');
  });

  it('returns 404 when mission belongs to different team', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-123',
      teamId: 'team-other',
      workspaceId: 'ws-1',
      status: 'active',
    });

    const response = await callHandler(createMockRequest(), 'obj-123');
    expect(response.status).toBe(404);
  });

  it('auto-creates orchestrator workspace when mission has no workspaceId', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-123',
      title: 'No WS Mission',
      teamId: 'team-1',
      workspaceId: null,
      status: 'active',
      priority: 0,
      schedule: null,
    });

    mockBuildMissionContext.mockResolvedValue({
      description: '## Mission',
      context: { missionId: 'obj-123', missionTitle: 'No WS Mission', recentCompletions: [], activeTasks: [] },
    });

    const createdTask = { id: 'task-new', title: 'Mission: No WS Mission', workspaceId: 'orchestrator-ws', status: 'pending' };
    mockInsertReturning.mockResolvedValue([createdTask]);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'orchestrator-ws', name: '__coordination' });

    const response = await callHandler(createMockRequest(), 'obj-123');
    expect(response.status).toBe(201);

    // Verify orchestrator workspace was requested for the right team
    expect(mockGetOrCreateCoordinationWorkspace).toHaveBeenCalledWith('team-1');

    // Verify task was created with orchestrator workspace
    const insertCall = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(insertCall.workspaceId).toBe('orchestrator-ws');
  });

  it('returns 400 when mission is not active', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue({
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
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-123',
      title: 'My Mission',
      description: 'Do stuff',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      priority: 5,
      schedule: null,
    });

    mockBuildMissionContext.mockResolvedValue({
      description: '## Mission: My Mission\nDo stuff',
      context: { missionId: 'obj-123', missionTitle: 'My Mission', recentCompletions: [], activeTasks: [] },
    });

    const createdTask = {
      id: 'task-new',
      title: 'Mission: My Mission',
      workspaceId: 'ws-1',
      status: 'pending',
      mode: 'planning',
      missionId: 'obj-123',
    };
    mockInsertReturning.mockResolvedValue([createdTask]);

    const mockWorkspace = { id: 'ws-1', name: 'Test WS' };
    mockWorkspacesFindFirst.mockResolvedValue(mockWorkspace);

    const response = await callHandler(createMockRequest(), 'obj-123');
    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data.task.id).toBe('task-new');
    expect(data.task.mode).toBe('planning');
    expect(data.task.missionId).toBe('obj-123');

    // Verify dispatch was called
    expect(mockDispatchNewTask).toHaveBeenCalledWith(createdTask, mockWorkspace);

    // Verify creationSource is 'orchestrator'
    const insertCall = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(insertCall.creationSource).toBe('orchestrator');
  });

  it('works with API key auth (admin level)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'admin' });
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-123',
      title: 'My Mission',
      teamId: 'team-1',
      workspaceId: 'ws-1',
      status: 'active',
      priority: 0,
      schedule: null,
    });

    mockBuildMissionContext.mockResolvedValue({
      description: '## Mission: My Mission',
      context: { missionId: 'obj-123', missionTitle: 'My Mission', recentCompletions: [], activeTasks: [] },
    });

    const createdTask = { id: 'task-new', title: 'Mission: My Mission', workspaceId: 'ws-1', status: 'pending' };
    mockInsertReturning.mockResolvedValue([createdTask]);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'WS' });

    const request = new NextRequest('http://localhost:3000/api/missions/obj-123/run', {
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

    const request = new NextRequest('http://localhost:3000/api/missions/obj-123/run', {
      method: 'POST',
      headers: new Headers({
        'authorization': 'Bearer bld_testapikey',
      }),
    });

    const response = await callHandler(request, 'obj-123');
    expect(response.status).toBe(403);
  });
});
