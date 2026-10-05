import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuthenticateApiKey = mock(async (_k: string | null, _r?: unknown) => null as any);
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));

const mockGetCurrentUser = mock(async () => null as any);
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));

const REPORT = { healthy: true, verdict: 'Healthy: no wakes delivered in 24h.', problems: [] };
const mockGetDispatchHealth = mock(async (_ids: readonly string[]) => REPORT as any);
mock.module('@/lib/dispatch-health', () => ({ getDispatchHealth: mockGetDispatchHealth }));

const mockFindFirst = mock(async (_q?: unknown) => null as any);
const mockFindMany = mock(async (_q?: unknown) => [] as any[]);
mock.module('@buildd/core/db', () => ({
  db: { query: { workspaces: { findFirst: mockFindFirst, findMany: mockFindMany } } },
}));
mock.module('@buildd/core/db/schema', () => ({ workspaces: { id: 'id', teamId: 'teamId' }, accounts: { id: 'id' } }));
mock.module('drizzle-orm', () => ({ eq: (field: unknown, value: unknown) => ({ field, value, type: 'eq' }) }));

const mockResolveSessionTeamIds = mock(async (_u: string, _pin: string | null) => null as string[] | null);
const mockWorkspaceIdsForTeams = mock(async (_t: string[]) => [] as string[]);
mock.module('@/lib/session-team-scope', () => ({
  resolveSessionTeamIds: mockResolveSessionTeamIds,
  workspaceIdsForTeams: mockWorkspaceIdsForTeams,
}));

const { GET } = await import('./route');

const TEAM = 'team-a';
const WS_1 = '11111111-1111-4111-8111-111111111111';
const WS_2 = '22222222-2222-4222-8222-222222222222';
const OTHER = '99999999-9999-4999-8999-999999999999';
const call = (qs = '', auth = 'Bearer bld_x') =>
  GET(new NextRequest(`http://localhost/api/health/dispatch${qs}`, { headers: auth ? { authorization: auth } : {} }));

beforeEach(() => {
  for (const m of [mockAuthenticateApiKey, mockGetCurrentUser, mockGetDispatchHealth, mockFindFirst, mockFindMany, mockResolveSessionTeamIds, mockWorkspaceIdsForTeams]) m.mockClear();
  mockAuthenticateApiKey.mockImplementation(async () => ({ id: 'acct', teamId: TEAM, level: 'worker' }));
  mockGetCurrentUser.mockImplementation(async () => null);
  mockFindMany.mockImplementation(async () => [{ id: WS_1 }, { id: WS_2 }]);
  mockFindFirst.mockImplementation(async () => null);
});

describe('GET /api/health/dispatch', () => {
  it('401 with neither a key nor a session', async () => {
    mockAuthenticateApiKey.mockImplementation(async () => null);
    expect((await call('', '')).status).toBe(401);
    expect(mockGetDispatchHealth).not.toHaveBeenCalled();
  });

  it('an API key reads its own team\'s workspaces only', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REPORT);
    expect(mockFindMany.mock.calls[0][0]).toMatchObject({ where: { field: 'teamId', value: TEAM } });
    expect(mockGetDispatchHealth).toHaveBeenCalledWith([WS_1, WS_2]);
  });

  it('workspaceId narrows to one workspace of the team; another team\'s is 404, not "exists"', async () => {
    mockFindFirst.mockImplementation(async () => ({ id: WS_1, teamId: TEAM }));
    await call(`?workspaceId=${WS_1}`);
    expect(mockGetDispatchHealth).toHaveBeenCalledWith([WS_1]);

    mockFindFirst.mockImplementation(async () => ({ id: OTHER, teamId: 'team-b' }));
    const res = await call(`?workspaceId=${OTHER}`);
    expect(res.status).toBe(404);
    expect(mockGetDispatchHealth).toHaveBeenCalledTimes(1);
  });

  it('a non-UUID workspaceId is a 400', async () => {
    expect((await call('?workspaceId=my-repo')).status).toBe(400);
  });

  it('a key with no team is a 400', async () => {
    mockAuthenticateApiKey.mockImplementation(async () => ({ id: 'acct', teamId: null, level: 'worker' }));
    expect((await call()).status).toBe(400);
  });

  it('a session reads the user\'s teams (or the pinned one)', async () => {
    mockAuthenticateApiKey.mockImplementation(async () => null);
    mockGetCurrentUser.mockImplementation(async () => ({ id: 'user-1' }));
    mockResolveSessionTeamIds.mockImplementation(async () => [TEAM]);
    mockWorkspaceIdsForTeams.mockImplementation(async () => [WS_2]);
    await call('?teamId=team-a', '');
    expect(mockResolveSessionTeamIds).toHaveBeenCalledWith('user-1', 'team-a');
    expect(mockGetDispatchHealth).toHaveBeenCalledWith([WS_2]);

    mockResolveSessionTeamIds.mockImplementation(async () => null);
    expect((await call('?teamId=team-z', '')).status).toBe(404);
  });

  it('a read failure is a 500 with no detail', async () => {
    mockGetDispatchHealth.mockImplementationOnce(async () => { throw new Error('connection refused at 10.0.0.1'); });
    const res = await call();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('10.0.0.1');
  });
});

describe('GET /api/health/dispatch — per-task token', () => {
  const scoped = { id: 'acct', teamId: TEAM, level: 'worker', taskScope: { taskId: 't-1', workspaceId: WS_1, expiresAt: Date.now() + 60_000 } };
  beforeEach(() => mockAuthenticateApiKey.mockImplementation(async () => scoped));

  it('narrows a team-wide read to its own workspace', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(mockGetDispatchHealth).toHaveBeenCalledWith([WS_1]);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('404s another workspace of its team, before reading health', async () => {
    mockFindFirst.mockImplementation(async () => ({ id: WS_2, teamId: TEAM }));
    const res = await call(`?workspaceId=${WS_2}`);
    expect(res.status).toBe(404);
    expect(mockGetDispatchHealth).not.toHaveBeenCalled();
  });

  it('reads its own workspace when named', async () => {
    mockFindFirst.mockImplementation(async () => ({ id: WS_1, teamId: TEAM }));
    const res = await call(`?workspaceId=${WS_1}`);
    expect(res.status).toBe(200);
    expect(mockGetDispatchHealth).toHaveBeenCalledWith([WS_1]);
  });
});
