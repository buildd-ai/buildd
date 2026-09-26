import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let chatEnabled = true;
let callerResponse: Response | null = null;
const created: any[] = [];
const listed: any[] = [];

mock.module('@/lib/chat/session', () => ({
  requireChatCaller: async () => (callerResponse ? { response: callerResponse } : { caller: { user: { id: 'u-1' }, teamIds: ['t-1'] } }),
  resolveChatTeam: async (_req: any, caller: any, requested?: string | null) =>
    (requested ?? 't-1') && caller.teamIds.includes(requested ?? 't-1') ? (requested ?? 't-1') : null,
  loadTeamChatSettings: async () => ({ chatEnabled, timezone: null, dailyBudgetUsd: null }),
  isSensitiveWorkspace: async (ws: string) => ws === 'ws-sensitive',
}));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: async (_u: string, ws: string) => (ws === 'ws-1' || ws === 'ws-sensitive' ? { teamId: 't-1', role: 'member' } : null),
}));
mock.module('@/lib/chat/store', () => ({
  createConversation: async (input: any) => {
    const row = { id: 'c-1', ...input, createdByUserId: input.userId, title: null, titleSource: 'auto', agentRoleSlug: 'organizer', lastMessageAt: new Date(), archivedAt: null, createdAt: new Date() };
    created.push(row);
    return row;
  },
  listConversations: async (...args: any[]) => { listed.push(args); return { conversations: [], nextCursor: null }; },
  toConversationDTO: (c: any) => ({ id: c.id, teamId: c.teamId, workspaceId: c.workspaceId, title: 'New conversation' }),
}));

const { GET, POST } = await import('./route');

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/chat', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

beforeEach(() => { chatEnabled = true; callerResponse = null; created.length = 0; });

describe('POST /api/chat', () => {
  it('creates a conversation in the caller\'s team', async () => {
    const res = await post({ workspaceId: 'ws-1' });
    expect(res.status).toBe(201);
    expect(created[0]).toMatchObject({ teamId: 't-1', workspaceId: 'ws-1', userId: 'u-1' });
  });

  it('refuses when the team has chat off — nothing is created', async () => {
    chatEnabled = false;
    const res = await post({});
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('capability_disabled');
    expect(created).toHaveLength(0);
  });

  it('404s a workspace the caller cannot reach, or a team they are not in', async () => {
    expect((await post({ workspaceId: 'ws-other' })).status).toBe(404);
    expect((await post({ teamId: 't-other' })).status).toBe(404);
    expect(created).toHaveLength(0);
  });

  it('refuses a sensitive workspace as the default scope', async () => {
    const res = await post({ workspaceId: 'ws-sensitive' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('sensitive_workspace');
    expect(created).toHaveLength(0);
  });

  it('refuses without a session', async () => {
    callerResponse = new Response('{}', { status: 401 });
    expect((await post({})).status).toBe(401);
  });
});

describe('GET /api/chat', () => {
  it('lists the caller\'s conversations', async () => {
    const res = await GET(new NextRequest('http://localhost/api/chat'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversations: [], nextCursor: null });
  });

  it('lists only conversations in teams the caller still belongs to', async () => {
    listed.length = 0;
    await GET(new NextRequest('http://localhost/api/chat'));
    expect(listed[0][0]).toBe('u-1');
    expect(listed[0][1].teamIds).toEqual(['t-1']);
  });

  it('rejects a malformed cursor', async () => {
    expect((await GET(new NextRequest('http://localhost/api/chat?cursor=nope'))).status).toBe(400);
  });
});
