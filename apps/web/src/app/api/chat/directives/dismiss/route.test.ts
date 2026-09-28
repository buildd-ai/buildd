import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const marked: any[] = [];

mock.module('@/lib/chat/session', () => ({
  requireChatCaller: async () => ({ caller: { user: { id: 'u-1' }, teamIds: ['t-1'] } }),
}));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: async () => null }));
mock.module('@/lib/chat/store', () => ({
  getOwnConversation: async (id: string, userId: string) => (id === 'c-1' && userId === 'u-1' ? { id, teamId: 't-1' } : null),
}));
mock.module('@/lib/chat/directives-store', () => ({
  markDirectiveCard: async (...args: any[]) => { marked.push(args); return args[1] === 'm-1'; },
}));

const { POST } = await import('./route');

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/chat/directives/dismiss', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

beforeEach(() => { marked.length = 0; });

describe('POST /api/chat/directives/dismiss', () => {
  it('marks the card on the caller\'s own conversation dismissed', async () => {
    expect((await post({ conversationId: 'c-1', messageId: 'm-1' })).status).toBe(200);
    expect(marked[0]).toEqual(['c-1', 'm-1', { status: 'dismissed' }]);
  });

  it('someone else\'s conversation: 404, nothing marked', async () => {
    expect((await post({ conversationId: 'c-2', messageId: 'm-1' })).status).toBe(404);
    expect(marked).toHaveLength(0);
  });

  it('a message with no card: 404', async () => {
    expect((await post({ conversationId: 'c-1', messageId: 'm-none' })).status).toBe(404);
  });

  it('missing ids: 400', async () => {
    expect((await post({})).status).toBe(400);
  });
});
