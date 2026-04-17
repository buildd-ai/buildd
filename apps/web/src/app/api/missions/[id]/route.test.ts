import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => ({ id: 'user-1' }) as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1']));
const mockResolveAccountTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockMissionsFindFirst = mock(() => ({
  id: 'obj-1',
  teamId: 'team-1',
  title: 'Existing Mission',
  workspaceId: 'ws-1',
  scheduleId: null,
  priority: 0,
}) as any);
let updatedSetData: any = null;
const mockMissionsUpdate = mock(() => ({
  set: mock((data: any) => {
    updatedSetData = data;
    return {
      where: mock(() => ({
        returning: mock(() => [{ id: 'obj-1', ...data }]),
      })),
    };
  }),
}));

let insertedScheduleValues: any = null;
let updatedScheduleData: any = null;
const mockScheduleFindFirst = mock(() => null as any);
const mockScheduleUpdate = mock(() => ({
  set: mock((data: any) => {
    updatedScheduleData = data;
    return { where: mock(() => ({})) };
  }),
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
  resolveAccountTeamIds: mockResolveAccountTeamIds,
}));

mock.module('@/lib/schedule-helpers', () => ({
  computeNextRunAt: () => new Date('2026-01-01'),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst },
      taskSchedules: { findFirst: mockScheduleFindFirst },
      workspaces: { findFirst: mock(() => ({ id: 'ws-1' })) },
    },
    update: (table: any) => {
      if (table === 'taskSchedules') return mockScheduleUpdate();
      return mockMissionsUpdate();
    },
    insert: () => ({
      values: mock((vals: any) => {
        insertedScheduleValues = vals;
        return {
          returning: mock(() => [{ id: 'sched-new', ...vals }]),
        };
      }),
    }),
    delete: () => ({
      where: mock(() => ({})),
    }),
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
  tasks: 'tasks',
  taskSchedules: 'taskSchedules',
  workspaces: { id: 'id', teamId: 'teamId' },
}));

import { PATCH } from './route';

const makeParams = (id: string) => Promise.resolve({ id });

