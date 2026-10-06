import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const own = { id: 'c-1', teamId: 't-on', createdByUserId: 'u-1' } as any;
const offTeam = { id: 'c-off', teamId: 't-off', createdByUserId: 'u-1' } as any;
const left = { id: 'c-left', teamId: 't-left', createdByUserId: 'u-1' } as any;
const recorded: Array<[string, string, unknown]> = [];

mock.module('@/lib/chat/session', () => ({
  requireChatCaller: async () => ({ caller: { user: { id: 'u-1' }, teamIds: ['t-on', 't-off'] } }),
}));
mock.module('@/lib/chat/store', () => ({
  getOwnConversation: async (id: string, userId: string) => (userId !== 'u-1' ? null : ({ 'c-1': own, 'c-off': offTeam, 'c-left': left } as any)[id] ?? null),
}));
mock.module('@/lib/chat-retro/store', () => ({
  readTeamSettings: async (teamId: string) => ({ lessons: teamId === 't-on', proposals: false }),
}));
mock.module('@/lib/chat/turn-signal-store', () => ({
  recordTurnSignal: async (cid: string, ref: string, signal: unknown) => { recorded.push([cid, ref, signal]); return true; },
}));

const { POST } = await import('./route');
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (id: string, body: unknown, type = 'application/json') => new NextRequest(`http://x.test/api/chat/${id}/turn-signal`, {
  method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const ok = { ref: 'msg_1', signal: { at: 1_790_000_000_000, endMs: 5000, outcome: 'ready' } };

describe('POST /api/chat/[id]/turn-signal', () => {
  beforeEach(() => { recorded.length = 0; delete process.env.CHAT_RETRO_ENABLED; });

  it('records a valid signal on an opted-in team\'s own conversation', async () => {
    const res = await POST(req('c-1', ok), ctx('c-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true });
    expect(recorded).toEqual([['c-1', 'msg_1', ok.signal]]);
  });

  it('accepts a sendBeacon body (text/plain)', async () => {
    const res = await POST(req('c-1', JSON.stringify(ok), 'text/plain;charset=UTF-8'), ctx('c-1'));
    expect(res.status).toBe(200);
    expect(recorded).toHaveLength(1);
  });

  it('refuses any text payload with 400 and records nothing', async () => {
    const res = await POST(req('c-1', { ref: 'msg_1', signal: { text: 'what is stuck?' } }), ctx('c-1'));
    expect(res.status).toBe(400);
    expect(recorded).toEqual([]);
    expect((await POST(req('c-1', 'not json'), ctx('c-1'))).status).toBe(400);
  });

  it('a team without chat retro lessons, or the kill switch: accepted and dropped', async () => {
    expect(await (await POST(req('c-off', ok), ctx('c-off'))).json()).toEqual({ recorded: false });
    process.env.CHAT_RETRO_ENABLED = '0';
    expect(await (await POST(req('c-1', ok), ctx('c-1'))).json()).toEqual({ recorded: false });
    expect(recorded).toEqual([]);
  });

  it('someone else\'s conversation, or one in a team the caller left, is not found', async () => {
    expect((await POST(req('c-nope', ok), ctx('c-nope'))).status).toBe(404);
    expect((await POST(req('c-left', ok), ctx('c-left'))).status).toBe(404);
  });
});
