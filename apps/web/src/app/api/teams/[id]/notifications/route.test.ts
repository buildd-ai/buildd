import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserTeamIds = mock(() => Promise.resolve([] as string[]));

const mockGetTeamPreferences = mock(() => Promise.resolve({ taskClaimed: true, taskCompleted: true, taskFailed: true, credentialExpired: true }));
const mockSetTeamPreferences = mock((_t: string, p: any) => Promise.resolve(p));
const mockGetTeamChannelStatus = mock(() => Promise.resolve({ pushover: false, webhook: false }));
const mockSetTeamPushover = mock(() => Promise.resolve());
const mockSetTeamWebhook = mock(() => Promise.resolve());
const mockDeleteTeamChannel = mock(() => Promise.resolve());

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockGetUserTeamIds }));

// The caller's role in team-1; null = no membership row. can() is answered
// from the real registry defaults.
let actorRole: string | null = 'owner';
const { roleHas } = await import('@/lib/permission-registry');
mock.module('@/lib/permissions', () => ({
  can: async (_caller: unknown, permission: any, teamId: string) =>
    teamId === 'team-1' && roleHas(actorRole, permission, null),
}));
mock.module('@/lib/notify', () => ({
  getTeamPreferences: mockGetTeamPreferences,
  setTeamPreferences: mockSetTeamPreferences,
  getTeamChannelStatus: mockGetTeamChannelStatus,
  setTeamPushover: mockSetTeamPushover,
  setTeamWebhook: mockSetTeamWebhook,
  deleteTeamChannel: mockDeleteTeamChannel,
}));

const { GET, PUT } = await import('./route');

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
    mockGetUserTeamIds.mockReset();
    actorRole = 'owner';
    mockSetTeamPushover.mockReset();
    mockSetTeamWebhook.mockReset();
    mockDeleteTeamChannel.mockReset();
    mockSetTeamPreferences.mockReset();
    mockGetTeamChannelStatus.mockReset();
    mockGetTeamPreferences.mockReset();

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
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
    mockGetUserTeamIds.mockResolvedValue(['other-team']);
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(404);
  });

  it('GET returns channel status + preferences', async () => {
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.channels).toEqual({ pushover: false, webhook: false });
    expect(data.preferences.taskFailed).toBe(true);
    expect(data.canManage).toBe(true);
  });

  it('GET stays readable by a plain member, with channel status only (no secret values) and canManage false', async () => {
    actorRole = 'member';
    // Even if the channel lookup carried values, the response only says whether each channel is set.
    mockGetTeamChannelStatus.mockResolvedValue({ pushover: true, webhook: true, webhookUrl: 'https://hooks.example.com/secret', appToken: 'aTOKEN' } as any);
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.channels).toEqual({ pushover: true, webhook: true });
    expect(JSON.stringify(data)).not.toContain('secret');
    expect(JSON.stringify(data)).not.toContain('aTOKEN');
    expect(data.canManage).toBe(false);
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

  // Changing notification settings requires manage_team_notifications.
  it('PUT refuses a plain member with 403 and writes nothing', async () => {
    actorRole = 'member';
    const res = await PUT(putReq({
      pushoverAppToken: 'aTOKEN', pushoverUserKey: 'uABC',
      webhookUrl: 'https://hooks.example.com/x',
      preferences: { taskClaimed: false },
    }), ctx);
    expect(res.status).toBe(403);
    expect(mockSetTeamPushover).not.toHaveBeenCalled();
    expect(mockSetTeamWebhook).not.toHaveBeenCalled();
    expect(mockSetTeamPreferences).not.toHaveBeenCalled();
    expect(mockDeleteTeamChannel).not.toHaveBeenCalled();
  });

  it('PUT refuses a member clearing a channel, and deletes nothing', async () => {
    actorRole = 'member';
    const res = await PUT(putReq({ webhookUrl: null }), ctx);
    expect(res.status).toBe(403);
    expect(mockDeleteTeamChannel).not.toHaveBeenCalled();
  });

  for (const role of ['admin', 'owner']) {
    it(`PUT lets a team ${role} set the webhook`, async () => {
      actorRole = role;
      const res = await PUT(putReq({ webhookUrl: 'https://hooks.example.com/x' }), ctx);
      expect(res.status).toBe(200);
      expect(mockSetTeamWebhook).toHaveBeenCalledWith('team-1', 'https://hooks.example.com/x');
    });
  }

  it('PUT returns 404 for a team the caller does not belong to, writing nothing', async () => {
    mockGetUserTeamIds.mockResolvedValue(['other-team']);
    const res = await PUT(putReq({ webhookUrl: 'https://hooks.example.com/x' }), ctx);
    expect(res.status).toBe(404);
    expect(mockSetTeamWebhook).not.toHaveBeenCalled();
  });
});
