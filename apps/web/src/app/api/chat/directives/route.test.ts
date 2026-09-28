import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const WS = 'aaaa0000-0000-4000-8000-000000000001';
const WS_OTHER = 'aaaa0000-0000-4000-8000-000000000002';
const WS_LEFT = 'aaaa0000-0000-4000-8000-000000000003';
const CONV = 'cccc0000-0000-4000-8000-000000000001';
const CONV_OTHER = 'cccc0000-0000-4000-8000-000000000002';
const CONV_LEFT_TEAM = 'cccc0000-0000-4000-8000-000000000003';
const MSG = 'eeee0000-0000-4000-8000-000000000001';
const MSG_NO_CARD = 'eeee0000-0000-4000-8000-000000000002';

let callerResponse: Response | null = null;
const created: any[] = [];
const marked: any[] = [];
let existing: any = null;
let atLimit = false;
let card: any = null;

const row = (over: any = {}) => ({
  id: 'd-1', userId: 'u-1', workspaceId: null, text: 'Always open PRs as drafts', source: 'chat', sourceMessageId: null,
  createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-01T00:00:00Z'), ...over,
});

mock.module('@/lib/chat/session', () => ({
  requireChatCaller: async () => (callerResponse ? { response: callerResponse } : { caller: { user: { id: 'u-1' }, teamIds: ['t-1'] } }),
}));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: async (_u: string, ws: string) => (ws === WS ? { teamId: 't-1', role: 'member' } : null),
  getUserWorkspaceIds: async () => [WS],
}));
mock.module('@/lib/chat/store', () => ({
  getOwnConversation: async (id: string, userId: string) => (id === CONV && userId === 'u-1' ? { id, teamId: 't-1' } : id === CONV_LEFT_TEAM ? { id, teamId: 't-left' } : null),
}));
mock.module('@/lib/chat/directives-store', () => ({
  listDirectives: async (userId: string) => (userId === 'u-1' ? [
    { row: row(), workspaceName: null },
    { row: row({ id: 'd-2', workspaceId: WS }), workspaceName: 'billing-web' },
    { row: row({ id: 'd-3', workspaceId: WS_LEFT }), workspaceName: 'someone-elses' },
  ] : []),
  listScopableWorkspaces: async () => [{ id: WS, name: 'billing-web' }],
  createDirective: async (input: any) => {
    if (atLimit) return { ok: false, reason: 'limit' };
    if (existing) return { ok: true, row: existing, existed: true };
    created.push(input);
    return { ok: true, row: row({ text: input.text, workspaceId: input.workspaceId, source: input.source }), existed: false };
  },
  loadDirectiveCard: async (conversationId: string, messageId: string) => (conversationId === CONV && messageId === MSG ? card : null),
  markDirectiveCard: async (...args: any[]) => { marked.push(args); return true; },
  toDirectiveDTO: (r: any, name: string | null) => ({ id: r.id, text: r.text, workspaceId: r.workspaceId, workspaceName: name, source: r.source }),
}));

const { GET, POST } = await import('./route');

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/chat/directives', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

beforeEach(() => {
  callerResponse = null; created.length = 0; marked.length = 0; existing = null; atLimit = false;
  card = { conversationId: CONV, text: 'Always open PRs as drafts', suggestedScope: 'workspace', workspace: { id: WS, name: 'billing-web' }, source: 'jev' };
});

