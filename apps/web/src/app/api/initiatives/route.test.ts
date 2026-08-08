import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => ({ id: 'user-1' }) as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1']));
const mockResolveAccountTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockInitiativesFindMany = mock(() => [] as any[]);
const mockLinearLinkRows = mock(() => [] as Array<{ entityId: string }>);
const mockWorkspacesFindFirst = mock(() => ({ id: 'ws-1', teamId: 'team-1' }) as any);
let insertedInitiativeValues: any = null;
const mockInitiativesInsert = mock(() => ({
  values: mock((vals: any) => {
    insertedInitiativeValues = vals;
    return { returning: mock(() => [{ id: 'init-1', ...vals }]) };
  }),
}));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
  hashApiKey: (key: string) => `hashed_${key}`,
  extractApiKeyPrefix: (key: string) => key.substring(0, 12),
}));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  resolveAccountTeamIds: mockResolveAccountTeamIds,
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      initiatives: { findMany: mockInitiativesFindMany },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    insert: () => mockInitiativesInsert(),
    // Batched Linear-link existence query (db.select(...).from(...).where(...)).
    select: () => ({ from: () => ({ where: () => Promise.resolve(mockLinearLinkRows()) }) }),
  },
}));
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => args,
  desc: (field: any) => ({ field, type: 'desc' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));
mock.module('@buildd/core/db/schema', () => ({
  initiatives: { teamId: 'teamId', workspaceId: 'workspaceId', status: 'status', priority: 'priority', createdAt: 'createdAt' },
  workspaces: { id: 'id', teamId: 'teamId' },
  externalLinks: { provider: 'provider', builddEntityType: 'builddEntityType', builddEntityId: 'builddEntityId' },
}));

import { GET, POST } from './route';

