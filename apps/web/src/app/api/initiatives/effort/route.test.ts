import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => ({ id: 'user-1' }) as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockResolveAccountTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockWorkspacesFindFirst = mock(async () => ({ id: 'ws-1', teamId: 'team-1' }) as any);
const mockSelectResult = mock(() => [] as any[]);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
  hashApiKey: (k: string) => `hashed_${k}`,
  extractApiKeyPrefix: (k: string) => k.substring(0, 12),
}));
mock.module('@/lib/team-access', () => ({
  resolveAccountTeamIds: mockResolveAccountTeamIds,
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: (...a: any[]) => mockWorkspacesFindFirst(...(a as [])) },
    },
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              groupBy: () => Promise.resolve(mockSelectResult()),
            }),
          }),
        }),
      }),
    }),
  },
}));
mock.module('drizzle-orm', () => ({
  eq: () => ({}),
  and: () => ({}),
  sql: (strings: any, ...values: any[]) => ({ __sql: true, strings, values }),
}));
mock.module('@buildd/core/db/schema', () => ({
  workers: {
    taskId: 'task_id',
    workspaceId: 'workspace_id',
    status: 'status',
    prUrl: 'pr_url',
    inputTokens: 'input_tokens',
    outputTokens: 'output_tokens',
    completedAt: 'completed_at',
    updatedAt: 'updated_at',
  },
  tasks: { id: 'id', missionId: 'mission_id' },
  missions: { id: 'id', workspaceId: 'workspace_id', initiativeId: 'initiative_id' },
  workspaces: { id: 'id', teamId: 'team_id' },
}));

import { GET } from './route';

const makeRequest = (params: Record<string, string> = {}, authenticated = true) => {
  const url = new URL('http://localhost/api/initiatives/effort');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (authenticated) headers.cookie = 'session=test';
  return new NextRequest(url.toString(), { headers });
};

describe('GET /api/initiatives/effort', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockSelectResult.mockReset();

    mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
    mockSelectResult.mockReturnValue([]);
  });

  it('401 without auth', async () => {
    mockGetCurrentUser.mockReturnValue(null as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    const res = await GET(makeRequest({ workspaceId: 'ws-1' }, false));
    expect(res.status).toBe(401);
  });

  it('400 when workspaceId is missing', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
  });

  it('404 when workspace belongs to another team', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-other', teamId: 'team-other' });
    const res = await GET(makeRequest({ workspaceId: 'ws-other' }));
    expect(res.status).toBe(404);
  });

  it('200 with valid cookie — empty efforts for no activity', async () => {
    const res = await GET(makeRequest({ workspaceId: 'ws-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('efforts');
    expect(Array.isArray(body.efforts)).toBe(true);
    expect(body.efforts).toHaveLength(0);
  });

  it('200 correct shape — groups by initiativeId, maps null to unassigned', async () => {
    mockSelectResult.mockReturnValue([
      { initiativeId: 'init-1', day: '2026-08-01', tokens: '1000', merged: '1', failed: '0', open: '2' },
      { initiativeId: 'init-1', day: '2026-08-02', tokens: '500', merged: '0', failed: '1', open: '0' },
      { initiativeId: null, day: '2026-08-01', tokens: '200', merged: '0', failed: '0', open: '1' },
    ]);
    const res = await GET(makeRequest({ workspaceId: 'ws-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.efforts).toHaveLength(2);

    const init1 = body.efforts.find((e: any) => e.initiativeId === 'init-1');
    expect(init1).toBeDefined();
    expect(init1.days).toHaveLength(2);
    expect(init1.days[0]).toEqual({ date: '2026-08-01', tokens: 1000, merged: 1, failed: 0, open: 2 });
    expect(init1.days[1]).toEqual({ date: '2026-08-02', tokens: 500, merged: 0, failed: 1, open: 0 });

    const unassigned = body.efforts.find((e: any) => e.initiativeId === 'unassigned');
    expect(unassigned).toBeDefined();
    expect(unassigned.days).toHaveLength(1);
    expect(unassigned.days[0]).toEqual({ date: '2026-08-01', tokens: 200, merged: 0, failed: 0, open: 1 });
  });
});
