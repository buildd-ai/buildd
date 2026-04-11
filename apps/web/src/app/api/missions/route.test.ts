import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => ({ id: 'user-1' }) as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1']));
const mockMissionsFindMany = mock(() => [] as any[]);
const mockWorkspacesFindFirst = mock(() => ({ id: 'ws-1' }) as any);
const mockRunMission = mock(() => Promise.resolve({ task: { id: 'organizer-task-1' } }));
let insertedMissionValues: any = null;
let insertedScheduleValues: any = null;
const mockMissionsInsert = mock(() => ({
  values: mock((vals: any) => {
    insertedMissionValues = vals;
    return {
      returning: mock(() => [{ id: 'obj-1', ...vals }]),
    };
  }),
}));
const mockSchedulesInsert = mock(() => ({
  values: mock((vals: any) => {
    insertedScheduleValues = vals;
    return {
      returning: mock(() => [{ id: 'sched-1', ...vals }]),
    };
  }),
}));
const mockMissionsUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mock(() => []),
    })),
  })),
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
  hashApiKey: (key: string) => `hashed_${key}`,
  extractApiKeyPrefix: (key: string) => key.substring(0, 12),
}));

mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
}));

mock.module('@/lib/schedule-helpers', () => ({
  computeNextRunAt: () => new Date('2026-01-01'),
}));

