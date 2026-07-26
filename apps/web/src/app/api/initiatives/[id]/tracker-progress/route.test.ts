import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Auth / db mocks ONLY (their global mock.module leak is benign — each consumer
// re-mocks them). We do NOT mock '@buildd/core/external-links' or
// '@/lib/work-tracker': those stubs leak and would corrupt the Phase 1 link route
// + core external-links tests, which need the REAL parseLinearUrl/linkExternal.
// Aggregation LOGIC is tested by calling the exported `initiativeTrackerProgress`
// core directly with injected deps + a fake db.

const mockGetCurrentUser = mock(() => ({ id: 'user-1' }) as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockResolveAccountTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockInitiativesFindFirst = mock(async () => ({ id: 'init-1', teamId: 'team-1', workspaceId: null }) as any);
const mockWorkspacesFindFirst = mock(async () => ({ accessMode: 'team' }) as any);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
  hashApiKey: (k: string) => `hashed_${k}`,
  extractApiKeyPrefix: (k: string) => k.substring(0, 12),
}));
mock.module('@/lib/team-access', () => ({
  resolveAccountTeamIds: mockResolveAccountTeamIds,
  getUserTeamIds: mockResolveAccountTeamIds,
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      initiatives: { findFirst: (...a: any[]) => mockInitiativesFindFirst(...(a as [])) },
      // A real getLinksForEntity default runs in the handler's core call; with an
      // empty fake missions loader (no child missions) it is never reached.
      missions: { findMany: async () => [] },
      workspaces: { findFirst: (...a: any[]) => mockWorkspacesFindFirst(...(a as [])) },
    },
  },
}));

import { GET, initiativeTrackerProgress } from './route';

const call = (opts?: { auth?: string }) => {
  const headers: Record<string, string> = {};
  if (opts?.auth) headers.authorization = opts.auth;
  const req = new NextRequest('http://localhost/api/initiatives/init-1/tracker-progress', { headers });
  return GET(req, { params: Promise.resolve({ id: 'init-1' }) });
};

const fakeDb = {} as any;
const parseProject = (() => ({ type: 'project', externalId: 'x' })) as any;

describe('GET /api/initiatives/[id]/tracker-progress — auth + 404 (handler)', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockInitiativesFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();

    mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockInitiativesFindFirst.mockResolvedValue({ id: 'init-1', teamId: 'team-1', workspaceId: null });
    mockWorkspacesFindFirst.mockResolvedValue({ accessMode: 'team' });
  });

  it('401 when unauthenticated', async () => {
    mockGetCurrentUser.mockReturnValue(null as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    expect((await call()).status).toBe(401);
  });

  it('404 when the initiative is not found / inaccessible', async () => {
    mockInitiativesFindFirst.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });

  it('404 when the initiative belongs to another team', async () => {
    mockInitiativesFindFirst.mockResolvedValue({ id: 'init-1', teamId: 'team-other', workspaceId: null });
    expect((await call()).status).toBe(404);
  });

  it('200 with linked:false when the initiative has no child missions', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ linked: false, provider: null, items: [] });
    expect(typeof body.fetchedAt).toBe('string');
  });
});

describe('initiativeTrackerProgress — aggregation logic (DI)', () => {
  it('linked:false when no child mission has a linear link (fetch never called)', async () => {
    const getChildMissions = mock(async () => [
      { id: 'm-1', title: 'A', teamId: 'team-1', workspaceId: 'ws-1' },
      { id: 'm-2', title: 'B', teamId: 'team-1', workspaceId: 'ws-1' },
    ] as any);
    const getLinks = mock(async () => [] as any);
    const getConnectorId = mock(async () => 'conn-1' as any);
    const fetchProgress = mock(async () => null as any);
    const res = await initiativeTrackerProgress(
      fakeDb,
      { initiativeId: 'init-1' },
      { getChildMissions, getLinks, getConnectorId, fetchProgress, parseUrl: parseProject },
    );
    expect(res).toMatchObject({ linked: false, provider: null, items: [] });
    expect(typeof res.fetchedAt).toBe('string');
    expect(fetchProgress).not.toHaveBeenCalled();
  });

  it('two linked children → two items, titled by the child mission; connector lookup cached', async () => {
    const getChildMissions = mock(async () => [
      { id: 'm-1', title: 'Alpha', teamId: 'team-1', workspaceId: 'ws-1' },
      { id: 'm-2', title: 'Beta', teamId: 'team-1', workspaceId: 'ws-1' },
      { id: 'm-3', title: 'Gamma-unlinked', teamId: 'team-1', workspaceId: 'ws-1' },
    ] as any);
    const linksByMission: Record<string, any[]> = {
      'm-1': [{ provider: 'linear', externalId: 'proj-1', externalUrl: 'https://linear.app/a/project/proj-1' }],
      'm-2': [{ provider: 'linear', externalId: 'proj-2', externalUrl: 'https://linear.app/a/project/proj-2' }],
    };
    const getLinks = mock(async (_db: any, _type: string, entityId: string) => linksByMission[entityId] ?? []);
    const getConnectorId = mock(async () => 'conn-1' as any);
    const fetchProgress = mock(async () => null as any)
      .mockResolvedValueOnce({ title: 'Linear Name 1', percent: 25, state: 'started' } as any)
      .mockResolvedValueOnce({ title: 'Linear Name 2', percent: 80, state: 'completed' } as any);

    const res = await initiativeTrackerProgress(
      fakeDb,
      { initiativeId: 'init-1' },
      { getChildMissions, getLinks, getConnectorId, fetchProgress, parseUrl: parseProject },
    );
    expect(res.linked).toBe(true);
    expect(res.provider).toBe('linear');
    expect(res.items).toHaveLength(2);
    // title comes from the buildd mission, not the Linear project name
    expect(res.items[0]).toEqual({
      kind: 'project',
      externalId: 'proj-1',
      title: 'Alpha',
      percent: 25,
      state: 'started',
      url: 'https://linear.app/a/project/proj-1',
    });
    expect(res.items[1]).toMatchObject({ externalId: 'proj-2', title: 'Beta', percent: 80, state: 'completed' });
    // workspace connector lookup is cached across children in the same workspace
    expect(getConnectorId).toHaveBeenCalledTimes(1);
  });

  it('a Linear fetch failure on a child still yields an item (nulls, no throw)', async () => {
    const getChildMissions = mock(async () => [
      { id: 'm-1', title: 'Alpha', teamId: 'team-1', workspaceId: 'ws-1' },
    ] as any);
    const getLinks = mock(async () => [
      { provider: 'linear', externalId: 'proj-1', externalUrl: 'https://linear.app/a/project/proj-1' },
    ] as any);
    const getConnectorId = mock(async () => 'conn-1' as any);
    const fetchProgress = mock(async () => null as any);
    const res = await initiativeTrackerProgress(
      fakeDb,
      { initiativeId: 'init-1' },
      { getChildMissions, getLinks, getConnectorId, fetchProgress, parseUrl: parseProject },
    );
    expect(res.linked).toBe(true);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ title: 'Alpha', percent: null, state: null });
  });
});
