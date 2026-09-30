import { afterEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const touched: string[] = [];
const trap = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'now') return () => new Date();
    if (prop === 'deadlineAt') return Date.now() + 60_000;
    if (prop === 'env' || prop === 'then') return undefined;
    return async () => { touched.push(String(prop)); return []; };
  },
});
mock.module('@/lib/chat-retro/deps', () => ({ productionDeps: () => trap }));

const { GET } = await import('./route');
const req = (auth?: string) => new NextRequest('http://localhost/api/cron/chat-retro', { headers: auth ? { authorization: auth } : {} });

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; touched.length = 0; });

describe('GET /api/cron/chat-retro', () => {
  it('requires CRON_SECRET', async () => {
    process.env.CRON_SECRET = 's';
    expect((await GET(req())).status).toBe(401);
    expect(touched).toEqual([]);
  });

  it('CHAT_RETRO_ENABLED=0 is a hard off: no store call at all', async () => {
    process.env.CRON_SECRET = 's';
    process.env.CHAT_RETRO_ENABLED = '0';
    const res = await GET(req('Bearer s'));
    expect(res.status).toBe(200);
    expect((await res.json()).disabled).toBe(true);
    expect(touched).toEqual([]);
  });

  it('unset: runs for opted-in teams (none here, so one lookup)', async () => {
    process.env.CRON_SECRET = 's';
    delete process.env.CHAT_RETRO_ENABLED;
    const res = await GET(req('Bearer s'));
    expect(res.status).toBe(200);
    expect(touched).toEqual(['pruneExpiredLessons', 'listOptedInTeams']);
  });
});
