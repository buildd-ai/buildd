import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: any = { caller: { user: { id: 'u-1' }, teamIds: ['t-1'] } };
let avail: any = { available: true, reason: null, canManageTeamKeys: false };
const agentCalls: string[] = [];

mock.module('@/lib/chat/session', () => ({
  requireChatCaller: async () => caller,
  resolveChatTeam: async (_r: any, _c: any, requested?: string | null) => ((requested ?? 't-1') === 't-1' ? 't-1' : null),
}));
mock.module('@/lib/chat-availability', () => ({ getChatAvailability: async () => avail }));
mock.module('@/lib/chat/chat-page-data', () => ({
  loadTeamChatAgent: async (teamId: string) => { agentCalls.push(teamId); return { name: 'Organizer', color: '#6366F1' }; },
}));

const { GET } = await import('./route');

beforeEach(() => {
  caller = { caller: { user: { id: 'u-1' }, teamIds: ['t-1'] } };
  avail = { available: true, reason: null, canManageTeamKeys: false };
  agentCalls.length = 0;
});

describe('GET /api/chat/canvas', () => {
  it("returns the team's chat agent and the key-admin flag the summoned canvas needs", async () => {
    const res = await GET(new NextRequest('http://localhost/api/chat/canvas'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true, agent: { name: 'Organizer', color: '#6366F1' }, canManageTeamKeys: false });
    expect(agentCalls).toEqual(['t-1']);
  });

  it('says unavailable, without loading the agent, when chat is off for this person', async () => {
    avail = { available: false, reason: 'no_key', canManageTeamKeys: true };
    const res = await GET(new NextRequest('http://localhost/api/chat/canvas'));
    expect(await res.json()).toEqual({ available: false, agent: null, canManageTeamKeys: true });
    expect(agentCalls).toEqual([]);
  });

  it('404s a team the caller is not in; passes an auth failure through', async () => {
    expect((await GET(new NextRequest('http://localhost/api/chat/canvas?teamId=t-x'))).status).toBe(404);
    caller = { response: Response.json({ error: 'Unauthorized' }, { status: 401 }) };
    expect((await GET(new NextRequest('http://localhost/api/chat/canvas'))).status).toBe(401);
  });
});
