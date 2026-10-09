import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => Promise.resolve(null as any));
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1']));
const mockResolveActiveTeamId = mock((_u: string, _c?: string) => Promise.resolve('team-1' as string | null));
const mockTeamWorkspaceIds = mock((_team: string) => Promise.resolve(['ws-1', 'ws-2']));
const mockLoadOccupancy = mock((_ws: string[], _w: string, _now?: number, _tz?: number) => Promise.resolve({ buckets: [], truncated: false } as any));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  resolveActiveTeamId: mockResolveActiveTeamId,
}));
mock.module('@/lib/fleet-occupancy-query', () => ({
  teamWorkspaceIds: mockTeamWorkspaceIds,
  loadOccupancySeries: mockLoadOccupancy,
}));

import { GET } from './route';

function req(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/fleet/occupancy${query}`);
}

describe('GET /api/fleet/occupancy', () => {
  beforeEach(() => {
    for (const m of [mockGetCurrentUser, mockGetUserTeamIds, mockResolveActiveTeamId, mockTeamWorkspaceIds, mockLoadOccupancy]) m.mockClear();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1', 'team-2']);
    mockResolveActiveTeamId.mockResolvedValue('team-1');
    mockTeamWorkspaceIds.mockResolvedValue(['ws-1', 'ws-2']);
  });

  it('401 without a session, and reads nothing', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    expect(mockLoadOccupancy).not.toHaveBeenCalled();
  });

  it('400 on an unknown window, and reads nothing', async () => {
    const res = await GET(req('?window=90d'));
    expect(res.status).toBe(400);
    expect(mockTeamWorkspaceIds).not.toHaveBeenCalled();
    expect(mockLoadOccupancy).not.toHaveBeenCalled();
  });

  it('200 for any member of the active team (no admin gate): reads only that team\'s workspaces, default 24h', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(mockTeamWorkspaceIds).toHaveBeenCalledWith('team-1');
    expect(mockLoadOccupancy.mock.calls[0].slice(0, 2)).toEqual([['ws-1', 'ws-2'], '24h']);
    const body = await res.json();
    expect(body.teamId).toBe('team-1');
  });

  it('every window is served on every plan', async () => {
    for (const w of ['24h', '7d', '30d']) {
      expect((await GET(req(`?window=${w}`))).status).toBe(200);
      expect(mockLoadOccupancy.mock.calls.at(-1)!.slice(0, 2)).toEqual([['ws-1', 'ws-2'], w]);
    }
  });

  it('?workspace= narrows to one of the team\'s workspaces', async () => {
    await GET(req('?workspace=ws-2&window=7d'));
    expect(mockLoadOccupancy.mock.calls[0].slice(0, 2)).toEqual([['ws-2'], '7d']);
  });

  it('?workspace= outside the team is ignored, never read', async () => {
    await GET(req('?workspace=ws-other'));
    expect(mockLoadOccupancy.mock.calls[0].slice(0, 2)).toEqual([['ws-1', 'ws-2'], '24h']);
  });

  it('honours ?team= for a team the caller is in', async () => {
    await GET(req('?team=team-2'));
    expect(mockTeamWorkspaceIds).toHaveBeenCalledWith('team-2');
  });

  it('404 for a team the caller is not in, without reading it', async () => {
    const res = await GET(req('?team=team-9'));
    expect(res.status).toBe(404);
    expect(mockTeamWorkspaceIds).not.toHaveBeenCalled();
  });

  it('404 when the user has no team', async () => {
    mockResolveActiveTeamId.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(404);
  });

  it('passes ?tzOffset= through as milliseconds, and 0 when absent or junk', async () => {
    await GET(req('?window=30d&tzOffset=-240'));
    expect(mockLoadOccupancy.mock.calls.at(-1)![3]).toBe(-240 * 60_000);
    await GET(req('?window=30d&tzOffset=abc'));
    expect(mockLoadOccupancy.mock.calls.at(-1)![3]).toBe(0);
  });
});
