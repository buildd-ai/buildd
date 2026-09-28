import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const RULE = 'dddd0000-0000-4000-8000-000000000001';
const RULE_OTHER = 'dddd0000-0000-4000-8000-000000000002';
const RULE_DUP = 'dddd0000-0000-4000-8000-000000000003';
const WS = 'aaaa0000-0000-4000-8000-000000000001';
const WS_T2 = 'aaaa0000-0000-4000-8000-000000000002';
const WS_NONE = 'aaaa0000-0000-4000-8000-000000000009';

const updates: any[] = [];
const deletes: any[] = [];

const row = (over: any = {}) => ({
  id: RULE, userId: 'u-1', workspaceId: null, text: 'Always open PRs as drafts', source: 'chat', sourceMessageId: null,
  createdAt: new Date(), updatedAt: new Date(), ...over,
});

mock.module('@/lib/chat/session', () => ({
  requireChatCaller: async () => ({ caller: { user: { id: 'u-1' }, teamIds: ['t-1'] } }),
}));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: async (_u: string, ws: string) => (ws === WS ? { teamId: 't-1', role: 'member' } : ws === WS_T2 ? { teamId: 't-2', role: 'member' } : null),
}));
mock.module('@/lib/chat/store', () => ({ getOwnConversation: async () => null }));
mock.module('@/lib/chat/directives-store', () => ({
  // The store keys by user: only RULE belongs to u-1; RULE_DUP edits into an existing copy.
  updateDirective: async (userId: string, id: string, patch: any) => {
    updates.push([userId, id, patch]);
    if (id === RULE_DUP) return 'duplicate';
    return userId === 'u-1' && id === RULE ? row(patch) : null;
  },
  deleteDirective: async (userId: string, id: string) => { deletes.push([userId, id]); return userId === 'u-1' && id === RULE; },
  toDirectiveDTO: (r: any) => ({ id: r.id, text: r.text, workspaceId: r.workspaceId }),
}));

const { PATCH, DELETE } = await import('./route');

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) => PATCH(new NextRequest(`http://localhost/api/chat/directives/${id}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), ctx(id));
const del = (id: string) => DELETE(new NextRequest(`http://localhost/api/chat/directives/${id}`, { method: 'DELETE' }), ctx(id));

beforeEach(() => { updates.length = 0; deletes.length = 0; });

describe('PATCH /api/chat/directives/[id]', () => {
  it('edits the caller\'s own rule, keyed by their user id', async () => {
    const res = await patch(RULE, { text: 'Never force-push', workspaceId: WS });
    expect(res.status).toBe(200);
    expect(updates[0]).toEqual(['u-1', RULE, { text: 'Never force-push', workspaceId: WS }]);
  });

  it('back to everywhere with workspaceId null', async () => {
    expect((await patch(RULE, { workspaceId: null })).status).toBe(200);
    expect(updates[0][2]).toEqual({ workspaceId: null });
  });

  it('someone else\'s rule is a 404', async () => {
    expect((await patch(RULE_OTHER, { text: 'x' })).status).toBe(404);
  });

  it('a malformed id is a 404 with no query at all', async () => {
    expect((await patch('d-1', { text: 'x' })).status).toBe(404);
    expect((await del('not-a-uuid')).status).toBe(404);
    expect(updates).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });

  it('an edit into an existing copy is a 409, not a 500', async () => {
    const res = await patch(RULE_DUP, { text: 'Always open PRs as drafts' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('duplicate_rule');
  });

  it('a workspace outside the caller\'s teams, or malformed, is a 404 and changes nothing', async () => {
    expect((await patch(RULE, { workspaceId: WS_T2 })).status).toBe(404);
    expect((await patch(RULE, { workspaceId: WS_NONE })).status).toBe(404);
    expect((await patch(RULE, { workspaceId: 'ws-1' })).status).toBe(404);
    expect(updates).toHaveLength(0);
  });

  it('nothing to change, or bad text: 400', async () => {
    expect((await patch(RULE, {})).status).toBe(400);
    expect((await patch(RULE, { text: '' })).status).toBe(400);
    expect(updates).toHaveLength(0);
  });
});

describe('DELETE /api/chat/directives/[id]', () => {
  it('removes the caller\'s own rule', async () => {
    expect((await del(RULE)).status).toBe(200);
    expect(deletes[0]).toEqual(['u-1', RULE]);
  });

  it('someone else\'s rule is a 404', async () => {
    expect((await del(RULE_OTHER)).status).toBe(404);
  });
});
