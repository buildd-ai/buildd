/**
 * GET /api/missions/stages (spec c7410e76 R-18). The loader's own reads and
 * predicates are asserted in lib/mission-stage-load.test.ts, and the stage
 * rule itself in lib/mission-stage.test.ts; here only who may ask, what the
 * route hands the loader, and what it does with the answer.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(async (): Promise<any> => null);
const mockAuthenticateApiKey = mock(async (_key: string | null, _req?: unknown): Promise<any> => null);
const mockListReachable = mock(async (_caller: unknown): Promise<string[]> => []);
let stagesImpl: (missionIds: string[], workspaceIds: string[]) => Promise<Map<string, any>> = async () => new Map();
const mockLoadMissionStages = mock((missionIds: string[], workspaceIds: string[]) => stagesImpl(missionIds, workspaceIds));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/workspace-access', () => ({ listReachableWorkspaceIds: mockListReachable }));
mock.module('@/lib/mission-stage-load', () => ({ loadMissionStages: mockLoadMissionStages }));

const { GET } = await import('./route');

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';

function req(query: string, headers: Record<string, string> = {}) {
  return new NextRequest(new URL(`http://localhost:3000/api/missions/stages${query}`), { headers });
}

describe('GET /api/missions/stages', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockListReachable.mockReset();
    mockListReachable.mockResolvedValue([]);
    mockLoadMissionStages.mockClear();
    stagesImpl = async () => new Map();
  });

  it('401 without a key or a session, and reads nothing', async () => {
    const res = await GET(req(`?ids=${M1}`));
    expect(res.status).toBe(401);
    expect(mockLoadMissionStages).not.toHaveBeenCalled();
  });

  it('asks the loader for exactly the named missions in the caller\'s reachable workspaces', async () => {
    const account = { id: 'account-1' };
    mockAuthenticateApiKey.mockResolvedValue(account);
    mockListReachable.mockResolvedValue(['ws-1']);
    // AC-7: build done, criteria pending.
    stagesImpl = async () => new Map([[M1, { step: 'verifying', waitingOn: 'Unit tests pass: not checked' }]]);

    const res = await GET(req(`?ids=${M1},${M2},${M1}`, { authorization: 'Bearer bld_xxx' }));
    expect(res.status).toBe(200);
    expect(mockListReachable.mock.calls[0]![0]).toEqual({ account });
    expect(mockLoadMissionStages).toHaveBeenCalledTimes(1);
    expect(mockLoadMissionStages.mock.calls[0]).toEqual([[M1, M2], ['ws-1']]);
    // A mission the loader did not find (other workspace, unknown) is absent, never fabricated.
    expect(await res.json()).toEqual({ stages: { [M1]: { step: 'verifying', waitingOn: 'Unit tests pass: not checked' } } });
  });

  it('a signed-in user reaches through their own workspaces', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockListReachable.mockResolvedValue(['ws-2']);
    const res = await GET(req(`?ids=${M2}`));
    expect(res.status).toBe(200);
    expect(mockListReachable.mock.calls[0]![0]).toEqual({ userId: 'user-1' });
    expect(mockLoadMissionStages.mock.calls[0]).toEqual([[M2], ['ws-2']]);
  });

  it('refuses a malformed id rather than widening or guessing', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    const res = await GET(req(`?ids=${M1},m1`, { authorization: 'Bearer bld_xxx' }));
    expect(res.status).toBe(400);
    expect(mockLoadMissionStages).not.toHaveBeenCalled();
  });

  it('refuses more than 100 ids', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const res = await GET(req(`?ids=${ids.join(',')}`, { authorization: 'Bearer bld_xxx' }));
    expect(res.status).toBe(400);
    expect(mockLoadMissionStages).not.toHaveBeenCalled();
  });

  it('no ids is an empty answer with no reads', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    const res = await GET(req('', { authorization: 'Bearer bld_xxx' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stages: {} });
    expect(mockLoadMissionStages).not.toHaveBeenCalled();
  });

  it('a failed read is a 500, so the caller keeps its list without stage', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockListReachable.mockResolvedValue(['ws-1']);
    stagesImpl = async () => { throw new Error('boom'); };
    const res = await GET(req(`?ids=${M1}`, { authorization: 'Bearer bld_xxx' }));
    expect(res.status).toBe(500);
    expect((await res.json()).stages).toBeUndefined();
  });
});
