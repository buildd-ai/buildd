import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let callerResponse: Response | null = null;
const created: any[] = [];
const marked: any[] = [];
let existing: any = null;
let atLimit = false;

const row = (over: any = {}) => ({
  id: 'd-1', userId: 'u-1', workspaceId: null, text: 'Always open PRs as drafts', source: 'chat', sourceMessageId: null,
  createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-01T00:00:00Z'), ...over,
});

mock.module('@/lib/chat/session', () => ({
  requireChatCaller: async () => (callerResponse ? { response: callerResponse } : { caller: { user: { id: 'u-1' }, teamIds: ['t-1'] } }),
}));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: async (_u: string, ws: string) => (ws === 'ws-1' ? { teamId: 't-1', role: 'member' } : null),
  getUserWorkspaceIds: async () => ['ws-1'],
}));
mock.module('@/lib/chat/store', () => ({
  getOwnConversation: async (id: string, userId: string) => (id === 'c-1' && userId === 'u-1' ? { id: 'c-1', teamId: 't-1' } : id === 'c-gone-team' ? { id, teamId: 't-left' } : null),
}));
mock.module('@/lib/chat/directives-store', () => ({
  listDirectives: async (userId: string) => (userId === 'u-1' ? [
    { row: row(), workspaceName: null },
    { row: row({ id: 'd-2', workspaceId: 'ws-1' }), workspaceName: 'billing-web' },
    { row: row({ id: 'd-3', workspaceId: 'ws-left' }), workspaceName: 'someone-elses' },
  ] : []),
  listScopableWorkspaces: async () => [{ id: 'ws-1', name: 'billing-web' }],
  createDirective: async (input: any) => {
    if (atLimit) return { ok: false, reason: 'limit' };
    if (existing) return { ok: true, row: existing, existed: true };
    created.push(input);
    return { ok: true, row: row({ text: input.text, workspaceId: input.workspaceId, source: input.source }), existed: false };
  },
  markDirectiveCard: async (...args: any[]) => { marked.push(args); return true; },
  toDirectiveDTO: (r: any, name: string | null) => ({ id: r.id, text: r.text, workspaceId: r.workspaceId, workspaceName: name, source: r.source }),
}));

const { GET, POST } = await import('./route');

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/chat/directives', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

beforeEach(() => { callerResponse = null; created.length = 0; marked.length = 0; existing = null; atLimit = false; });

describe('GET /api/chat/directives', () => {
  it('lists the caller\'s own rules and the workspaces they can scope to', async () => {
    const res = await GET(new NextRequest('http://localhost/api/chat/directives'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.directives.map((d: any) => d.id)).toEqual(['d-1', 'd-2', 'd-3']);
    expect(body.workspaces).toEqual([{ id: 'ws-1', name: 'billing-web' }]);
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
    expect((await post({ text: 'Run the smoke test', workspaceId: 'ws-1' })).status).toBe(201);
    expect((await post({ text: 'Run the smoke test', workspaceId: 'ws-other' })).status).toBe(404);
    expect(created).toHaveLength(1);
  });

  it('rejects empty, non-string or over-long text', async () => {
    expect((await post({ text: '   ' })).status).toBe(400);
    expect((await post({ text: 42 })).status).toBe(400);
    expect((await post({ text: 'x'.repeat(281) })).status).toBe(400);
    expect(created).toHaveLength(0);
  });

  it('from a card: answers that card on the caller\'s own conversation', async () => {
    const res = await post({ text: 'Always open PRs as drafts', from: { conversationId: 'c-1', messageId: 'm-1' } });
    expect(res.status).toBe(201);
    expect(created[0]).toMatchObject({ source: 'chat', sourceMessageId: 'm-1' });
    expect(marked[0]).toEqual(['c-1', 'm-1', { status: 'saved', directiveId: 'd-1', savedScope: 'everywhere' }]);
  });

  it('from someone else\'s conversation, or a team they left: 404 and nothing saved', async () => {
    expect((await post({ text: 'x rule', from: { conversationId: 'c-other', messageId: 'm-1' } })).status).toBe(404);
    expect((await post({ text: 'x rule', from: { conversationId: 'c-gone-team', messageId: 'm-1' } })).status).toBe(404);
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
