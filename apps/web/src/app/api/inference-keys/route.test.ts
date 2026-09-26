import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockRequireSessionUser = mock(async () => ({ user: { id: 'u-1' } }) as any);
const mockGetUserTeamIds = mock(async () => ['t-1'] as string[]);
const mockGetUserAdminTeamIds = mock(async () => [] as string[]);
const mockList = mock(async (teamId: string, userId: string, canManage: boolean) => ({
  teamId, canManageTeamKeys: canManage, providers: [], _userId: userId,
}));
const mockSet = mock(async (_input: any) => ({
  ok: true, key: { id: 's-1', provider: 'openrouter', scope: 'user', last4: 'abcd', health: 'healthy' },
}) as any);
const mockDelete = mock(async (_input: any) => true);

mock.module('@/lib/auth-helpers', () => ({ requireSessionUser: mockRequireSessionUser }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  getUserAdminTeamIds: mockGetUserAdminTeamIds,
}));
mock.module('@/lib/provider-keys', () => ({
  listProviderKeys: mockList,
  setProviderKey: mockSet,
  deleteProviderKey: mockDelete,
}));

const { GET, PUT, DELETE } = await import('./route');

function req(method: string, url: string, body?: unknown) {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  mockRequireSessionUser.mockReset();
  mockRequireSessionUser.mockResolvedValue({ user: { id: 'u-1' } });
  mockGetUserTeamIds.mockReset();
  mockGetUserTeamIds.mockResolvedValue(['t-1']);
  mockGetUserAdminTeamIds.mockReset();
  mockGetUserAdminTeamIds.mockResolvedValue([]);
  mockSet.mockClear();
  mockDelete.mockClear();
  mockList.mockClear();
});

describe('auth', () => {
  it('refuses API keys and anonymous callers — a personal key needs a person', async () => {
    const denied = new Response('{}', { status: 403 });
    mockRequireSessionUser.mockResolvedValue({ response: denied });
    expect((await GET(req('GET', '/api/inference-keys'))).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('404s a team the caller is not in', async () => {
    const res = await GET(req('GET', '/api/inference-keys?teamId=t-other'));
    expect(res.status).toBe(404);
  });
});

describe('GET', () => {
  it('lists for the caller, telling it whether it can manage team keys', async () => {
    mockGetUserAdminTeamIds.mockResolvedValue(['t-1']);
    const res = await GET(req('GET', '/api/inference-keys?teamId=t-1'));
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('t-1', 'u-1', true);
  });

  it('members get canManageTeamKeys false', async () => {
    await GET(req('GET', '/api/inference-keys'));
    expect(mockList).toHaveBeenCalledWith('t-1', 'u-1', false);
  });
});

describe('PUT', () => {
  const body = { teamId: 't-1', provider: 'openrouter', scope: 'user', value: 'sk-or-v1-0123456789abcdef' };

  it('any member can set their own key', async () => {
    const res = await PUT(req('PUT', '/api/inference-keys', body));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith({ ...body, userId: 'u-1' });
    const json = await res.json();
    expect(JSON.stringify(json)).not.toContain(body.value);
  });

  it('a member cannot set the team key', async () => {
    const res = await PUT(req('PUT', '/api/inference-keys', { ...body, scope: 'team' }));
    expect(res.status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('an admin can set the team key', async () => {
    mockGetUserAdminTeamIds.mockResolvedValue(['t-1']);
    const res = await PUT(req('PUT', '/api/inference-keys', { ...body, scope: 'team' }));
    expect(res.status).toBe(200);
    expect(mockSet.mock.calls[0][0].scope).toBe('team');
  });

  it('rejects an unknown provider, a workspace scope, and a missing value', async () => {
    expect((await PUT(req('PUT', '/api/inference-keys', { ...body, provider: 'openai-codex' }))).status).toBe(400);
    expect((await PUT(req('PUT', '/api/inference-keys', { ...body, scope: 'workspace' }))).status).toBe(400);
    expect((await PUT(req('PUT', '/api/inference-keys', { ...body, value: '  ' }))).status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('passes the lib\'s refusal through (e.g. the provider rejected the key)', async () => {
    mockSet.mockResolvedValueOnce({ ok: false, status: 400, error: 'The provider rejected this key.' });
    const res = await PUT(req('PUT', '/api/inference-keys', body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('rejected');
  });
});

describe('DELETE', () => {
  it('any member can delete their own key', async () => {
    const res = await DELETE(req('DELETE', '/api/inference-keys?teamId=t-1&provider=openai&scope=user'));
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith({ teamId: 't-1', userId: 'u-1', provider: 'openai', scope: 'user' });
    expect(await res.json()).toEqual({ deleted: true });
  });

  it('a member cannot delete the team key', async () => {
    const res = await DELETE(req('DELETE', '/api/inference-keys?provider=openai&scope=team'));
    expect(res.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
