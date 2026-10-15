/**
 * GET /api/missions/recent (spec c7410e76 R-24): who may ask, that the read is
 * scoped to the caller's reachable workspaces, and the shape handed back.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(async (): Promise<any> => null);
const mockAuthenticateApiKey = mock(async (_key: string | null, _req?: unknown): Promise<any> => null);
const mockListReachable = mock(async (_caller: unknown): Promise<string[]> => []);
let stagesImpl: (missionIds: string[], workspaceIds: string[]) => Promise<Map<string, any>> = async () => new Map();
const mockLoadMissionStages = mock((missionIds: string[], workspaceIds: string[]) => stagesImpl(missionIds, workspaceIds));
let rows: any[] = [];
const mockFindMany = mock(async (_args: unknown): Promise<any[]> => rows);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/workspace-access', () => ({ listReachableWorkspaceIds: mockListReachable }));
mock.module('@/lib/mission-stage-load', () => ({ loadMissionStages: mockLoadMissionStages }));
mock.module('@buildd/core/db', () => ({ db: { query: { missions: { findMany: mockFindMany } } } }));

const { GET, RECENT_DAYS } = await import('./route');

const NOW = Date.now();
const day = (n: number) => new Date(NOW - n * 86_400_000);

function req(headers: Record<string, string> = {}) {
  return new NextRequest(new URL('http://localhost:3000/api/missions/recent'), { headers });
}

describe('GET /api/missions/recent', () => {
  beforeEach(() => {
    for (const m of [mockGetCurrentUser, mockAuthenticateApiKey, mockListReachable, mockLoadMissionStages, mockFindMany]) m.mockClear();
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockListReachable.mockResolvedValue([]);
    stagesImpl = async () => new Map();
    rows = [];
  });

  it('401 without a key or a session, and reads nothing', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('reaches no workspace: empty list, no read', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'a1' });
    const res = await GET(req({ authorization: 'Bearer bld_x' }));
    expect(await res.json()).toEqual({ missions: [] });
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('scopes to the reachable workspaces and returns open and recently finished missions with their stage', async () => {
    const account = { id: 'a1' };
    mockAuthenticateApiKey.mockResolvedValue(account);
    mockListReachable.mockResolvedValue(['ws-1', 'ws-2']);
    rows = [
      { id: 'm-open', title: 'Open one', workspaceId: 'ws-1', status: 'active', isHeld: false, executor: 'runner', completedAt: null, updatedAt: day(1) },
      { id: 'm-local', title: 'Local one', workspaceId: 'ws-2', status: 'paused', isHeld: true, executor: 'local', completedAt: null, updatedAt: day(2) },
      { id: 'm-done', title: 'Done one', workspaceId: 'ws-1', status: 'completed', isHeld: false, executor: 'runner', completedAt: day(2), updatedAt: day(1) },
      { id: 'm-nodate', title: 'Done, no stamp', workspaceId: 'ws-1', status: 'completed', isHeld: false, executor: 'runner', completedAt: null, updatedAt: day(3) },
    ];
    stagesImpl = async () => new Map([['m-open', { step: 'building', waitingOn: null }]]);

    const res = await GET(req({ authorization: 'Bearer bld_x' }));
    expect(res.status).toBe(200);
    expect(mockListReachable.mock.calls[0]![0]).toEqual({ account });
    expect(mockLoadMissionStages.mock.calls[0]).toEqual([['m-open', 'm-local', 'm-done', 'm-nodate'], ['ws-1', 'ws-2']]);
    const body = await res.json();
    expect(body.missions.map((m: any) => m.id)).toEqual(['m-open', 'm-local', 'm-done', 'm-nodate']);
    expect(body.missions[0]).toEqual({
      id: 'm-open', title: 'Open one', workspaceId: 'ws-1', status: 'active', isHeld: false, executor: 'runner',
      completedAt: null, stage: { step: 'building', waitingOn: null },
    });
    expect(body.missions[1].executor).toBe('local');
    expect(body.missions[1].isHeld).toBe(true);
    expect(body.missions[2].completedAt).toBe(day(2).toISOString());
    // A finished mission with no stamp falls back to its last update, never "now".
    expect(body.missions[3].completedAt).toBe(day(3).toISOString());
    expect(body.missions[2].stage).toBeNull();
  });

  it('the read itself is limited to those workspaces and the finished window', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'a1' });
    mockListReachable.mockResolvedValue(['ws-1']);
    await GET(req({ authorization: 'Bearer bld_x' }));
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(RECENT_DAYS).toBe(7);
    const args = mockFindMany.mock.calls[0]![0] as any;
    expect(args.where).toBeDefined();
    expect(args.columns.workspaceId).toBe(true);
  });

  it('500 with a plain message when the read fails', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'a1' });
    mockListReachable.mockResolvedValue(['ws-1']);
    mockFindMany.mockRejectedValueOnce(new Error('boom'));
    const res = await GET(req({ authorization: 'Bearer bld_x' }));
    expect(res.status).toBe(500);
  });
});
