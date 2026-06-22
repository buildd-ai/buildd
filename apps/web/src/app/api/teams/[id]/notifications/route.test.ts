import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserTeamsWithDetails = mock(() => Promise.resolve([] as any[]));

const mockGetTeamPreferences = mock(() => Promise.resolve({ taskClaimed: true, taskCompleted: true, taskFailed: true, credentialExpired: true }));
const mockSetTeamPreferences = mock((_t: string, p: any) => Promise.resolve(p));
const mockGetTeamChannelStatus = mock(() => Promise.resolve({ pushover: false, webhook: false }));
const mockSetTeamPushover = mock(() => Promise.resolve());
const mockSetTeamWebhook = mock(() => Promise.resolve());
const mockDeleteTeamChannel = mock(() => Promise.resolve());

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamsWithDetails: mockGetUserTeamsWithDetails }));
mock.module('@/lib/notify', () => ({
  getTeamPreferences: mockGetTeamPreferences,
  setTeamPreferences: mockSetTeamPreferences,
  getTeamChannelStatus: mockGetTeamChannelStatus,
  setTeamPushover: mockSetTeamPushover,
  setTeamWebhook: mockSetTeamWebhook,
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
    mockSetTeamPushover.mockReset();
    mockSetTeamWebhook.mockReset();
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

  it('PUT stores pushover with the team\'s own app token + user key', async () => {
    const res = await PUT(putReq({ pushoverAppToken: 'aTOKEN', pushoverUserKey: 'uABC' }), ctx);
    expect(res.status).toBe(200);
    expect(mockSetTeamPushover).toHaveBeenCalledWith('team-1', 'aTOKEN', 'uABC');
  });

  it('PUT rejects pushover with only a user key (no app token → would use buildd\'s app)', async () => {
    const res = await PUT(putReq({ pushoverUserKey: 'uABC' }), ctx);
    expect(res.status).toBe(400);
    expect(mockSetTeamPushover).not.toHaveBeenCalled();
  });

  it('PUT rejects pushover with only an app token', async () => {
    const res = await PUT(putReq({ pushoverAppToken: 'aTOKEN' }), ctx);
    expect(res.status).toBe(400);
    expect(mockSetTeamPushover).not.toHaveBeenCalled();
  });

  it('PUT clears the pushover channel when both fields are null', async () => {
    const res = await PUT(putReq({ pushoverAppToken: null, pushoverUserKey: null }), ctx);
    expect(res.status).toBe(200);
    expect(mockDeleteTeamChannel).toHaveBeenCalledWith('team-1', 'pushover');
    expect(mockSetTeamPushover).not.toHaveBeenCalled();
  });

  it('PUT clears the webhook when value is null', async () => {
    const res = await PUT(putReq({ webhookUrl: null }), ctx);
    expect(res.status).toBe(200);
    expect(mockDeleteTeamChannel).toHaveBeenCalledWith('team-1', 'notify_webhook');
  });

  it('PUT rejects a non-http webhook URL', async () => {
    const res = await PUT(putReq({ webhookUrl: 'ftp://nope' }), ctx);
    expect(res.status).toBe(400);
    expect(mockSetTeamWebhook).not.toHaveBeenCalled();
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
