import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = '11111111-1111-4111-8111-111111111111';
const mockRequireSessionUser = mock(async () => ({ user: { id: 'u-1' } }) as any);
const mockGetUserTeamIds = mock(async () => [TEAM] as string[]);
const mockGetUserAdminTeamIds = mock(async () => [] as string[]);
const masked = { baseURL: 'https://litellm.example.test/v1', last4: 'abcd', health: 'healthy', lastVerificationError: null, updatedAt: '2026-01-01T00:00:00.000Z' };
const mockGet = mock(async () => masked as any);
const mockSet = mock(async (_input: any) => ({ ok: true, gateway: masked }) as any);
const mockDelete = mock(async () => true);

mock.module('@/lib/auth-helpers', () => ({ requireSessionUser: mockRequireSessionUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockGetUserTeamIds, getUserAdminTeamIds: mockGetUserAdminTeamIds }));
mock.module('@/lib/litellm-gateway-settings', () => ({ getTeamGateway: mockGet, setTeamGateway: mockSet, deleteTeamGateway: mockDelete }));

const { GET, PUT, DELETE } = await import('./route');
const ctx = (id = TEAM) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown) => new NextRequest(`http://localhost:3000/api/teams/${TEAM}/litellm-gateway`, {
  method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

beforeEach(() => {
  mockGetUserTeamIds.mockResolvedValue([TEAM]);
  mockGetUserAdminTeamIds.mockResolvedValue([]);
  mockSet.mockClear();
  mockDelete.mockClear();
});

describe('/api/teams/[id]/litellm-gateway', () => {
  it('lets any member read the masked gateway', async () => {
    const res = await GET(req('GET'), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ gateway: masked });
  });

  it('404s a non-member and a non-UUID id', async () => {
    mockGetUserTeamIds.mockResolvedValue([]);
    expect((await GET(req('GET'), ctx())).status).toBe(404);
    expect((await GET(req('GET'), ctx('short'))).status).toBe(404);
  });

  it('only an owner/admin may set or remove it', async () => {
    expect((await PUT(req('PUT', { baseUrl: 'https://litellm.example.test/v1', apiKey: 'sk-lite-123456' }), ctx())).status).toBe(403);
    expect((await DELETE(req('DELETE'), ctx())).status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('an admin sets it (checked by setTeamGateway) and gets the masked view', async () => {
    mockGetUserAdminTeamIds.mockResolvedValue([TEAM]);
    const res = await PUT(req('PUT', { baseUrl: 'https://litellm.example.test/v1', apiKey: 'sk-lite-123456' }), ctx());
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith({ teamId: TEAM, baseUrl: 'https://litellm.example.test/v1', apiKey: 'sk-lite-123456' });
    expect(JSON.stringify(await res.json())).not.toContain('sk-lite-123456');
  });

  it('passes a refusal through with its status', async () => {
    mockGetUserAdminTeamIds.mockResolvedValue([TEAM]);
    mockSet.mockResolvedValueOnce({ ok: false, status: 400, error: 'The gateway rejected this key.' });
    const res = await PUT(req('PUT', { baseUrl: 'https://litellm.example.test/v1', apiKey: 'bad' }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/rejected/);
  });
});
