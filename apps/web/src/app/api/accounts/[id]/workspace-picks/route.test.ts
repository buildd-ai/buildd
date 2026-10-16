/**
 * Reading and replacing a runner key's picks (spec "One runner for every team
 * you run", R-4, R-8): the signed-in person who minted the key only; an API
 * key or an agent run never gets here.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const KEY = '11111111-2222-4333-8444-555555555555';
const mockUser = mock(async () => ({ id: 'user-1' }) as any);
const mockList = mock(async (_u: string) => [{ id: KEY, name: 'Runner', picks: [] }] as any[]);
const mockReplace = mock(async (_a: any) => ({ ok: true, workspaceIds: ['ws-1'] }) as any);
const mockTeams = mock(async (_u: string) => [] as any[]);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockUser }));
mock.module('@/lib/runner-picks', () => ({ listRunnerKeys: mockList, replaceRunnerPicks: mockReplace, runnerConsentTeams: mockTeams }));

const { GET, PUT } = await import('./route');

const ctx = (id = KEY) => ({ params: Promise.resolve({ id }) });
function put(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3000/api/accounts/${KEY}/workspace-picks`, {
    method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockUser.mockReset();
  mockUser.mockResolvedValue({ id: 'user-1' });
  mockReplace.mockClear();
  mockList.mockClear();
});

describe('/api/accounts/[id]/workspace-picks', () => {
  it('R-8: a bearer key without a session is refused and changes nothing', async () => {
    mockUser.mockResolvedValue(null);
    const res = await PUT(put({ workspaceIds: ['ws-elsewhere'] }, { authorization: 'Bearer bld_somekey' }), ctx());
    expect(res.status).toBe(401);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('replaces the picks for the signed-in person, without a new key', async () => {
    const res = await PUT(put({ workspaceIds: ['ws-1'] }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, workspaceIds: ['ws-1'] });
    expect(mockReplace).toHaveBeenCalledWith({ accountId: KEY, userId: 'user-1', workspaceIds: ['ws-1'] });
  });

  it("passes a refusal through (another person's key reads as not found)", async () => {
    mockReplace.mockResolvedValueOnce({ ok: false, status: 404, message: 'Key not found.' });
    expect((await PUT(put({ workspaceIds: ['ws-1'] }), ctx())).status).toBe(404);
  });

  it('a non-UUID id is not found and reaches nothing', async () => {
    expect((await PUT(put({ workspaceIds: ['ws-1'] }), ctx('nope'))).status).toBe(404);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("GET returns the key's picks and what may be picked, for its minter only", async () => {
    const res = await GET(new NextRequest(`http://localhost:3000/api/accounts/${KEY}/workspace-picks`), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).key.id).toBe(KEY);
    expect(mockList).toHaveBeenCalledWith('user-1');

    mockList.mockResolvedValueOnce([]);
    expect((await GET(new NextRequest(`http://localhost:3000/api/accounts/${KEY}/workspace-picks`), ctx())).status).toBe(404);
  });
});
