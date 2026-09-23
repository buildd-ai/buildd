import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(async () => null as any);
const mockAuthenticateApiKey = mock(async (_k: string | null) => null as any);
const mockVerifyJwt = mock(async (_t: string) => null as any);
const mockResolveActiveTeamId = mock(async (..._a: any[]) => null as string | null);
const mockVerifyWorkspaceAccess = mock(async (..._a: any[]) => null as any);
const mockVerifyAccountWorkspaceAccess = mock(async (..._a: any[]) => false);
const mockMemberFindFirst = mock(async (..._a: any[]) => null as any);
const mockWorkspaceFindFirst = mock(async (..._a: any[]) => null as any);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/oauth/tokens', () => ({
  looksLikeJwt: (t: string) => t.split('.').length === 3,
  verifyAccessTokenAnyAudience: mockVerifyJwt,
}));
mock.module('@/lib/team-access', () => ({
  resolveActiveTeamId: mockResolveActiveTeamId,
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));
mock.module('@buildd/core/db', () => ({
  db: { query: { teamMembers: { findFirst: mockMemberFindFirst }, workspaces: { findFirst: mockWorkspaceFindFirst } } },
}));

import { resolveExperimentViewer } from './experiment-access';

function req(opts: { bearer?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers.Cookie = `buildd-team=${opts.cookie}`;
  return new NextRequest('http://localhost/api/experiments', { headers });
}

beforeEach(() => {
  for (const m of [mockGetCurrentUser, mockAuthenticateApiKey, mockVerifyJwt, mockResolveActiveTeamId,
    mockVerifyWorkspaceAccess, mockVerifyAccountWorkspaceAccess, mockMemberFindFirst, mockWorkspaceFindFirst]) m.mockReset();
  mockGetCurrentUser.mockResolvedValue(null);
  mockAuthenticateApiKey.mockResolvedValue(null);
});

describe('resolveExperimentViewer — session', () => {
  it('401 with no session and no key', async () => {
    const r = await resolveExperimentViewer(req(), null);
    expect(r).toEqual({ ok: false, status: 401, error: 'Unauthorized' });
  });

  it.each(['member', 'admin', 'owner'])('active team + team_members role %s', async (role) => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockResolveActiveTeamId.mockResolvedValue('team-a');
    mockMemberFindFirst.mockResolvedValue({ role });
    const r = await resolveExperimentViewer(req({ cookie: 'team-a' }), null);
    expect(r).toEqual({ ok: true, viewer: { teamId: 'team-a', role: role as any, userId: 'u-1' } });
    expect(mockResolveActiveTeamId).toHaveBeenCalledWith('u-1', 'team-a');
  });

  it('404 when the user is not a member of the resolved team', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockResolveActiveTeamId.mockResolvedValue('team-a');
    mockMemberFindFirst.mockResolvedValue(null);
    const r = await resolveExperimentViewer(req(), null);
    expect(r.ok).toBe(false);
  });

  it('workspaceId: an admin on an open workspace keeps their admin role', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    // verifyWorkspaceAccess reports 'member' for open workspaces without reading membership.
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-b', role: 'member' });
    mockMemberFindFirst.mockResolvedValue({ role: 'admin' });
    const r = await resolveExperimentViewer(req(), 'ws-1');
    expect(r).toEqual({ ok: true, viewer: { teamId: 'team-b', role: 'admin', userId: 'u-1' } });
  });

  it('workspaceId the user cannot reach → 404', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    const r = await resolveExperimentViewer(req(), 'ws-x');
    expect(r.ok === false && r.status).toBe(404);
  });
});

describe('resolveExperimentViewer — API key', () => {
  it('admin-level key acts as admin on its own team', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct', teamId: 'team-a', level: 'admin' });
    const r = await resolveExperimentViewer(req({ bearer: 'bld_x' }), null);
    expect(r).toEqual({ ok: true, viewer: { teamId: 'team-a', role: 'admin', userId: null } });
  });

  it.each(['worker', 'trigger'])('%s-level key acts as member', async (level) => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct', teamId: 'team-a', level });
    const r = await resolveExperimentViewer(req({ bearer: 'bld_x' }), null);
    expect(r.ok && r.viewer.role).toBe('member');
  });

  it('workspaceId resolves through the workspace only when the account can reach it', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct', teamId: 'team-a', level: 'admin' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);
    expect((await resolveExperimentViewer(req({ bearer: 'bld_x' }), 'ws-2')).ok).toBe(false);

    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockWorkspaceFindFirst.mockResolvedValue({ teamId: 'team-b' });
    const r = await resolveExperimentViewer(req({ bearer: 'bld_x' }), 'ws-2');
    expect(r.ok && r.viewer.teamId).toBe('team-b');
  });

  it('OAuth bearer uses the human’s team_members role on the resolved team', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct', teamId: 'team-a', level: 'admin' });
    mockVerifyJwt.mockResolvedValue({ sub: 'u-9' });
    mockMemberFindFirst.mockResolvedValue({ role: 'member' });
    const r = await resolveExperimentViewer(req({ bearer: 'aaa.bbb.ccc' }), null);
    expect(r).toEqual({ ok: true, viewer: { teamId: 'team-a', role: 'member', userId: 'u-9' } });
  });
});
