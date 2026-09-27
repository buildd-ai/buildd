import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const own = { id: 'c-1', teamId: 't-1', createdByUserId: 'u-1', archivedAt: null } as any;
const drains: any[] = [];
mock.module('@/lib/chat/session', () => ({
  requireChatCaller: async () => ({ caller: { user: { id: 'u-1' }, teamIds: ['t-1'] } }),
}));
mock.module('@/lib/chat/store', () => ({
  getOwnConversation: async (id: string, userId: string) => (userId === 'u-1' && id === 'c-1' ? own : id === 'c-left' ? { ...own, id, teamId: 't-left' } : null),
}));
mock.module('@/lib/chat/watch-delivery', () => ({
  deliverWatchesToConversation: async (t: any) => { drains.push(t); return { delivered: 2 }; },
}));

const { POST } = await import('./route');
const call = (id: string) => POST(new NextRequest(`http://localhost/api/chat/${id}/deliveries`, { method: 'POST' }), { params: Promise.resolve({ id }) });

describe('POST /api/chat/[id]/deliveries', () => {
  beforeEach(() => { drains.length = 0; });

  it('drains the caller\'s own fired watches for this conversation', async () => {
    const res = await call('c-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ delivered: 2 });
    expect(drains).toEqual([{ userId: 'u-1', conversationId: 'c-1' }]);
  });

  it('someone else\'s conversation, or one in a team the caller left, is not found and drains nothing', async () => {
    expect((await call('c-other')).status).toBe(404);
    expect((await call('c-left')).status).toBe(404);
    expect(drains).toEqual([]);
  });
});
