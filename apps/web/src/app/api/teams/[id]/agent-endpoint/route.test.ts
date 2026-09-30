import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const KEY = 'sk-agent-example-1234';
const mockRequireSessionUser = mock(async () => ({ user: { id: 'u-1' } }) as any);
const mockGetUserTeamIds = mock(async () => [TEAM] as string[]);
const mockGetUserAdminTeamIds = mock(async () => [] as string[]);
const masked = { id: 's-1', scope: 'team', workspaceId: null, kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', last4: '1234', health: 'healthy' };
const mockList = mock(async () => [masked] as any[]);
const mockSet = mock(async (_input: any) => ({ ok: true, endpoint: masked }) as any);
const mockDelete = mock(async (_t: string, _w: string | null) => true);

mock.module('@/lib/auth-helpers', () => ({ requireSessionUser: mockRequireSessionUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockGetUserTeamIds, getUserAdminTeamIds: mockGetUserAdminTeamIds }));
mock.module('@/lib/agent-endpoint-settings', () => ({ listTeamAgentEndpoints: mockList, setTeamAgentEndpoint: mockSet, deleteTeamAgentEndpoint: mockDelete }));

const { GET, PUT, DELETE } = await import('./route');
const ctx = (id = TEAM) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown, qs = '') => new NextRequest(`http://localhost:3000/api/teams/${TEAM}/agent-endpoint${qs}`, {
  method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const put = { kind: 'anthropic-compatible', baseUrl: 'https://litellm.example.com', apiKey: KEY, authHeader: 'authorization' };

beforeEach(() => {
  mockGetUserTeamIds.mockResolvedValue([TEAM]);
  mockGetUserAdminTeamIds.mockResolvedValue([]);
  mockSet.mockClear();
  mockDelete.mockClear();
});

describe('/api/teams/[id]/agent-endpoint', () => {
  it('any member reads the masked list, no-store', async () => {
    const res = await GET(req('GET'), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ endpoints: [masked] });
  });

  it('404s a non-member and a non-UUID id', async () => {
    mockGetUserTeamIds.mockResolvedValue([]);
    expect((await GET(req('GET'), ctx())).status).toBe(404);
    expect((await PUT(req('PUT', put), ctx())).status).toBe(404);
    expect((await GET(req('GET'), ctx('short'))).status).toBe(404);
  });

  it('only an owner/admin may set or remove it', async () => {
    expect((await PUT(req('PUT', put), ctx())).status).toBe(403);
    expect((await DELETE(req('DELETE'), ctx())).status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('an admin sets it; workspaceId is the scope, the rest is the endpoint; the key is never echoed', async () => {
    mockGetUserAdminTeamIds.mockResolvedValue([TEAM]);
    const res = await PUT(req('PUT', { ...put, workspaceId: WS }), ctx());
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith({ teamId: TEAM, workspaceId: WS, endpoint: put });
    expect(JSON.stringify(await res.json())).not.toContain(KEY);
  });

  it('passes a refusal through with its status, without the key', async () => {
    mockGetUserAdminTeamIds.mockResolvedValue([TEAM]);
    mockSet.mockResolvedValueOnce({ ok: false, status: 400, error: 'The endpoint rejected this key.' });
    const res = await PUT(req('PUT', put), ctx());
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain(KEY);
  });

  it('a thrown error is a generic 500 without the key', async () => {
    mockGetUserAdminTeamIds.mockResolvedValue([TEAM]);
    mockSet.mockRejectedValueOnce(new Error(`boom ${KEY}`));
    const res = await PUT(req('PUT', put), ctx());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain(KEY);
  });

  it('DELETE removes the team row by default, or one workspace\'s row', async () => {
    mockGetUserAdminTeamIds.mockResolvedValue([TEAM]);
    expect((await DELETE(req('DELETE'), ctx())).status).toBe(200);
    expect(mockDelete).toHaveBeenLastCalledWith(TEAM, null);
    await DELETE(req('DELETE', undefined, `?workspaceId=${WS}`), ctx());
    expect(mockDelete).toHaveBeenLastCalledWith(TEAM, WS);
    expect((await DELETE(req('DELETE', undefined, '?workspaceId=nope'), ctx())).status).toBe(400);
  });
});
