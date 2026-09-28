import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const CONV = 'cccc0000-0000-4000-8000-000000000001';
const CONV_OTHER = 'cccc0000-0000-4000-8000-000000000002';
const MSG = 'eeee0000-0000-4000-8000-000000000001';
const MSG_NONE = 'eeee0000-0000-4000-8000-000000000002';

const marked: any[] = [];
const convLookups: string[] = [];

mock.module('@/lib/chat/session', () => ({
  requireChatCaller: async () => ({ caller: { user: { id: 'u-1' }, teamIds: ['t-1'] } }),
}));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: async () => null }));
mock.module('@/lib/chat/store', () => ({
  getOwnConversation: async (id: string, userId: string) => { convLookups.push(id); return id === CONV && userId === 'u-1' ? { id, teamId: 't-1' } : null; },
}));
mock.module('@/lib/chat/directives-store', () => ({
  markDirectiveCard: async (...args: any[]) => { marked.push(args); return args[1] === MSG; },
}));

const { POST } = await import('./route');

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/chat/directives/dismiss', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

beforeEach(() => { marked.length = 0; convLookups.length = 0; });

describe('POST /api/chat/directives/dismiss', () => {
  it('marks the card on the caller\'s own conversation dismissed', async () => {
    expect((await post({ conversationId: CONV, messageId: MSG })).status).toBe(200);
    expect(marked[0]).toEqual([CONV, MSG, { status: 'dismissed' }]);
  });

  it('someone else\'s conversation: 404, nothing marked', async () => {
    expect((await post({ conversationId: CONV_OTHER, messageId: MSG })).status).toBe(404);
    expect(marked).toHaveLength(0);
  });

  it('a message with no card: 404', async () => {
    expect((await post({ conversationId: CONV, messageId: MSG_NONE })).status).toBe(404);
  });

  it('malformed ids: 404 before any lookup; missing ids: 400', async () => {
    expect((await post({ conversationId: CONV, messageId: 'm-1' })).status).toBe(404);
    expect((await post({ conversationId: 'c-1', messageId: MSG })).status).toBe(404);
    expect(convLookups).toHaveLength(0);
    expect(marked).toHaveLength(0);
    expect((await post({})).status).toBe(400);
  });
});
