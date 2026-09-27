import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let sessionUser: { id: string } | null = { id: 'u-1' };
const calls: Array<[string, ...unknown[]]> = [];
let setResult: unknown = { ok: true, key: { id: 'k', last4: 'Ab12', health: 'healthy', lastVerifiedAt: null, lastVerificationError: null } };

mock.module('@/lib/auth-helpers', () => ({
  requireSessionUser: async () => (sessionUser ? { user: sessionUser } : { response: Response.json({ error: 'Unauthorized' }, { status: 401 }) }),
}));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async () => ['t-1'],
  resolveActiveTeamId: async () => 't-1',
}));
mock.module('@/lib/personal-pushover', () => ({
  getPersonalPushover: async (userId: string, teamId: string) => { calls.push(['get', userId, teamId]); return null; },
  setPersonalPushover: async (input: unknown) => { calls.push(['set', input]); return setResult; },
  deletePersonalPushover: async (userId: string, teamId: string) => { calls.push(['delete', userId, teamId]); return true; },
  testPersonalPushover: async (userId: string, teamId: string) => { calls.push(['test', userId, teamId]); return { ok: true, error: null }; },
}));

const { GET, PUT, DELETE } = await import('./route');
const { POST } = await import('./test/route');

const req = (url: string, init?: RequestInit) => new NextRequest(`http://localhost${url}`, init as never);
const put = (body: unknown) => PUT(req('/api/me/pushover', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

beforeEach(() => { sessionUser = { id: 'u-1' }; calls.length = 0; });

describe('/api/me/pushover', () => {
  it('GET returns only the caller\'s own key', async () => {
    const res = await GET(req('/api/me/pushover'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: null });
    expect(calls).toEqual([['get', 'u-1', 't-1']]);
  });

  it('PUT stores the key for the caller in their team', async () => {
    const res = await put({ value: 'uAbc' });
    expect(res.status).toBe(200);
    expect(calls).toEqual([['set', { userId: 'u-1', teamId: 't-1', value: 'uAbc' }]]);
  });

  it('PUT passes a refusal through with its status', async () => {
    setResult = { ok: false, status: 400, error: 'A Pushover user key is 30 letters and digits.' };
    const res = await put({ value: 'short' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('30 letters');
    setResult = { ok: true, key: {} };
  });

  it('PUT needs a value', async () => {
    expect((await put({})).status).toBe(400);
  });

  it('a team the caller is not in is 404', async () => {
    expect((await GET(req('/api/me/pushover?teamId=t-other'))).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('DELETE removes the caller\'s own key', async () => {
    const res = await DELETE(req('/api/me/pushover', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(calls).toEqual([['delete', 'u-1', 't-1']]);
  });

  it('POST /test sends a test push to the caller\'s own key', async () => {
    const res = await POST(req('/api/me/pushover/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect(await res.json()).toEqual({ ok: true, error: null });
    expect(calls).toEqual([['test', 'u-1', 't-1']]);
  });

  it('401 without a session', async () => {
    sessionUser = null;
    expect((await GET(req('/api/me/pushover'))).status).toBe(401);
    expect((await put({ value: 'x' })).status).toBe(401);
  });
});
