import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserTeamsWithDetails = mock(() => Promise.resolve([] as any[]));

const mockGetTeamPreferences = mock(() => Promise.resolve({ taskClaimed: true, taskCompleted: true, taskFailed: true, credentialExpired: true }));
const mockSetTeamPreferences = mock((_t: string, p: any) => Promise.resolve(p));
const mockGetTeamChannelStatus = mock(() => Promise.resolve({ pushover: false, webhook: false }));
const mockSetTeamChannel = mock(() => Promise.resolve());
const mockDeleteTeamChannel = mock(() => Promise.resolve());

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamsWithDetails: mockGetUserTeamsWithDetails }));
mock.module('@/lib/notify', () => ({
  getTeamPreferences: mockGetTeamPreferences,
  setTeamPreferences: mockSetTeamPreferences,
  getTeamChannelStatus: mockGetTeamChannelStatus,
  setTeamChannel: mockSetTeamChannel,
  deleteTeamChannel: mockDeleteTeamChannel,
}));

import { GET, PUT } from './route';

const ctx = { params: Promise.resolve({ id: 'team-1' }) };

function getReq(): NextRequest {
  return new NextRequest('http://localhost:3000/api/teams/team-1/notifications');
}
function putReq(body: any): NextRequest {
  return new NextRequest('http://localhost:3000/api/teams/team-1/notifications', {
    method: 'PUT',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

describe('/api/teams/[id]/notifications', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserTeamsWithDetails.mockReset();
    mockSetTeamChannel.mockReset();
    mockDeleteTeamChannel.mockReset();
    mockSetTeamPreferences.mockReset();
    mockGetTeamChannelStatus.mockReset();
    mockGetTeamPreferences.mockReset();

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamsWithDetails.mockResolvedValue([{ id: 'team-1' }]);
    mockGetTeamChannelStatus.mockResolvedValue({ pushover: false, webhook: false });
    mockGetTeamPreferences.mockResolvedValue({ taskClaimed: true, taskCompleted: true, taskFailed: true, credentialExpired: true });
    mockSetTeamPreferences.mockImplementation((_t: string, p: any) => Promise.resolve(p));
  });

  it('GET returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(401);
  });

  it('GET returns 404 when the user does not belong to the team', async () => {
    mockGetUserTeamsWithDetails.mockResolvedValue([{ id: 'other-team' }]);
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(404);
  });

  it('GET returns channel status + preferences', async () => {
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.channels).toEqual({ pushover: false, webhook: false });
    expect(data.preferences.taskFailed).toBe(true);
  });

  it('PUT stores a pushover key', async () => {
    const res = await PUT(putReq({ pushoverUserKey: 'uABC' }), ctx);
    expect(res.status).toBe(200);
    expect(mockSetTeamChannel).toHaveBeenCalledWith('team-1', 'pushover', 'uABC');
  });

  it('PUT clears a channel when value is null', async () => {
    const res = await PUT(putReq({ webhookUrl: null }), ctx);
    expect(res.status).toBe(200);
    expect(mockDeleteTeamChannel).toHaveBeenCalledWith('team-1', 'notify_webhook');
  });

  it('PUT rejects a non-http webhook URL', async () => {
    const res = await PUT(putReq({ webhookUrl: 'ftp://nope' }), ctx);
    expect(res.status).toBe(400);
    expect(mockSetTeamChannel).not.toHaveBeenCalled();
  });

  it('PUT updates only provided event preferences', async () => {
    const res = await PUT(putReq({ preferences: { taskClaimed: false, bogus: true } }), ctx);
    expect(res.status).toBe(200);
    expect(mockSetTeamPreferences).toHaveBeenCalledWith('team-1', { taskClaimed: false });
  });

  it('PUT returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await PUT(putReq({ pushoverUserKey: 'u' }), ctx);
    expect(res.status).toBe(401);
  });
});
