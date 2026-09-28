import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const updates: any[] = [];
const deletes: any[] = [];

const row = (over: any = {}) => ({
  id: 'd-1', userId: 'u-1', workspaceId: null, text: 'Always open PRs as drafts', source: 'chat', sourceMessageId: null,
  createdAt: new Date(), updatedAt: new Date(), ...over,
});

mock.module('@/lib/chat/session', () => ({
  requireChatCaller: async () => ({ caller: { user: { id: 'u-1' }, teamIds: ['t-1'] } }),
}));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: async (_u: string, ws: string) => (ws === 'ws-1' ? { teamId: 't-1', role: 'member' } : ws === 'ws-t2' ? { teamId: 't-2', role: 'member' } : null),
}));
mock.module('@/lib/chat/store', () => ({ getOwnConversation: async () => null }));
mock.module('@/lib/chat/directives-store', () => ({
  // The store keys by user: only d-1 belongs to u-1.
  updateDirective: async (userId: string, id: string, patch: any) => {
    updates.push([userId, id, patch]);
    return userId === 'u-1' && id === 'd-1' ? row(patch) : null;
  },
  deleteDirective: async (userId: string, id: string) => { deletes.push([userId, id]); return userId === 'u-1' && id === 'd-1'; },
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
    const res = await patch('d-1', { text: 'Never force-push', workspaceId: 'ws-1' });
    expect(res.status).toBe(200);
    expect(updates[0]).toEqual(['u-1', 'd-1', { text: 'Never force-push', workspaceId: 'ws-1' }]);
  });

  it('back to everywhere with workspaceId null', async () => {
    expect((await patch('d-1', { workspaceId: null })).status).toBe(200);
    expect(updates[0][2]).toEqual({ workspaceId: null });
  });

  it('someone else\'s rule is a 404', async () => {
    expect((await patch('d-other', { text: 'x' })).status).toBe(404);
  });

  it('a workspace outside the caller\'s teams is a 404 and changes nothing', async () => {
    expect((await patch('d-1', { workspaceId: 'ws-t2' })).status).toBe(404);
    expect((await patch('d-1', { workspaceId: 'ws-none' })).status).toBe(404);
    expect(updates).toHaveLength(0);
  });

  it('nothing to change, or bad text: 400', async () => {
    expect((await patch('d-1', {})).status).toBe(400);
    expect((await patch('d-1', { text: '' })).status).toBe(400);
    expect(updates).toHaveLength(0);
  });
});

describe('DELETE /api/chat/directives/[id]', () => {
  it('removes the caller\'s own rule', async () => {
    expect((await del('d-1')).status).toBe(200);
    expect(deletes[0]).toEqual(['u-1', 'd-1']);
  });

  it('someone else\'s rule is a 404', async () => {
    expect((await del('d-other')).status).toBe(404);
  });
});