describe('PATCH /api/missions/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockReset();
    mockMissionsUpdate.mockReset();
    mockScheduleFindFirst.mockReset();
    mockScheduleUpdate.mockReset();
    updatedSetData = null;
    insertedScheduleValues = null;
    updatedScheduleData = null;

    mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockReturnValue({
      id: 'obj-1',
      teamId: 'team-1',
      title: 'Existing Mission',
      workspaceId: 'ws-1',
      scheduleId: null,
      priority: 0,
    });
    mockMissionsUpdate.mockImplementation(() => ({
      set: mock((data: any) => {
        updatedSetData = data;
        return {
          where: mock(() => ({
            returning: mock(() => [{ id: 'obj-1', ...data }]),
          })),
        };
      }),
    }));
    mockScheduleUpdate.mockImplementation(() => ({
      set: mock((data: any) => {
        updatedScheduleData = data;
        return { where: mock(() => ({})) };
      }),
    }));
  });

  it('stores heartbeat config in schedule template context', async () => {
    // Mission with existing schedule
    mockMissionsFindFirst.mockReturnValue({
      id: 'obj-1',
      teamId: 'team-1',
      title: 'Health Check',
      workspaceId: 'ws-1',
      scheduleId: 'sched-1',
      priority: 0,
    });
    mockScheduleFindFirst.mockReturnValue({
      cronExpression: '0 */6 * * *',
      taskTemplate: { context: {} },
    });

    const req = new NextRequest('http://localhost/api/missions/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({
        isHeartbeat: true,
        heartbeatChecklist: '- [ ] Check DB connections\n- [ ] Check queue depth',
      }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(200);

    expect(updatedScheduleData).not.toBeNull();
    const ctx = updatedScheduleData.taskTemplate.context;
    expect(ctx.heartbeat).toBe(true);
    expect(ctx.heartbeatChecklist).toBe('- [ ] Check DB connections\n- [ ] Check queue depth');
  });

  it('stores active hours in schedule template context', async () => {
    mockMissionsFindFirst.mockReturnValue({
      id: 'obj-1',
      teamId: 'team-1',
      title: 'Monitor',
      workspaceId: 'ws-1',
      scheduleId: 'sched-1',
      priority: 0,
    });
    mockScheduleFindFirst.mockReturnValue({
      cronExpression: '0 * * * *',
      taskTemplate: { context: {} },
    });

    const req = new NextRequest('http://localhost/api/missions/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({
        activeHoursStart: 8,
        activeHoursEnd: 20,
        activeHoursTimezone: 'Europe/London',
      }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(200);

    const ctx = updatedScheduleData.taskTemplate.context;
    expect(ctx.activeHoursStart).toBe(8);
    expect(ctx.activeHoursEnd).toBe(20);
    expect(ctx.activeHoursTimezone).toBe('Europe/London');
  });

  it('creates new schedule when adding cron to mission', async () => {
    const req = new NextRequest('http://localhost/api/missions/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({
        cronExpression: '0 9 * * *',
        isHeartbeat: true,
      }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(200);

    expect(insertedScheduleValues).not.toBeNull();
    expect(insertedScheduleValues.cronExpression).toBe('0 9 * * *');
    expect(insertedScheduleValues.taskTemplate.context.heartbeat).toBe(true);
    // Schedule ID should be set on the objective
    expect(updatedSetData.scheduleId).toBe('sched-new');
  });

  it('rejects activeHoursStart outside 0-23', async () => {
    const req = new NextRequest('http://localhost/api/missions/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ activeHoursStart: 24 }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('activeHoursStart');
  });

  it('rejects activeHoursEnd outside 0-23', async () => {
    const req = new NextRequest('http://localhost/api/missions/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ activeHoursEnd: -5 }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('activeHoursEnd');
  });

  it('updates workspaceId', async () => {
    const req = new NextRequest('http://localhost/api/missions/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ workspaceId: 'ws-new' }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(200);

    expect(updatedSetData).not.toBeNull();
    expect(updatedSetData.workspaceId).toBe('ws-new');
  });

  it('clears workspaceId with null', async () => {
    const req = new NextRequest('http://localhost/api/missions/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ workspaceId: null }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(200);

    expect(updatedSetData).not.toBeNull();
    expect(updatedSetData.workspaceId).toBeNull();
  });

  it('updates status to completed', async () => {
    const req = new NextRequest('http://localhost/api/missions/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(200);

    expect(updatedSetData.status).toBe('completed');
  });

  it('updates status to archived', async () => {
    const req = new NextRequest('http://localhost/api/missions/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'archived' }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(200);

    expect(updatedSetData.status).toBe('archived');
  });

  it('updates maxConcurrentTasks', async () => {
    const req = new NextRequest('http://localhost/api/missions/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ maxConcurrentTasks: 5 }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(200);
    expect(updatedSetData.maxConcurrentTasks).toBe(5);
  });

  it('clears maxConcurrentTasks with null', async () => {
    const req = new NextRequest('http://localhost/api/missions/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ maxConcurrentTasks: null }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(200);
    expect(updatedSetData.maxConcurrentTasks).toBeNull();
  });

  it('rejects maxConcurrentTasks < 1', async () => {
    const req = new NextRequest('http://localhost/api/missions/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ maxConcurrentTasks: 0 }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('maxConcurrentTasks');
  });

  it('rejects non-integer maxConcurrentTasks', async () => {
    const req = new NextRequest('http://localhost/api/missions/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ maxConcurrentTasks: 1.5 }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('maxConcurrentTasks');
  });

  it('rejects invalid status', async () => {
    const req = new NextRequest('http://localhost/api/missions/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'invalid' }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid status');
  });
});
