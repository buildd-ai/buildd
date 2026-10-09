import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { roleHas } from '@/lib/permission-registry';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockSetWorkspacePause = mock(async (_ws: string, _until: Date | null, _by: string | null) => {});

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: mockVerifyWorkspaceAccess }));
mock.module('@/lib/permissions', () => ({ roleHas, getTeamPermissionOverrides: async () => ({}) }));
mock.module('@/lib/token-route-policy', () => ({ hasTokenRouteAdminAccess: (a: any) => a?.level === 'admin' }));
const realPause = await import('@/lib/workspace-pause');
mock.module('@/lib/workspace-pause', () => ({ ...realPause, setWorkspacePause: mockSetWorkspacePause }));
mock.module('@buildd/core/db', () => ({ db: { query: { workspaces: { findFirst: mockWorkspacesFindFirst } } } }));

const { GET, POST } = await import('./route');
const PARAMS = Promise.resolve({ id: 'ws-1' });
const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest('http://localhost:3000/api/workspaces/ws-1/pause-starts', {
    method, headers: new Headers({ 'Content-Type': 'application/json', ...headers }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

beforeEach(() => {
  mockGetCurrentUser.mockReset(); mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
  mockAuthenticateApiKey.mockReset(); mockAuthenticateApiKey.mockResolvedValue(null);
  mockVerifyWorkspaceAccess.mockReset(); mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 't-1', role: 'owner' });
  mockWorkspacesFindFirst.mockReset(); mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 't-1', newStartsPausedUntil: null, newStartsPausedBy: null });
  mockSetWorkspacePause.mockClear();
});

describe('/api/workspaces/[id]/pause-starts', () => {
  it('GET reports not paused, and a pause still ahead', async () => {
    expect(await (await GET(req('GET'), { params: PARAMS })).json()).toEqual({ paused: false, until: null, by: null });
    const until = new Date(Date.now() + 3_600_000);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 't-1', newStartsPausedUntil: until, newStartsPausedBy: 'user-1' });
    expect(await (await GET(req('GET'), { params: PARAMS })).json()).toEqual({ paused: true, until: until.toISOString(), by: 'user-1' });
  });

  it('POST for: 4h pauses until then, recording who', async () => {
    const before = Date.now();
    const res = await POST(req('POST', { for: '4h' }), { params: PARAMS });
    expect(res.status).toBe(200);
    const [ws, until, by] = mockSetWorkspacePause.mock.calls[0];
    expect(ws).toBe('ws-1');
    expect(by).toBe('user-1');
    expect((until as Date).getTime()).toBeGreaterThanOrEqual(before + 4 * 3_600_000);
    expect((await res.json()).paused).toBe(true);
  });

  it('POST until: null resumes now', async () => {
    const res = await POST(req('POST', { until: null }), { params: PARAMS });
    expect(res.status).toBe(200);
    expect(mockSetWorkspacePause.mock.calls[0][1]).toBeNull();
    expect(await res.json()).toEqual({ paused: false, until: null, by: null });
  });

  it('POST refuses a bad request without writing', async () => {
    expect((await POST(req('POST', { for: 'soon' }), { params: PARAMS })).status).toBe(400);
    expect(mockSetWorkspacePause).not.toHaveBeenCalled();
  });

  it('a member without the settings permission is refused; a stranger gets 404', async () => {
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 't-1', role: 'member' });
    expect((await POST(req('POST', { for: '1h' }), { params: PARAMS })).status).toBe(403);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    expect((await POST(req('POST', { for: '1h' }), { params: PARAMS })).status).toBe(404);
    expect(mockSetWorkspacePause).not.toHaveBeenCalled();
  });

  it('a non-admin API key of the team is refused; an admin key may pause', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'a-1', teamId: 't-1', level: 'worker' });
    expect((await POST(req('POST', { for: '1h' }, { authorization: 'Bearer bld_x' }), { params: PARAMS })).status).toBe(403);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'a-1', teamId: 't-1', level: 'admin' });
    expect((await POST(req('POST', { for: '1h' }, { authorization: 'Bearer bld_x' }), { params: PARAMS })).status).toBe(200);
  });
});