describe('GET /api/chat/directives', () => {
  it('lists the caller\'s own rules and the workspaces they can scope to', async () => {
    const res = await GET(new NextRequest('http://localhost/api/chat/directives'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.directives.map((d: any) => d.id)).toEqual(['d-1', 'd-2', 'd-3']);
    expect(body.workspaces).toEqual([{ id: WS, name: 'billing-web' }]);
  });

  it('does not name a workspace the caller can no longer reach', async () => {
    const body = await (await GET(new NextRequest('http://localhost/api/chat/directives'))).json();
    expect(body.directives.find((d: any) => d.id === 'd-3').workspaceName).toBeNull();
    expect(body.directives.find((d: any) => d.id === 'd-2').workspaceName).toBe('billing-web');
  });

  it('needs a session', async () => {
    callerResponse = Response.json({ error: 'Unauthorized' }, { status: 401 });
    expect((await GET(new NextRequest('http://localhost/api/chat/directives'))).status).toBe(401);
  });
});

describe('POST /api/chat/directives', () => {
  it('saves an everywhere rule for the caller', async () => {
    const res = await post({ text: '  Always open PRs\nas drafts ' });
    expect(res.status).toBe(201);
    expect(created[0]).toMatchObject({ userId: 'u-1', text: 'Always open PRs as drafts', workspaceId: null, source: 'settings' });
  });

  it('a workspace rule needs access to the workspace', async () => {
    expect((await post({ text: 'Run the smoke test', workspaceId: WS })).status).toBe(201);
    expect((await post({ text: 'Run the smoke test', workspaceId: WS_OTHER })).status).toBe(404);
    expect(created).toHaveLength(1);
  });

  it('a malformed workspace id is a 404, never a query (so never a 500)', async () => {
    expect((await post({ text: 'x', workspaceId: 'ws-1' })).status).toBe(404);
    expect((await post({ text: 'x', workspaceId: 42 })).status).toBe(400);
    expect(created).toHaveLength(0);
  });

  it('rejects empty, non-string or over-long text', async () => {
    expect((await post({ text: '   ' })).status).toBe(400);
    expect((await post({ text: 42 })).status).toBe(400);
    expect((await post({ text: 'x'.repeat(281) })).status).toBe(400);
    expect(created).toHaveLength(0);
  });

  it('from a card: saves what it proposed and answers that card', async () => {
    const res = await post({ text: 'Always open PRs as drafts', workspaceId: WS, from: { conversationId: CONV, messageId: MSG } });
    expect(res.status).toBe(201);
    expect(created[0]).toMatchObject({ source: 'chat', sourceMessageId: MSG, workspaceId: WS });
    expect(marked[0]).toEqual([CONV, MSG, { status: 'saved', directiveId: 'd-1', savedScope: 'workspace' }]);
  });

  it('from a card, but not the text it proposed: 400, nothing saved', async () => {
    const res = await post({ text: 'Always merge without review', from: { conversationId: CONV, messageId: MSG } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('text_mismatch');
    expect(created).toHaveLength(0);
    expect(marked).toHaveLength(0);
  });

  it('from a card, in a workspace it did not offer: 400', async () => {
    card = { ...card, workspace: null };
    const res = await post({ text: 'Always open PRs as drafts', workspaceId: WS, from: { conversationId: CONV, messageId: MSG } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('scope_mismatch');
  });

  it('a message with no card saves as an ordinary rule and answers nothing', async () => {
    const res = await post({ text: 'Always open PRs as drafts', from: { conversationId: CONV, messageId: MSG_NO_CARD } });
    expect(res.status).toBe(201);
    expect(created[0]).toMatchObject({ source: 'settings', sourceMessageId: null });
    expect(marked).toHaveLength(0);
  });

  it('from someone else\'s conversation, a team they left, or malformed ids: 404/400 and nothing saved', async () => {
    expect((await post({ text: 'x rule', from: { conversationId: CONV_OTHER, messageId: MSG } })).status).toBe(404);
    expect((await post({ text: 'x rule', from: { conversationId: CONV_LEFT_TEAM, messageId: MSG } })).status).toBe(404);
    expect((await post({ text: 'x rule', from: { conversationId: 'c-1', messageId: MSG } })).status).toBe(404);
    expect((await post({ text: 'x rule', from: { conversationId: CONV, messageId: 'm-1' } })).status).toBe(404);
    expect((await post({ text: 'x rule', from: { conversationId: CONV } })).status).toBe(400);
    expect(created).toHaveLength(0);
    expect(marked).toHaveLength(0);
  });

  it('the same rule twice returns the first, 200', async () => {
    existing = row();
    const res = await post({ text: 'Always open PRs as drafts' });
    expect(res.status).toBe(200);
    expect((await res.json()).existed).toBe(true);
  });

  it('at the cap: 409 with a plain reason', async () => {
    atLimit = true;
    const res = await post({ text: 'One more rule' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('directive_limit');
  });
});
