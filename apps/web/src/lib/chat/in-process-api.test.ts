import { describe, it, expect } from 'bun:test';
import { NextRequest } from 'next/server';
import { createInProcessApi, matchChatRoute, CHAT_ROUTES } from './in-process-api';

describe('matchChatRoute (the reachable surface)', () => {
  it('matches allowlisted reads and extracts params by folder name', () => {
    expect(matchChatRoute('GET', '/api/tasks/abc')?.params).toEqual({ id: 'abc' });
    expect(matchChatRoute('GET', '/api/workspaces/w/schedules/s')?.params).toEqual({ id: 'w', scheduleId: 's' });
  });

  it('mission creation is the only write reachable', () => {
    const writes = CHAT_ROUTES.flatMap(r => r.methods.filter(m => m !== 'GET').map(m => `${m} ${r.pattern}`));
    expect(writes).toEqual(['POST /api/missions']);
  });

  it('refuses anything else: other methods, other routes', () => {
    expect(matchChatRoute('PATCH', '/api/missions/m1')).toBeNull();
    expect(matchChatRoute('DELETE', '/api/tasks/t1')).toBeNull();
    expect(matchChatRoute('POST', '/api/tasks')).toBeNull();
    expect(matchChatRoute('GET', '/api/secrets')).toBeNull();
    expect(matchChatRoute('GET', '/api/workers/w1')).toBeNull();
  });
});

describe('createInProcessApi', () => {
  const routes = [{
    pattern: '/api/things/:id',
    methods: ['GET'],
    load: async () => ({
      GET: async (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) =>
        Response.json({ id: (await ctx.params).id, q: req.nextUrl.searchParams.get('q'), cookie: req.headers.get('cookie') }),
    }),
  }];

  it('dispatches to the route handler in-process with the caller\'s session cookie', async () => {
    const calls: any[] = [];
    const api = createInProcessApi({
      origin: 'http://localhost:3000',
      headers: new Headers({ cookie: 'session=abc', 'x-other': 'dropped' }),
      onCall: c => calls.push(c),
      routes,
    });
    expect(await api('/api/things/42?q=x')).toEqual({ id: '42', q: 'x', cookie: 'session=abc' });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/things/42', status: 200 });
  });

  it('throws for a route outside the allowlist without loading anything', async () => {
    const api = createInProcessApi({ origin: 'http://localhost', headers: new Headers(), routes });
    await expect(api('/api/things/1', { method: 'DELETE' })).rejects.toThrow('not available from chat');
  });

  it('surfaces a non-2xx the way the HTTP client does', async () => {
    const api = createInProcessApi({
      origin: 'http://localhost', headers: new Headers(),
      routes: [{ pattern: '/api/x', methods: ['GET'], load: async () => ({ GET: async () => Response.json({ error: 'no' }, { status: 403 }) }) }],
    });
    await expect(api('/api/x')).rejects.toThrow('API error: 403');
  });
});
