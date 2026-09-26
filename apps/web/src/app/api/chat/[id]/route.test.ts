import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const own = { id: 'c-1', teamId: 't-1', workspaceId: null, createdByUserId: 'u-1', title: null, archivedAt: null } as any;
const turnCalls: any[] = [];
const titles: Array<[string, string, string]> = [];

mock.module('@/lib/chat/session', () => ({
  requireChatCaller: async () => ({ caller: { user: { id: 'u-1', name: 'Sam', timezone: null }, teamIds: ['t-1'] } }),
  loadTeamChatSettings: async () => ({ chatEnabled: true, timezone: 'Pacific/Auckland', dailyBudgetUsd: null }),
  turnUserFor: async () => ({ id: 'u-1', name: 'Sam', timeZone: 'Pacific/Auckland', teamRole: 'member' }),
  workspaceForConversation: async () => null,
  linkMissionToConversation: async () => {},
}));
mock.module('@/lib/chat/store', () => ({
  // Conversations are personal: anyone else's id resolves to nothing.
  getOwnConversation: async (id: string, userId: string) => (id === 'c-1' && userId === 'u-1' ? own : null),
  loadMessages: async () => [],
  loadApprovals: async () => [],
  pingConversation: async () => {},
  setConversationArchived: async () => {},
  setConversationTitle: async (id: string, t: string, src: string) => { titles.push([id, t, src]); return t.trim() || null; },
  toConversationDTO: (c: any) => ({ id: c.id }),
  toMessageDTO: (m: any) => m,
}));
mock.module('@/lib/chat/turn', () => ({
  runChatTurn: async (args: any) => { turnCalls.push(args); return new Response('stream', { status: 200 }); },
}));
mock.module('@/lib/chat/limits', () => ({ evaluateLimits: () => ({ ok: true }), loadLimitInputs: async () => ({}) }));
mock.module('@/lib/chat/in-process-api', () => ({ createInProcessApi: () => async () => ({}) }));
mock.module('@/lib/chat/auto-title', () => ({ autoTitleConversation: async () => {} }));

const { GET, PATCH, POST } = await import('./route');

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown) => new NextRequest('http://localhost/api/chat/x', {
  method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
});

beforeEach(() => { turnCalls.length = 0; titles.length = 0; });

describe('/api/chat/[id]', () => {
  it('404s a conversation that is not the caller\'s, for every method', async () => {
    expect((await GET(req('GET'), ctx('c-other'))).status).toBe(404);
    expect((await PATCH(req('PATCH', { title: 'x' }), ctx('c-other'))).status).toBe(404);
    expect((await POST(req('POST', { message: { id: 'm', role: 'user', parts: [] } }), ctx('c-other'))).status).toBe(404);
    expect(turnCalls).toHaveLength(0);
  });

  it('GET returns the conversation with messages and approvals', async () => {
    const res = await GET(req('GET'), ctx('c-1'));
    expect(await res.json()).toEqual({ conversation: { id: 'c-1' }, messages: [], approvals: [] });
  });

  it('PATCH renames as a user title', async () => {
    const res = await PATCH(req('PATCH', { title: 'Billing currency' }), ctx('c-1'));
    expect(res.status).toBe(200);
    expect(titles).toEqual([['c-1', 'Billing currency', 'user']]);
  });

  it('POST hands the turn to runChatTurn with the caller as the user and in-process tools', async () => {
    const body = { message: { id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] } };
    const res = await POST(req('POST', body), ctx('c-1'));
    expect(res.status).toBe(200);
    expect(turnCalls[0].user).toMatchObject({ id: 'u-1', timeZone: 'Pacific/Auckland' });
    expect(turnCalls[0].body).toEqual(body);
    expect(await turnCalls[0].deps.actionContext.getLevel()).toBe('admin');
    expect(turnCalls[0].deps.actionContext.authType).toBe('oauth');
  });
});
