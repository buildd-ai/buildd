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

describe('createInProcessApi — chat reach (the conversation\'s team, standard workspaces only)', () => {
  const seen: Array<{ path: string; query: Record<string, string>; body: unknown }> = [];
  const echo = (payload: (req: NextRequest, params: Record<string, string>) => unknown) => async () => ({
    GET: async (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => {
      const params = await ctx.params;
      seen.push({ path: req.nextUrl.pathname, query: Object.fromEntries(req.nextUrl.searchParams), body: null });
      return Response.json(payload(req, params));
    },
    POST: async (req: NextRequest) => {
      const body = await req.json();
      seen.push({ path: req.nextUrl.pathname, query: {}, body });
      return Response.json({ id: 'm-new', ...body });
    },
  });
  const routes = [
    { pattern: '/api/tasks', methods: ['GET'], load: echo(() => ({ tasks: [
      { id: 't-a', workspaceId: 'ws-ok', title: 'fine' },
      { id: 't-b', workspaceId: 'ws-sensitive', title: 'secret' },
      { id: 't-c', workspaceId: 'ws-other-team', title: 'elsewhere' },
    ] })) },
    { pattern: '/api/tasks/:id', methods: ['GET'], load: echo((_r, p) => ({ id: p.id, workspaceId: 'ws-ok' })) },
    { pattern: '/api/missions', methods: ['GET', 'POST'], load: echo(() => ({ missions: [
      { id: 'm-a', teamId: 't-1', workspaceId: null },
      { id: 'm-b', teamId: 't-2', workspaceId: null },
    ] })) },
    { pattern: '/api/missions/:id', methods: ['GET'], load: echo((_r, p) => ({ id: p.id })) },
    { pattern: '/api/workspaces', methods: ['GET'], load: echo(() => ({ workspaces: [
      { id: 'ws-ok', name: 'ok' }, { id: 'ws-sensitive', name: 's' }, { id: 'ws-other-team', name: 'o' },
    ] })) },
    { pattern: '/api/workspaces/:id/artifacts', methods: ['GET'], load: echo(() => ({ artifacts: [] })) },
  ];
  const owners = {
    'task:t-ok': { teamId: 't-1', workspaceId: 'ws-ok' },
    'task:t-sensitive': { teamId: 't-1', workspaceId: 'ws-sensitive' },
    'mission:m-team': { teamId: 't-1', workspaceId: null },
    'mission:m-other': { teamId: 't-2', workspaceId: null },
    'mission:m-sensitive': { teamId: 't-1', workspaceId: 'ws-sensitive' },
    // A team-level mission with a task in a sensitive workspace.
    'mission:m-mixed': { teamId: 't-1', workspaceId: null, childWorkspaceIds: ['ws-ok', 'ws-sensitive'] },
  } as Record<string, any>;
  const reach = {
    teamId: 't-1',
    workspaceIds: new Set(['ws-ok']),
    ownerOf: async (kind: string, id: string) => owners[`${kind}:${id}`] ?? null,
  };
  const make = () => {
    const calls: any[] = [];
    const api = createInProcessApi({ origin: 'http://localhost', headers: new Headers({ cookie: 's=1' }), routes, reach, onCall: c => calls.push(c) });
    return { api, calls };
  };

  it('never forwards an Authorization header: tools act as the session user, not a bearer key', async () => {
    let auth: string | null = 'unset';
    const api = createInProcessApi({
      origin: 'http://localhost',
      headers: new Headers({ cookie: 's=1', authorization: 'Bearer bld_someone_else' }),
      routes: [{ pattern: '/api/x', methods: ['GET'], load: async () => ({ GET: async (req: NextRequest) => { auth = req.headers.get('authorization'); return Response.json({}); } }) }],
    });
    await api('/api/x');
    expect(auth).toBeNull();
  });

  it('refuses an explicit workspace outside reach (sensitive, or another team)', async () => {
    const { api } = make();
    await expect(api('/api/tasks?workspaceId=ws-sensitive')).rejects.toThrow('API error: 404');
    await expect(api('/api/tasks?workspaceId=ws-other-team')).rejects.toThrow('API error: 404');
    await expect(api('/api/workspaces/ws-sensitive/artifacts')).rejects.toThrow('API error: 404');
    expect(await api('/api/workspaces/ws-ok/artifacts')).toEqual({ artifacts: [] });
  });

  it('drops rows outside reach from list responses, and from what onCall sees', async () => {
    const { api, calls } = make();
    const out = await api('/api/tasks?status=active');
    expect(out.tasks.map((t: any) => t.id)).toEqual(['t-a']);
    expect(calls[0].body.tasks.map((t: any) => t.id)).toEqual(['t-a']);
    const ws = await api('/api/workspaces');
    expect(ws.workspaces.map((w: any) => w.id)).toEqual(['ws-ok']);
  });

  it('pins mission lists and mission creation to the conversation team', async () => {
    const { api } = make();
    seen.length = 0;
    const list = await api('/api/missions');
    expect(seen[0].query.teamId).toBe('t-1');
    expect(list.missions.map((m: any) => m.id)).toEqual(['m-a']);

    await api('/api/missions', { method: 'POST', body: JSON.stringify({ title: 'x' }) });
    expect((seen[1].body as any).teamId).toBe('t-1');
    await expect(api('/api/missions', { method: 'POST', body: JSON.stringify({ title: 'x', workspaceId: 'ws-sensitive' }) }))
      .rejects.toThrow('API error: 404');
    await expect(api('/api/missions', { method: 'POST', body: JSON.stringify({ title: 'x', teamId: 't-2' }) }))
      .rejects.toThrow('API error: 404');
  });

  it('refuses an id-addressed object outside reach, and unknown ids', async () => {
    const { api } = make();
    expect(await api('/api/tasks/t-ok')).toMatchObject({ id: 't-ok' });
    await expect(api('/api/tasks/t-sensitive')).rejects.toThrow('API error: 404');
    await expect(api('/api/tasks/t-unknown')).rejects.toThrow('API error: 404');
    expect(await api('/api/missions/m-team')).toMatchObject({ id: 'm-team' });
    await expect(api('/api/missions/m-other')).rejects.toThrow('API error: 404');
    await expect(api('/api/missions/m-sensitive')).rejects.toThrow('API error: 404');
    await expect(api('/api/missions/m-mixed')).rejects.toThrow('API error: 404');
  });

  it('refuses a single-object response that names a workspace outside reach', async () => {
    const api = createInProcessApi({
      origin: 'http://localhost', headers: new Headers(), reach,
      routes: [{ pattern: '/api/workspaces/:id/schedules', methods: ['GET'], load: async () => ({ GET: async () => Response.json({ id: 's', workspaceId: 'ws-sensitive' }) }) }],
    });
    await expect(api('/api/workspaces/ws-ok/schedules')).rejects.toThrow('API error: 404');
  });
});
