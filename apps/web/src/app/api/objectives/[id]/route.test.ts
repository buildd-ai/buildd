import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => ({ id: 'user-1' }) as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1']));
const mockObjectivesFindFirst = mock(() => ({
  id: 'obj-1',
  teamId: 'team-1',
  title: 'Existing Objective',
  workspaceId: 'ws-1',
  cronExpression: null,
  scheduleId: null,
  priority: 0,
  isHeartbeat: false,
}) as any);
let updatedSetData: any = null;
const mockObjectivesUpdate = mock(() => ({
  set: mock((data: any) => {
    updatedSetData = data;
    return {
      where: mock(() => ({
        returning: mock(() => [{ id: 'obj-1', ...data }]),
      })),
    };
  }),
}));
const mockObjectivesFindFirstForGet = mock(() => null as any);

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

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      objectives: { findFirst: mockObjectivesFindFirst },
      taskSchedules: { findFirst: mock(() => null) },
      workspaces: { findFirst: mock(() => ({ id: 'ws-1' })) },
    },
    update: () => mockObjectivesUpdate(),
    insert: () => ({
      values: mock((vals: any) => ({
        returning: mock(() => [{ id: 'sched-1', ...vals }]),
      })),
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
  objectives: 'objectives',
  tasks: 'tasks',
  taskSchedules: 'taskSchedules',
  workspaces: { id: 'id', teamId: 'teamId' },
}));

import { PATCH } from './route';

const makeParams = (id: string) => Promise.resolve({ id });

describe('PATCH /api/objectives/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockObjectivesFindFirst.mockReset();
    mockObjectivesUpdate.mockReset();
    updatedSetData = null;

    mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockObjectivesFindFirst.mockReturnValue({
      id: 'obj-1',
      teamId: 'team-1',
      title: 'Existing Objective',
      workspaceId: 'ws-1',
      cronExpression: null,
      scheduleId: null,
      priority: 0,
      isHeartbeat: false,
    });
    mockObjectivesUpdate.mockImplementation(() => ({
      set: mock((data: any) => {
        updatedSetData = data;
        return {
          where: mock(() => ({
            returning: mock(() => [{ id: 'obj-1', ...data }]),
          })),
        };
      }),
    }));
  });

  it('updates heartbeat checklist', async () => {
    const req = new NextRequest('http://localhost/api/objectives/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({
        heartbeatChecklist: '- [ ] Check DB connections\n- [ ] Check queue depth',
      }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(200);

    expect(updatedSetData).not.toBeNull();
    expect(updatedSetData.heartbeatChecklist).toBe('- [ ] Check DB connections\n- [ ] Check queue depth');
  });

  it('updates isHeartbeat flag', async () => {
    const req = new NextRequest('http://localhost/api/objectives/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ isHeartbeat: true }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(200);

    expect(updatedSetData).not.toBeNull();
    expect(updatedSetData.isHeartbeat).toBe(true);
  });

  it('updates active hours', async () => {
    const req = new NextRequest('http://localhost/api/objectives/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({
        activeHoursStart: 8,
        activeHoursEnd: 20,
        activeHoursTimezone: 'Europe/London',
      }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(200);

    expect(updatedSetData.activeHoursStart).toBe(8);
    expect(updatedSetData.activeHoursEnd).toBe(20);
    expect(updatedSetData.activeHoursTimezone).toBe('Europe/London');
  });

  it('rejects activeHoursStart outside 0-23', async () => {
    const req = new NextRequest('http://localhost/api/objectives/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ activeHoursStart: 24 }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('activeHoursStart');
  });

  it('rejects activeHoursEnd outside 0-23', async () => {
    const req = new NextRequest('http://localhost/api/objectives/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ activeHoursEnd: -5 }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('activeHoursEnd');
  });

  it('updates workspaceId', async () => {
    const req = new NextRequest('http://localhost/api/objectives/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ workspaceId: 'ws-new' }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(200);

    expect(updatedSetData).not.toBeNull();
    expect(updatedSetData.workspaceId).toBe('ws-new');
  });

  it('clears workspaceId with null', async () => {
    const req = new NextRequest('http://localhost/api/objectives/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ workspaceId: null }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(200);

    expect(updatedSetData).not.toBeNull();
    expect(updatedSetData.workspaceId).toBeNull();
  });

  it('updates status to completed', async () => {
    const req = new NextRequest('http://localhost/api/objectives/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(200);

    expect(updatedSetData).not.toBeNull();
    expect(updatedSetData.status).toBe('completed');
  });

  it('updates status to archived', async () => {
    const req = new NextRequest('http://localhost/api/objectives/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'archived' }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(200);

    expect(updatedSetData).not.toBeNull();
    expect(updatedSetData.status).toBe('archived');
  });

  it('rejects invalid status', async () => {
    const req = new NextRequest('http://localhost/api/objectives/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'invalid' }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid status');
  });

  it('clears active hours with null', async () => {
    const req = new NextRequest('http://localhost/api/objectives/obj-1', {
      method: 'PATCH',
      body: JSON.stringify({
        activeHoursStart: null,
        activeHoursEnd: null,
        activeHoursTimezone: null,
      }),
    });

    const res = await PATCH(req, { params: makeParams('obj-1') });
    expect(res.status).toBe(200);

    expect(updatedSetData.activeHoursStart).toBeNull();
    expect(updatedSetData.activeHoursEnd).toBeNull();
    expect(updatedSetData.activeHoursTimezone).toBeNull();
  });
});
