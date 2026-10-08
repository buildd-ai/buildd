import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const WS = '11111111-1111-4111-8111-111111111111';

const mockAuthenticateApiKey = mock(async (..._a: unknown[]) => null as null | { id: string; teamId: string; level?: string });
const mockGetCurrentUser = mock(async () => null as null | { id: string });
const mockVerifyWorkspaceAccess = mock(async (..._a: unknown[]) => null as null | { teamId: string; role: string });
const mockHoldsInWorkspace = mock(async (..._a: unknown[]) => false);
const mockHasTokenRouteAdminAccess = mock((..._a: unknown[]) => false);
const mockWorkspacesFindFirst = mock(async (..._a: unknown[]) => ({ teamId: 'team-1' }) as null | { teamId: string });
const mockCheck = mock(async (_id: string) => ({ verified: true, resumed: ['t1'], healed: true, refreshedInstallations: 1, diagnosis: { ok: true } }) as any);
const mockView = mock(async (_id: string, _u: string | null) => ({ ok: false, repo: 'acme/web', remediation: { reason: 'repo_not_selected' }, waitingTasks: 2 }) as any);

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: mockVerifyWorkspaceAccess, holdsInWorkspace: mockHoldsInWorkspace }));
mock.module('@/lib/token-route-policy', () => ({ hasTokenRouteAdminAccess: mockHasTokenRouteAdminAccess }));
mock.module('@buildd/core/db', () => ({ db: { query: { workspaces: { findFirst: mockWorkspacesFindFirst } } } }));
mock.module('@/lib/github-repo-access-store', () => ({ checkWorkspaceRepoConnection: mockCheck, getRepoAccessView: mockView }));

import { GET, POST } from './route';

const params = (id = WS) => ({ params: Promise.resolve({ id }) });
const req = (method: 'GET' | 'POST', headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost/api/workspaces/${WS}/github-access`, { method, headers });

describe('/api/workspaces/[id]/github-access', () => {
  beforeEach(() => {
    for (const m of [mockAuthenticateApiKey, mockGetCurrentUser, mockVerifyWorkspaceAccess, mockHoldsInWorkspace, mockHasTokenRouteAdminAccess, mockCheck, mockView]) m.mockClear();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    mockHoldsInWorkspace.mockResolvedValue(false);
    mockHasTokenRouteAdminAccess.mockReturnValue(false);
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-1' });
  });

  it('401 without a session or key', async () => {
    expect((await GET(req('GET'), params())).status).toBe(401);
  });

  it('404 for a non-UUID id, and for a workspace outside the user’s teams', async () => {
    expect((await GET(req('GET'), params('nope'))).status).toBe(404);
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    expect((await GET(req('GET'), params())).status).toBe(404);
  });

  it('any team member reads the view, personalised to them', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });
    const res = await GET(req('GET'), params());
    expect(res.status).toBe(200);
    expect(mockView.mock.calls[0]).toEqual([WS, 'u1']);
  });

  it('a member without manage_workspace_settings cannot run Check connection', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });
    const res = await POST(req('POST'), params());
    expect(res.status).toBe(403);
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('a workspace admin runs Check connection: sync, link, resume', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'admin' });
    mockHoldsInWorkspace.mockResolvedValue(true);
    const res = await POST(req('POST'), params());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ verified: true, linked: true, resumed: 1, refreshedInstallations: 1 });
    expect(mockCheck).toHaveBeenCalledWith(WS);
  });

  it('an API key of another team gets 404; a non-admin key of the same team cannot POST', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct', teamId: 'team-2' });
    expect((await GET(req('GET', { authorization: 'Bearer bld_x' }), params())).status).toBe(404);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct', teamId: 'team-1' });
    expect((await GET(req('GET', { authorization: 'Bearer bld_x' }), params())).status).toBe(200);
    expect((await POST(req('POST', { authorization: 'Bearer bld_x' }), params())).status).toBe(403);
    mockHasTokenRouteAdminAccess.mockReturnValue(true);
    expect((await POST(req('POST', { authorization: 'Bearer bld_x' }), params())).status).toBe(200);
  });
});
