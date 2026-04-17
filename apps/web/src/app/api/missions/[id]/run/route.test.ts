import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));
const mockResolveAccountTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockRunMission = mock(() => Promise.resolve({ task: { id: 'task-new' } } as any));
const mockMissionsFindFirst = mock(() => null as any);
const mockTeamMembersFindFirst = mock(() => null as any);

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
  resolveAccountTeamIds: mockResolveAccountTeamIds,
}));

// Mock mission-run
mock.module('@/lib/mission-run', () => ({
  runMission: mockRunMission,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst },
      teamMembers: { findFirst: mockTeamMembersFindFirst },
    },
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'id', teamId: 'teamId' },
  teamMembers: { teamId: 'teamId', role: 'role', userId: 'userId' },
  tasks: { id: 'id' },
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
    mockResolveAccountTeamIds.mockReset();
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockRunMission.mockReset();
    mockMissionsFindFirst.mockReset();
    mockTeamMembersFindFirst.mockReset();

    // Default auth
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockRunMission.mockResolvedValue({ task: { id: 'task-new', title: 'Mission: Test', mode: 'planning', missionId: 'obj-123' } });
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
    });

    const response = await callHandler(createMockRequest(), 'obj-123');
    expect(response.status).toBe(404);
  });

  it('returns 400 when mission is not active', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-123',
      teamId: 'team-1',
    });
    mockRunMission.mockRejectedValue(new Error('Cannot run mission with status: paused. Only active missions can be run.'));

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
      teamId: 'team-1',
    });

    const createdTask = {
      id: 'task-new',
      title: 'Mission: My Mission',
      workspaceId: 'ws-1',
      status: 'pending',
      mode: 'planning',
      missionId: 'obj-123',
    };
    mockRunMission.mockResolvedValue({ task: createdTask });

    const response = await callHandler(createMockRequest(), 'obj-123');
    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data.task.id).toBe('task-new');
    expect(data.task.mode).toBe('planning');
    expect(data.task.missionId).toBe('obj-123');

    // Verify runMission was called with manualRun
    expect(mockRunMission).toHaveBeenCalledWith('obj-123', { manualRun: true });
  });

  it('works with API key auth (admin level)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acc-1', teamId: 'team-1', level: 'admin' });
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-123',
      teamId: 'team-1',
    });

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

  it('returns 200 with deduped:true when an in-flight planning task already exists', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue({
      id: 'obj-123',
      teamId: 'team-1',
    });

    const existing = {
      id: 'task-existing',
      title: 'Mission: Test',
      mode: 'planning',
      status: 'in_progress',
      missionId: 'obj-123',
    };
    mockRunMission.mockResolvedValue({ task: existing, deduped: true });

    const response = await callHandler(createMockRequest(), 'obj-123');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.deduped).toBe(true);
    expect(data.task.id).toBe('task-existing');
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
