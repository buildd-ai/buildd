import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuth = mock(async (..._a: unknown[]) => null as any);
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuth }));
let count = 0;
mock.module('@buildd/core/db', () => ({
  db: { select: () => ({ from: () => ({ where: async () => [{ n: count }] }) }) },
}));
const authorizeChannel = mock((socketId: string, channel: string, data: any) => ({ auth: `k:sig:${socketId}:${channel}`, channel_data: JSON.stringify(data) }));
mock.module('@/lib/pusher', () => ({
  getPusher: () => ({ authorizeChannel }),
  channels: { runnerPresence: (id: string) => `presence-runner-${id}` },
}));

import { POST } from './route';

const ACCT = '11111111-1111-4111-8111-111111111111';
function req(channel: string, extra: Record<string, string> = {}) {
  const body = new URLSearchParams({ socket_id: '1.2', channel_name: channel, ...extra });
  return new NextRequest('http://localhost/api/pusher/auth', {
    method: 'POST',
    headers: { authorization: 'Bearer bld_x', 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

beforeEach(() => { mockAuth.mockReset(); authorizeChannel.mockClear(); count = 0; mockAuth.mockResolvedValue({ id: ACCT }); });

describe('POST /api/pusher/auth', () => {
  it('401 without a valid key', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await POST(req(`presence-runner-${ACCT}`, { local_ui_url: 'u' }))).status).toBe(401);
  });
  it('signs the caller account presence channel with user_id = localUiUrl', async () => {
    const res = await POST(req(`presence-runner-${ACCT}`, { local_ui_url: 'headless://h' }));
    expect(res.status).toBe(200);
    expect(authorizeChannel.mock.calls[0][2]).toEqual({ user_id: 'headless://h' });
  });
  it('403 for another account\'s presence channel', async () => {
    const res = await POST(req('presence-runner-22222222-2222-4222-8222-222222222222', { local_ui_url: 'u' }));
    expect(res.status).toBe(403);
    expect(authorizeChannel).not.toHaveBeenCalled();
  });
  it('403 for any other channel', async () => {
    expect((await POST(req(`runner-${ACCT}`, { local_ui_url: 'u' }))).status).toBe(403);
    expect((await POST(req(`private-x`, { local_ui_url: 'u' }))).status).toBe(403);
    expect(authorizeChannel).not.toHaveBeenCalled();
  });
  it('403 beyond the runner cap', async () => {
    count = 1000;
    expect((await POST(req(`presence-runner-${ACCT}`, { local_ui_url: 'u' }))).status).toBe(403);
  });
  it('400 without local_ui_url', async () => {
    expect((await POST(req(`presence-runner-${ACCT}`))).status).toBe(400);
  });
});