mock.module('@/lib/mission-run', () => ({
  runMission: mockRunMission,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findMany: mockMissionsFindMany },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    insert: (table: any) => {
      if (table === 'missions') return mockMissionsInsert();
      if (table === 'taskSchedules') return mockSchedulesInsert();
      return mockMissionsInsert();
    },
    update: () => mockMissionsUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => args,
  desc: (field: any) => ({ field, type: 'desc' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: 'missions',
  workspaces: { id: 'id', teamId: 'teamId' },
  taskSchedules: 'taskSchedules',
}));

import { POST } from './route';

describe('POST /api/missions', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockMissionsInsert.mockReset();
    mockSchedulesInsert.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockRunMission.mockReset();
    insertedMissionValues = null;
    insertedScheduleValues = null;

    mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockWorkspacesFindFirst.mockReturnValue({ id: 'ws-1', teamId: 'team-1' });
    mockRunMission.mockResolvedValue({ task: { id: 'organizer-task-1' } });

    mockMissionsInsert.mockImplementation(() => ({
      values: mock((vals: any) => {
        insertedMissionValues = vals;
        return {
          returning: mock(() => [{ id: 'obj-1', ...vals }]),
        };
      }),
    }));

    mockSchedulesInsert.mockImplementation(() => ({
      values: mock((vals: any) => {
        insertedScheduleValues = vals;
        return {
          returning: mock(() => [{ id: 'sched-1', ...vals }]),
        };
      }),
    }));
  });

  it('creates a mission with schedule containing heartbeat config', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Health Check',
        workspaceId: 'ws-1',
        cronExpression: '0 */6 * * *',
        isHeartbeat: true,
        heartbeatChecklist: '- [ ] Check API latency\n- [ ] Check error rates',
        activeHoursStart: 9,
        activeHoursEnd: 17,
        activeHoursTimezone: 'America/New_York',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    // Mission should NOT have heartbeat fields
    expect(insertedMissionValues).not.toBeNull();
    expect(insertedMissionValues.isHeartbeat).toBeUndefined();
    expect(insertedMissionValues.heartbeatChecklist).toBeUndefined();

    // Schedule template context should have heartbeat config
    expect(insertedScheduleValues).not.toBeNull();
    const ctx = insertedScheduleValues.taskTemplate.context;
    expect(ctx.heartbeat).toBe(true);
    expect(ctx.heartbeatChecklist).toBe('- [ ] Check API latency\n- [ ] Check error rates');
    expect(ctx.activeHoursStart).toBe(9);
    expect(ctx.activeHoursEnd).toBe(17);
    expect(ctx.activeHoursTimezone).toBe('America/New_York');
  });

  it('UI-created mission (session auth, no cron, no isHeartbeat) runs once — no schedule', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Ship auth module' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(insertedMissionValues).not.toBeNull();
    expect(insertedMissionValues.title).toBe('Ship auth module');
    // No schedule created — UI missions run once by default
    expect(insertedScheduleValues).toBeNull();
  });

  it('API-created mission auto-enables heartbeat with defaults (backward compat)', async () => {
    mockGetCurrentUser.mockReturnValue(null as any);
    mockAuthenticateApiKey.mockReturnValue({ id: 'api-1', level: 'admin', teamId: 'team-1' } as any);

    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      headers: { authorization: 'Bearer bld_test' },
      body: JSON.stringify({ title: 'API heartbeat mission' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    // Schedule auto-created with heartbeat defaults
    expect(insertedScheduleValues).not.toBeNull();
    expect(insertedScheduleValues.cronExpression).toBe('*/30 * * * *');
    const ctx = insertedScheduleValues.taskTemplate.context;
    expect(ctx.heartbeat).toBe(true);
    expect(ctx.heartbeatChecklist).toBeDefined();
    expect(ctx.activeHoursStart).toBe(8);
    expect(ctx.activeHoursEnd).toBe(22);
    expect(ctx.activeHoursTimezone).toBe('America/New_York');
  });

  it('UI-created mission with explicit cronExpression creates schedule', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Scheduled UI mission', cronExpression: '0 */6 * * *' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(insertedScheduleValues).not.toBeNull();
    expect(insertedScheduleValues.cronExpression).toBe('0 */6 * * *');
  });

  it('UI-created mission with explicit isHeartbeat: true creates heartbeat schedule', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Heartbeat UI mission', isHeartbeat: true }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(insertedScheduleValues).not.toBeNull();
    const ctx = insertedScheduleValues.taskTemplate.context;
    expect(ctx.heartbeat).toBe(true);
  });

  it('creates mission without heartbeat when explicitly opted out', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'No heartbeat', isHeartbeat: false }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(insertedMissionValues).not.toBeNull();
    // No schedule created
    expect(insertedScheduleValues).toBeNull();
  });

  it('user overrides take precedence over heartbeat defaults', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Custom schedule',
        workspaceId: 'ws-1',
        cronExpression: '0 */6 * * *',
        activeHoursStart: 10,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(insertedScheduleValues).not.toBeNull();
    expect(insertedScheduleValues.cronExpression).toBe('0 */6 * * *');
    const ctx = insertedScheduleValues.taskTemplate.context;
    expect(ctx.heartbeat).toBe(true);
    expect(ctx.activeHoursStart).toBe(10);
    // Other fields get defaults
    expect(ctx.activeHoursEnd).toBe(22);
    expect(ctx.activeHoursTimezone).toBe('America/New_York');
  });

  it('rejects activeHoursStart outside 0-23', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Bad Hours',
        activeHoursStart: 25,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('activeHoursStart');
  });

  it('rejects activeHoursEnd outside 0-23', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Bad Hours',
        activeHoursEnd: -1,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('activeHoursEnd');
  });

  it('accepts activeHoursStart of 0 in schedule context', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Midnight Start',
        workspaceId: 'ws-1',
        cronExpression: '0 * * * *',
        activeHoursStart: 0,
        activeHoursEnd: 23,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const ctx = insertedScheduleValues.taskTemplate.context;
    expect(ctx.activeHoursStart).toBe(0);
    expect(ctx.activeHoursEnd).toBe(23);
  });

  it('should create a scheduled mission without workspaceId', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Workspace-less Mission',
        cronExpression: '0 * * * *',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.scheduleId).toBeDefined();
    expect(insertedScheduleValues).not.toBeNull();
    expect(insertedScheduleValues.workspaceId).toBeNull();
  });

  it('should create a scheduled mission with workspaceId', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Workspace Mission',
        workspaceId: 'ws-1',
        cronExpression: '0 * * * *',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedScheduleValues).not.toBeNull();
    expect(insertedScheduleValues.workspaceId).toBe('ws-1');
  });

  // Auto-start organizer tests
  it('auto-starts the organizer after mission creation', async () => {
    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Auto-start Mission' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    // runMission should have been called with the new mission ID
    expect(mockRunMission).toHaveBeenCalledWith('obj-1', { manualRun: true });

    // Response should include the organizerTask
    const body = await res.json();
    expect(body.organizerTask).toBeDefined();
    expect(body.organizerTask.id).toBe('organizer-task-1');
  });

  it('still succeeds when auto-start organizer fails', async () => {
    mockRunMission.mockRejectedValue(new Error('dispatch failed'));

    const req = new NextRequest('http://localhost/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Resilient Mission' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    const body = await res.json();
    // Mission created, but organizerTask is null
    expect(body.title).toBe('Resilient Mission');
    expect(body.organizerTask).toBeNull();
  });
});
