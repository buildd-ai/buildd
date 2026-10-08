import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => Promise.resolve(null as any));
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1']));
const mockResolveActiveTeamId = mock((_u: string, _c?: string) => Promise.resolve('team-1' as string | null));
const mockCan = mock((_caller: unknown, _perm: string, _team: string) => Promise.resolve(true));
const mockTeamWorkspaceIds = mock((_team: string) => Promise.resolve(['ws-1', 'ws-2']));
const mockLoadFlowSeries = mock((_ws: string[], _w: string) => Promise.resolve({ buckets: [], tasks: [], truncated: false } as any));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  resolveActiveTeamId: mockResolveActiveTeamId,
}));
mock.module('@/lib/permissions', () => ({ can: mockCan }));
mock.module('@/lib/insights-flow-query', () => ({
  teamWorkspaceIds: mockTeamWorkspaceIds,
  loadFlowSeries: mockLoadFlowSeries,
}));

import { GET } from './route';

function req(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/insights/flow${query}`);
}

describe('GET /api/insights/flow', () => {
  beforeEach(() => {
    for (const m of [mockGetCurrentUser, mockGetUserTeamIds, mockResolveActiveTeamId, mockCan, mockTeamWorkspaceIds, mockLoadFlowSeries]) m.mockClear();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1', 'team-2']);
    mockResolveActiveTeamId.mockResolvedValue('team-1');
    mockCan.mockResolvedValue(true);
  });

  it('401 without a session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    expect(mockLoadFlowSeries).not.toHaveBeenCalled();
  });

  it('403 when the caller lacks view_team_usage in the team, and reads nothing', async () => {
    mockCan.mockResolvedValue(false);
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(mockCan).toHaveBeenCalledWith({ kind: 'user', userId: 'user-1' }, 'view_team_usage', 'team-1');
    expect(mockTeamWorkspaceIds).not.toHaveBeenCalled();
    expect(mockLoadFlowSeries).not.toHaveBeenCalled();
  });

  it('200 for the active team: reads only that team\'s workspaces, default window 7d', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(mockTeamWorkspaceIds).toHaveBeenCalledWith('team-1');
    expect(mockLoadFlowSeries).toHaveBeenCalledWith(['ws-1', 'ws-2'], '7d');
    const body = await res.json();
    expect(body.teamId).toBe('team-1');
    expect(body.windowKey).toBe('7d');
  });

  it('honours ?team= for a team the caller is in, and checks the permission there', async () => {
    const res = await GET(req('?team=team-2&window=30d'));
    expect(res.status).toBe(200);
    expect(mockCan).toHaveBeenCalledWith({ kind: 'user', userId: 'user-1' }, 'view_team_usage', 'team-2');
    expect(mockTeamWorkspaceIds).toHaveBeenCalledWith('team-2');
    expect(mockLoadFlowSeries).toHaveBeenCalledWith(['ws-1', 'ws-2'], '30d');
  });

  it('404 for a team the caller is not in, without checking or reading it', async () => {
    const res = await GET(req('?team=team-9'));
    expect(res.status).toBe(404);
    expect(mockCan).not.toHaveBeenCalled();
    expect(mockTeamWorkspaceIds).not.toHaveBeenCalled();
  });

  it('400 on an unknown window', async () => {
    expect((await GET(req('?window=24h'))).status).toBe(400);
  });

  it('404 when the user has no team', async () => {
    mockResolveActiveTeamId.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(404);
  });
});
