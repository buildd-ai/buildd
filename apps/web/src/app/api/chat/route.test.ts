import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Model-tier ceilings (docs/specs/model-tier-ceilings.md): the real rule over
// a per-test policy instead of the DB. No ceiling unless a test sets one.
const { resolveTierCeiling: realResolveTierCeiling } = await import('@buildd/shared');
const ceilingTest = { inputs: {} as Record<string, any> };
const fakeCeiling = async (s: any, surface: any) => {
  const userId = typeof s.userId === 'function' ? await s.userId() : s.userId ?? null;
  return realResolveTierCeiling({
    team: ceilingTest.inputs.team ?? null, workspaceId: s.workspaceId ?? null, userId,
    member: userId ? ceilingTest.inputs.members?.[userId] ?? null : null,
  }, surface);
};
mock.module('@buildd/core/model-tier-ceiling-store', () => ({
  loadTierCeiling: fakeCeiling,
  tierCeilingLoader: () => fakeCeiling,
}));


let callerResponse: Response | null = null;
const created: any[] = [];
const listed: any[] = [];

mock.module('@/lib/chat/session', () => ({
  requireChatCaller: async () => (callerResponse ? { response: callerResponse } : { caller: { user: { id: 'u-1' }, teamIds: ['t-1'] } }),
  resolveChatTeam: async (_req: any, caller: any, requested?: string | null) =>
    (requested ?? 't-1') && caller.teamIds.includes(requested ?? 't-1') ? (requested ?? 't-1') : null,
  // A stale settings shape that still says chat is off: POST must not consult it.
  loadTeamChatSettings: async () => ({ chatEnabled: false, timezone: null, dailyBudgetUsd: null }),
  isSensitiveWorkspace: async (ws: string) => ws === 'ws-sensitive',
}));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: async (_u: string, ws: string) => (ws === 'ws-1' || ws === 'ws-sensitive' || ws === 'ws-gated' ? { teamId: 't-1', role: 'member' } : null),
}));
mock.module('@/lib/member-repo-access', () => ({
  assertMemberRepoAccess: async (_u: string | null, ws: string | null) =>
    ws === 'ws-gated' ? Response.json({ error: 'member_repo_access', reason: 'no_github_link' }, { status: 403 }) : null,
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

beforeEach(() => { callerResponse = null; created.length = 0; });

describe('POST /api/chat', () => {
  it('creates a conversation in the caller\'s team', async () => {
    const res = await post({ workspaceId: 'ws-1' });
    expect(res.status).toBe(201);
    expect(created[0]).toMatchObject({ teamId: 't-1', workspaceId: 'ws-1', userId: 'u-1' });
  });

  it('refuses a workspace the member fails the GitHub repo check on', async () => {
    const res = await post({ workspaceId: 'ws-gated' });
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe('no_github_link');
    expect(created).toEqual([]);
  });

  it('chat is always on: there is no team switch that refuses a new conversation', async () => {
    const res = await post({});
    expect(res.status).toBe(201);
    expect(created).toHaveLength(1);
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

  it('pins a valid tier; drops anything else', async () => {
    await post({ tier: 'premium' });
    expect(created[0].tier).toBe('premium');
    await post({ tier: 'gpt-5-turbo' });
    expect(created[1].tier).toBeNull();
  });

  it('a tier above the person\'s ceiling is refused with policy_denied, and nothing is created', async () => {
    ceilingTest.inputs = { team: { membersCapped: true }, members: { 'u-1': { self: { chat: 'standard' } } } };
    try {
      const res = await post({ tier: 'premium' });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toMatchObject({ error: 'policy_denied', maxTier: 'standard', binding: { source: 'member_self' }, requested: { origin: 'chat_pin' } });
      expect(created).toHaveLength(0);
      // Within the ceiling, and auto, still create.
      expect((await post({ tier: 'budget' })).status).toBe(201);
      expect((await post({})).status).toBe(201);
    } finally { ceilingTest.inputs = {}; }
  });

  it('a coding-agent-only cap does not touch chat', async () => {
    ceilingTest.inputs = { team: { team: { agent: 'budget' } } };
    try { expect((await post({ tier: 'premium' })).status).toBe(201); } finally { ceilingTest.inputs = {}; }
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
