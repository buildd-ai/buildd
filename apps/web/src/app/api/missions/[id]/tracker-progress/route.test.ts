import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Auth / db mocks ONLY — these modules are re-mocked by each of their own
// consumers, so their global mock.module leak is benign. We deliberately do NOT
// mock '@buildd/core/external-links' or '@/lib/work-tracker' (that would corrupt
// the Phase 1 link route test + core external-links test, which need the REAL
// parseLinearUrl/linkExternal). Progress/linking LOGIC is tested by calling the
// exported `missionTrackerProgress` core directly with injected deps.

const mockGetCurrentUser = mock(() => ({ id: 'user-1' }) as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockResolveAccountTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockMissionsFindFirst = mock(async () => ({ id: 'm-1', teamId: 'team-1', workspaceId: 'ws-1' }) as any);
const mockWorkspacesFindFirst = mock(async () => ({ workTrackerConfig: { provider: 'linear', connectorId: 'conn-1' } }) as any);

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
      missions: { findFirst: (...a: any[]) => mockMissionsFindFirst(...(a as [])) },
      workspaces: { findFirst: (...a: any[]) => mockWorkspacesFindFirst(...(a as [])) },
    },
  },
}));

import { GET, missionTrackerProgress } from './route';

const call = (opts?: { auth?: string }) => {
  const headers: Record<string, string> = {};
  if (opts?.auth) headers.authorization = opts.auth;
  const req = new NextRequest('http://localhost/api/missions/m-1/tracker-progress', { headers });
  return GET(req, { params: Promise.resolve({ id: 'm-1' }) });
};

// missionTrackerProgress never touches this db (getLinks is injected).
const fakeDb = {} as any;
const parseProject = (() => ({ type: 'project', externalId: 'proj-x' })) as any;

describe('GET /api/missions/[id]/tracker-progress — auth + 404 (handler)', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockResolveAccountTeamIds.mockReset();
    mockMissionsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();

    mockGetCurrentUser.mockReturnValue({ id: 'user-1' } as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockResolvedValue({ id: 'm-1', teamId: 'team-1', workspaceId: 'ws-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ workTrackerConfig: { provider: 'linear', connectorId: 'conn-1' } });
  });

  it('401 when unauthenticated', async () => {
    mockGetCurrentUser.mockReturnValue(null as any);
    mockAuthenticateApiKey.mockReturnValue(null);
    expect((await call()).status).toBe(401);
  });

  it('403 for a non-admin API key', async () => {
    mockGetCurrentUser.mockReturnValue(null as any);
    mockAuthenticateApiKey.mockReturnValue({ id: 'api-1', level: 'worker' } as any);
    expect((await call({ auth: 'Bearer bld_test' })).status).toBe(403);
  });

  it('404 when the mission is not found / inaccessible', async () => {
    mockMissionsFindFirst.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });

  it('404 when the mission belongs to another team', async () => {
    mockMissionsFindFirst.mockResolvedValue({ id: 'm-1', teamId: 'team-other', workspaceId: null });
    mockWorkspacesFindFirst.mockResolvedValue({ accessMode: 'team' });
    expect((await call()).status).toBe(404);
  });
});

describe('missionTrackerProgress — progress/linking logic (DI)', () => {
  it('linked:false when the mission has no linear link (fetch never called)', async () => {
    const getLinks = mock(async () => [{ provider: 'github', externalId: 'g1', externalUrl: 'u' }] as any);
    const fetchProgress = mock(async () => null as any);
    const res = await missionTrackerProgress(
      fakeDb,
      { missionId: 'm-1', teamId: 'team-1', connectorId: 'conn-1' },
      { getLinks, fetchProgress, parseUrl: parseProject },
    );
    expect(res).toMatchObject({ linked: false, provider: null, items: [] });
    expect(typeof res.fetchedAt).toBe('string');
    expect(fetchProgress).not.toHaveBeenCalled();
  });

  it('linked + progress → one item with percent/state/url; connectorId+teamId threaded', async () => {
    const getLinks = mock(async () => [
      { provider: 'linear', externalId: 'proj-x', externalUrl: 'https://linear.app/acme/project/proj-x' },
    ] as any);
    const fetchProgress = mock(async () => ({ title: 'Mobile App', percent: 40, state: 'started' }) as any);
    const res = await missionTrackerProgress(
      fakeDb,
      { missionId: 'm-1', teamId: 'team-1', connectorId: 'conn-1' },
      { getLinks, fetchProgress, parseUrl: parseProject },
    );
    expect(res.linked).toBe(true);
    expect(res.provider).toBe('linear');
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toEqual({
      kind: 'project',
      externalId: 'proj-x',
      title: 'Mobile App',
      percent: 40,
      state: 'started',
      url: 'https://linear.app/acme/project/proj-x',
    });
    expect(fetchProgress).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 'conn-1', teamId: 'team-1', externalId: 'proj-x', kind: 'project' }),
    );
  });

  it('Linear fetch failure → linked:true with null percent/state (no throw)', async () => {
    const getLinks = mock(async () => [
      { provider: 'linear', externalId: 'proj-x', externalUrl: 'https://linear.app/acme/project/proj-x' },
    ] as any);
    const fetchProgress = mock(async () => null as any);
    const res = await missionTrackerProgress(
      fakeDb,
      { missionId: 'm-1', teamId: 'team-1', connectorId: 'conn-1' },
      { getLinks, fetchProgress, parseUrl: parseProject },
    );
    expect(res.linked).toBe(true);
    expect(res.items[0]).toMatchObject({ percent: null, state: null, externalId: 'proj-x' });
    expect(res.items[0].url).toBe('https://linear.app/acme/project/proj-x');
  });

  it('linked:true with nulls when there is no connector configured (fetch never called)', async () => {
    const getLinks = mock(async () => [
      { provider: 'linear', externalId: 'proj-x', externalUrl: 'https://linear.app/acme/project/proj-x' },
    ] as any);
    const fetchProgress = mock(async () => null as any);
    const res = await missionTrackerProgress(
      fakeDb,
      { missionId: 'm-1', teamId: 'team-1', connectorId: null },
      { getLinks, fetchProgress, parseUrl: parseProject },
    );
    expect(res.linked).toBe(true);
    expect(res.items[0]).toMatchObject({ percent: null, state: null });
    expect(fetchProgress).not.toHaveBeenCalled();
  });
});
