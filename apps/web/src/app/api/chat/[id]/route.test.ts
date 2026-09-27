import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const own = { id: 'c-1', teamId: 't-1', workspaceId: null, createdByUserId: 'u-1', title: null, archivedAt: null } as any;
// The caller's own conversation in a team they have since left.
const formerTeam = { ...own, id: 'c-left', teamId: 't-left' };
// Started in a workspace that is sensitive now (so it is out of reach).
const inSensitive = { ...own, id: 'c-sens', workspaceId: 'ws-sensitive' };
const inOk = { ...own, id: 'c-ok', workspaceId: 'ws-ok' };
const apiOpts: any[] = [];
const turnCalls: any[] = [];
const titles: Array<[string, string, string]> = [];
const tiers: Array<[string, string | null]> = [];
const pins: Array<[string, string | null]> = [];
mock.module('@/lib/chat/permissions-store', () => ({
  loadAllowedToolGroups: async (teamId: string, userId: string) => new Set(teamId === 't-1' && userId === 'u-1' ? ['tasks'] : []),
}));

mock.module('@/lib/chat/session', () => ({
  requireChatCaller: async () => ({ caller: { user: { id: 'u-1', name: 'Sam', timezone: null }, teamIds: ['t-1'] } }),
  loadTeamChatSettings: async () => ({ timezone: 'Pacific/Auckland', dailyBudgetUsd: null, userDailyBudgetUsd: null }),
  turnUserFor: async () => ({ id: 'u-1', name: 'Sam', timeZone: 'Pacific/Auckland', teamRole: 'member' }),
  workspaceForConversation: async (id: string | null, teamId: string) => (teamId === 't-1' && (id === 'ws-ok' || id === 'ws-sensitive') ? { id, name: id } : null),
  isSensitiveWorkspace: async (id: string) => id === 'ws-sensitive',
  loadRoutableWorkspaces: async () => [{ id: 'ws-ok', name: 'ok' }, { id: 'ws-two', name: 'two' }],
  linkMissionToConversation: async () => {},
  linkedMissionFor: async () => null,
}));
mock.module('@/lib/chat/store', () => ({
  // Conversations are personal: anyone else's id resolves to nothing.
  getOwnConversation: async (id: string, userId: string) =>
    (userId !== 'u-1' ? null : id === 'c-1' ? own : id === 'c-left' ? formerTeam : id === 'c-sens' ? inSensitive : id === 'c-ok' ? inOk : null),
  loadMessages: async () => [],
  loadApprovals: async () => [],
  pingConversation: async () => {},
  setConversationArchived: async () => {},
  setConversationTier: async (id: string, tier: string | null) => { tiers.push([id, tier]); },
  setConversationWorkspace: async (id: string, ws: string | null) => { pins.push([id, ws]); },
  setConversationTitle: async (id: string, t: string, src: string) => { titles.push([id, t, src]); return t.trim() || null; },
  toConversationDTO: (c: any) => ({ id: c.id }),
  toMessageDTO: (m: any) => m,
}));
mock.module('@/lib/chat/turn', () => ({
  runChatTurn: async (args: any) => { turnCalls.push(args); return new Response('stream', { status: 200 }); },
}));
const limitCalls: any[] = [];
mock.module('@/lib/chat/limits', () => ({ checkChatLimits: async (a: any) => { limitCalls.push(a); return { ok: true, budgetWarning: false }; } }));
mock.module('@/lib/chat/in-process-api', () => ({ createInProcessApi: (o: any) => { apiOpts.push(o); return async () => ({}); } }));
mock.module('@/lib/chat/reach', () => ({
  loadChatReach: async (teamId: string) => ({ teamId, workspaceIds: new Set(['ws-ok']), ownerOf: async () => null }),
}));
mock.module('@/lib/chat/auto-title', () => ({ autoTitleConversation: async () => {} }));
mock.module('@/lib/memory-helper', () => ({ getMemoryStoreForTeam: async () => ({ fake: 'store' }) }));
mock.module('@buildd/core/knowledge-store', () => ({ PgVectorStore: class {}, getVoyageEmbedder: () => null, getVoyageReranker: () => null }));

const { GET, PATCH, POST } = await import('./route');

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown) => new NextRequest('http://localhost/api/chat/x', {
  method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
});

