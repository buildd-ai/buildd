import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => ({ id: 'user-1' }) as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockResolveAccountTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockWorkspacesFindFirst = mock(() => ({ id: 'ws-1', teamId: 'team-1' }) as any);
const mockSelectRows = mock(() => [] as any[]);

// Chainable Drizzle fluent query mock: select().from().innerJoin().innerJoin().where().groupBy()
const mockChain: any = {
  from: () => mockChain,
  innerJoin: () => mockChain,
  where: () => mockChain,
  groupBy: () => Promise.resolve(mockSelectRows()),
};

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ resolveAccountTeamIds: mockResolveAccountTeamIds }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: { workspaces: { findFirst: mockWorkspacesFindFirst } },
    select: () => mockChain,
  },
}));
mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b }),
  and: (...args: any[]) => args,
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values }),
}));
mock.module('@buildd/core/db/schema', () => ({
  workers: {
    completedAt: 'completedAt',
    updatedAt: 'updatedAt',
    inputTokens: 'inputTokens',
    outputTokens: 'outputTokens',
    status: 'status',
    prUrl: 'prUrl',
    taskId: 'taskId',
  },
  tasks: { id: 'id', missionId: 'missionId' },
  missions: { id: 'id', workspaceId: 'workspaceId', initiativeId: 'initiativeId' },
  workspaces: { id: 'id', teamId: 'teamId' },
}));

import { GET } from './route';

describe('GET /api/initiatives/effort', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockSelectRows.mockReset();

    mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockWorkspacesFindFirst.mockReturnValue({ id: 'ws-1', teamId: 'team-1' });
    mockSelectRows.mockReturnValue([]);
  });

  it('returns 400 when workspaceId is missing', async () => {
    const req = new NextRequest('http://localhost/api/initiatives/effort');
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it('returns 404 when workspace belongs to a different team', async () => {
    mockWorkspacesFindFirst.mockReturnValue({ id: 'ws-other', teamId: 'team-other' } as any);
    const req = new NextRequest('http://localhost/api/initiatives/effort?workspaceId=ws-other');
    const res = await GET(req);
    expect(res.status).toBe(404);
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockReturnValue(null as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/initiatives/effort?workspaceId=ws-1');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct shape for authenticated user', async () => {
    mockSelectRows.mockReturnValue([
      {
        initiativeId: 'init-1',
        day: '2026-07-15',
        tokens: '5000',
        merged: '2',
        failed: '1',
        open: '0',
      },
    ]);

    const req = new NextRequest('http://localhost/api/initiatives/effort?workspaceId=ws-1');
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('efforts');
    expect(Array.isArray(body.efforts)).toBe(true);
    expect(body.efforts).toHaveLength(1);

    const effort = body.efforts[0];
    expect(effort.initiativeId).toBe('init-1');
    expect(Array.isArray(effort.days)).toBe(true);
    expect(effort.days).toHaveLength(1);
    expect(effort.days[0]).toMatchObject({
      date: '2026-07-15',
      tokens: 5000,
      merged: 2,
      failed: 1,
      open: 0,
    });
  });

  it('groups rows by initiativeId and maps null to "unassigned"', async () => {
    mockSelectRows.mockReturnValue([
      { initiativeId: 'init-1', day: '2026-07-14', tokens: '100', merged: '1', failed: '0', open: '0' },
      { initiativeId: 'init-1', day: '2026-07-15', tokens: '200', merged: '0', failed: '0', open: '1' },
      { initiativeId: null, day: '2026-07-15', tokens: '75', merged: '0', failed: '0', open: '1' },
    ]);

    const req = new NextRequest('http://localhost/api/initiatives/effort?workspaceId=ws-1');
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.efforts).toHaveLength(2);

    const init1 = body.efforts.find((e: any) => e.initiativeId === 'init-1');
    expect(init1.days).toHaveLength(2);

    const unassigned = body.efforts.find((e: any) => e.initiativeId === 'unassigned');
    expect(unassigned).toBeDefined();
    expect(unassigned.days[0].tokens).toBe(75);
  });
});