describe('POST /api/initiatives', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockGetUserTeamIds.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockInitiativesInsert.mockReset();
    mockWorkspacesFindFirst.mockReset();
    insertedInitiativeValues = null;

    mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockWorkspacesFindFirst.mockReturnValue({ id: 'ws-1', teamId: 'team-1', accessMode: 'team' });
    mockInitiativesInsert.mockImplementation(() => ({
      values: mock((vals: any) => {
        insertedInitiativeValues = vals;
        return { returning: mock(() => [{ id: 'init-1', ...vals }]) };
      }),
    }));
  });

  it('creates an initiative with defaults', async () => {
    const req = new NextRequest('http://localhost/api/initiatives', {
      method: 'POST',
      body: JSON.stringify({ title: 'Q3 Platform Hardening' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedInitiativeValues).not.toBeNull();
    expect(insertedInitiativeValues.title).toBe('Q3 Platform Hardening');
    expect(insertedInitiativeValues.status).toBe('active');
    expect(insertedInitiativeValues.priority).toBe(0);
    expect(insertedInitiativeValues.teamId).toBe('team-1');
    // No orchestration columns — an initiative is execution-free.
    expect(insertedInitiativeValues.orchestrationMode).toBeUndefined();
    expect(insertedInitiativeValues.scheduleId).toBeUndefined();
    expect(insertedInitiativeValues.costBudgetUsd).toBeUndefined();
  });

  it('rejects a missing title', async () => {
    const req = new NextRequest('http://localhost/api/initiatives', {
      method: 'POST',
      body: JSON.stringify({ description: 'no title' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('title');
  });

  it('rejects an invalid status', async () => {
    const req = new NextRequest('http://localhost/api/initiatives', {
      method: 'POST',
      body: JSON.stringify({ title: 'X', status: 'in_progress' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('status');
  });

  it('derives team from workspace when workspaceId provided', async () => {
    mockWorkspacesFindFirst.mockReturnValue({ id: 'ws-1', teamId: 'team-1', accessMode: 'team' });
    const req = new NextRequest('http://localhost/api/initiatives', {
      method: 'POST',
      body: JSON.stringify({ title: 'Scoped', workspaceId: 'ws-1' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedInitiativeValues.workspaceId).toBe('ws-1');
    expect(insertedInitiativeValues.teamId).toBe('team-1');
  });

  it('401 when unauthenticated', async () => {
    mockGetCurrentUser.mockReturnValue(null as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/initiatives', {
      method: 'POST',
      body: JSON.stringify({ title: 'X' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('403 for non-admin API key', async () => {
    mockGetCurrentUser.mockReturnValue(null as any);
    mockAuthenticateApiKey.mockReturnValue({ id: 'api-1', level: 'worker', teamId: 'team-1' } as any);
    const req = new NextRequest('http://localhost/api/initiatives', {
      method: 'POST',
      headers: { authorization: 'Bearer bld_test' },
      body: JSON.stringify({ title: 'X' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/initiatives', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockInitiativesFindMany.mockReset();
    mockLinearLinkRows.mockReset();

    mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockInitiativesFindMany.mockResolvedValue([]);
    mockLinearLinkRows.mockReturnValue([]);
  });

  it('rolls up child mission progress (task-weighted) into the initiative', async () => {
    mockInitiativesFindMany.mockResolvedValue([
      {
        id: 'init-1',
        title: 'Platform',
        status: 'active',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        missions: [
          { id: 'm-1', title: 'A', status: 'active', tasks: [{ id: 't1', status: 'completed' }, { id: 't2', status: 'pending' }] },
          { id: 'm-2', title: 'B', status: 'completed', tasks: [{ id: 't3', status: 'completed' }, { id: 't4', status: 'completed' }] },
        ],
      },
    ]);
    const req = new NextRequest('http://localhost/api/initiatives');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.initiatives).toHaveLength(1);
    const init = body.initiatives[0];
    // 3 of 4 tasks completed → 75%
    expect(init.progress.totalTasks).toBe(4);
    expect(init.progress.completedTasks).toBe(3);
    expect(init.progress.progress).toBe(75);
    expect(init.progress.status).toBe('active');
    // Heavy task arrays stripped; light mission index retained
    expect(init.missions).toHaveLength(2);
    expect(init.missions[0].tasks).toBeUndefined();
    // Aggregate segments computed from the (already-loaded) tasks — one per task.
    expect(init.segments).toHaveLength(4);
    expect(init.segments.filter((s: any) => s.state === 'solid')).toHaveLength(3);
    // No linear links and no updatedAt in the fixture → false / null.
    expect(init.hasLinearLink).toBe(false);
    expect(init.lastMotionAt).toBeNull();
  });

  it('sets hasLinearLink when a child mission is linked to Linear', async () => {
    mockInitiativesFindMany.mockResolvedValue([
      { id: 'init-1', title: 'Linked', status: 'active', createdAt: new Date('2026-01-01T00:00:00.000Z'), missions: [{ id: 'm-1', title: 'A', status: 'active', tasks: [] }] },
      { id: 'init-2', title: 'Unlinked', status: 'active', createdAt: new Date('2026-01-01T00:00:00.000Z'), missions: [{ id: 'm-2', title: 'B', status: 'active', tasks: [] }] },
    ]);
    mockLinearLinkRows.mockReturnValue([{ entityId: 'm-1' }]);
    const res = await GET(new NextRequest('http://localhost/api/initiatives'));
    const body = await res.json();
    expect(body.initiatives.find((i: any) => i.id === 'init-1').hasLinearLink).toBe(true);
    expect(body.initiatives.find((i: any) => i.id === 'init-2').hasLinearLink).toBe(false);
  });

  it('derives lastMotionAt from the most recent child mission update', async () => {
    mockInitiativesFindMany.mockResolvedValue([
      {
        id: 'init-1', title: 'Motion', status: 'active', createdAt: new Date('2026-01-01T00:00:00.000Z'),
        missions: [
          { id: 'm-1', title: 'A', status: 'active', updatedAt: '2026-07-20T10:00:00.000Z', tasks: [] },
          { id: 'm-2', title: 'B', status: 'active', updatedAt: '2026-07-26T09:30:00.000Z', tasks: [] },
        ],
      },
    ]);
    const res = await GET(new NextRequest('http://localhost/api/initiatives'));
    const body = await res.json();
    expect(body.initiatives[0].lastMotionAt).toBe('2026-07-26T09:30:00.000Z');
  });

  it('returns empty list when teamId is a foreign team (no leak)', async () => {
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    const req = new NextRequest('http://localhost/api/initiatives?teamId=team-other');
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect((await res.json()).initiatives).toEqual([]);
    expect(mockInitiativesFindMany).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    mockGetCurrentUser.mockReturnValue(null as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    const res = await GET(new NextRequest('http://localhost/api/initiatives'));
    expect(res.status).toBe(401);
  });
});