beforeEach(() => { turnCalls.length = 0; titles.length = 0; apiOpts.length = 0; tiers.length = 0; pins.length = 0; });

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

  it('POST wires the team\'s budget settings into the limit check', async () => {
    const body = { message: { id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] } };
    await POST(req('POST', body), ctx('c-1'));
    limitCalls.length = 0;
    await turnCalls.at(-1).deps.limits({ teamId: 't-1', userId: 'u-1', now: new Date() });
    expect(limitCalls[0]).toMatchObject({ teamId: 't-1', userId: 'u-1', settings: { timezone: 'Pacific/Auckland', dailyBudgetUsd: null, userDailyBudgetUsd: null } });
  });

  it('404s the caller\'s own conversation in a team they no longer belong to, for every method', async () => {
    expect((await GET(req('GET'), ctx('c-left'))).status).toBe(404);
    expect((await PATCH(req('PATCH', { title: 'x' }), ctx('c-left'))).status).toBe(404);
    const body = { message: { id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] } };
    expect((await POST(req('POST', body), ctx('c-left'))).status).toBe(404);
    expect(turnCalls).toHaveLength(0);
  });

  it('POST bounds the in-process tools to the conversation team\'s reach', async () => {
    const body = { message: { id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] } };
    await POST(req('POST', body), ctx('c-1'));
    turnCalls[0].deps.makeApi(() => {});
    expect(apiOpts[0].reach).toMatchObject({ teamId: 't-1' });
    expect([...apiOpts[0].reach.workspaceIds]).toEqual(['ws-ok']);
  });

  it('each tool call gets only the routes its op declares', async () => {
    const body = { message: { id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] } };
    await POST(req('POST', body), ctx('c-1'));
    const routes = [{ pattern: '/api/tasks', methods: ['GET'] }];
    turnCalls[0].deps.makeApi(() => {}, { routes });
    expect(apiOpts[0].routes).toBe(routes);
  });

  it('a default workspace that is out of reach (marked sensitive) is no default at all', async () => {
    const body = { message: { id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] } };
    await POST(req('POST', body), ctx('c-sens'));
    const d = turnCalls[0].deps;
    expect(d.actionContext.workspaceId).toBeUndefined();
    expect(await d.actionContext.getWorkspaceId()).toBeNull();
    expect(turnCalls[0].workspace).toBeNull();
    // Knowledge reads refuse it too, whether defaulted or named.
    expect(await d.memory(null)).toBeNull();
    expect(await d.memory('ws-sensitive')).toBeNull();
  });

  it('knowledge tools get the team store for an in-reach workspace', async () => {
    const body = { message: { id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] } };
    await POST(req('POST', body), ctx('c-ok'));
    const mem = await turnCalls[0].deps.memory(null);
    expect(mem.ctx).toMatchObject({ workspaceId: 'ws-ok', teamId: 't-1', isSensitive: false });
  });
});

describe('/api/chat/[id]: tier pin and tool permissions', () => {
  it('PATCH { tier } pins the conversation; null unpins; anything else is a 400', async () => {
    expect((await PATCH(req('PATCH', { tier: 'premium' }), ctx('c-1'))).status).toBe(200);
    expect((await PATCH(req('PATCH', { tier: null }), ctx('c-1'))).status).toBe(200);
    expect(tiers).toEqual([['c-1', 'premium'], ['c-1', null]]);
    expect((await PATCH(req('PATCH', { tier: 'claude-opus' }), ctx('c-1'))).status).toBe(400);
    expect(tiers).toHaveLength(2);
  });

  it('a turn carries the caller\'s own allowed tool groups for the conversation team', async () => {
    await POST(req('POST', { message: { id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] } }), ctx('c-1'));
    expect([...turnCalls[0].deps.allowedToolGroups]).toEqual(['tasks']);
  });
});

describe('/api/chat/[id]: workspace scope', () => {
  it('PATCH { workspaceId } pins one of the team\'s workspaces; null means all', async () => {
    expect((await PATCH(req('PATCH', { workspaceId: 'ws-ok' }), ctx('c-1'))).status).toBe(200);
    expect((await PATCH(req('PATCH', { workspaceId: null }), ctx('c-1'))).status).toBe(200);
    expect(pins).toEqual([['c-1', 'ws-ok'], ['c-1', null]]);
  });

  it('refuses a workspace outside the team, or a sensitive one', async () => {
    expect((await PATCH(req('PATCH', { workspaceId: 'ws-other-team' }), ctx('c-1'))).status).toBe(404);
    expect((await PATCH(req('PATCH', { workspaceId: 'ws-sensitive' }), ctx('c-1'))).status).toBe(403);
    expect(pins).toEqual([]);
  });

  it('an unpinned turn is offered the in-reach workspaces to route between', async () => {
    await POST(req('POST', { message: { id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] } }), ctx('c-1'));
    expect(turnCalls[0].workspace).toBeNull();
    expect(turnCalls[0].workspaces.map((w: any) => w.id)).toEqual(['ws-ok', 'ws-two']);
    const scoped = turnCalls[0].deps.scopeFor('ws-ok');
    expect(scoped.actionContext.workspaceId).toBe('ws-ok');
    // Out of reach: no default, whatever was asked.
    expect(turnCalls[0].deps.scopeFor('ws-two').actionContext.workspaceId).toBeUndefined();
  });

  it('a pinned turn is not routed', async () => {
    await POST(req('POST', { message: { id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] } }), ctx('c-ok'));
    expect(turnCalls[0].workspaces).toEqual([]);
  });
});
