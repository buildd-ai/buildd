import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let sessionUserId: string | null = 'u-1';
const beats: Array<[string, { visible: boolean; conversationId: string | null; tabId?: string | null }]> = [];
let stored = true;

mock.module('@/auth', () => ({
  auth: async () => (sessionUserId ? { user: { id: sessionUserId } } : null),
}));
mock.module('@/lib/presence', () => ({
  recordBeat: async (userId: string, beat: { visible: boolean; conversationId: string | null; tabId?: string | null }) => {
    beats.push([userId, beat]);
    return { stored };
  },
}));
// The beat path must not touch Postgres: a DB import here would be a Neon wake every 30s per open tab.
mock.module('@buildd/core/db', () => ({ db: new Proxy({}, { get: () => { throw new Error('presence must not query the DB'); } }) }));

const { POST } = await import('./route');

const CONV = '11111111-1111-4111-8111-111111111111';
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/chat/presence', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
}));

beforeEach(() => { sessionUserId = 'u-1'; beats.length = 0; stored = true; });

describe('POST /api/chat/presence', () => {
  it('records a visible beat for the signed-in person', async () => {
    const res = await post({ visible: true, conversationId: CONV, tabId: 'tab-abc123' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stored: true });
    expect(beats).toEqual([['u-1', { visible: true, conversationId: CONV, tabId: 'tab-abc123' }]]);
  });

  it('a malformed tab id is dropped (falls back to the shared member)', async () => {
    await post({ visible: true, tabId: 'x y' });
    expect(beats[0][1].tabId).toBeNull();
  });

  it('a hidden beat is passed through as not visible', async () => {
    await post({ visible: false, conversationId: CONV });
    expect(beats[0][1].visible).toBe(false);
  });

  it('a non-uuid conversation id is dropped, not stored', async () => {
    await post({ visible: true, conversationId: 'not-a-uuid' });
    expect(beats[0][1].conversationId).toBeNull();
  });

  it('401 without a session, and nothing is written', async () => {
    sessionUserId = null;
    expect((await post({ visible: true })).status).toBe(401);
    expect(beats).toEqual([]);
  });

  it('400 on a body without a boolean visible', async () => {
    expect((await post({ conversationId: CONV })).status).toBe(400);
    expect((await post('nope')).status).toBe(400);
  });

  it('reports stored:false when Redis is not configured, still 200', async () => {
    stored = false;
    const res = await post({ visible: true });
    expect(res.status).toBe(200);
    expect((await res.json()).stored).toBe(false);
  });
});
