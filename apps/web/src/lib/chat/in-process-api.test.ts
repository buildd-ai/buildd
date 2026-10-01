import { describe, it, expect } from 'bun:test';
import { NextRequest } from 'next/server';
import { createInProcessApi, matchChatRoute, routesFor, CHAT_ROUTES } from './in-process-api';
import type { RouteReach } from './reach-rules';

const TEST_REACH: RouteReach = { unpinned: 'test route with no team data', result: 'rows' };
/** The real declaration for a real pattern: tests exercise what production uses. */
const reachOf = (pattern: string): RouteReach => {
  const r = CHAT_ROUTES.find(c => c.pattern === pattern)?.reach;
  if (!r) throw new Error(`no CHAT_ROUTES entry for ${pattern}`);
  return r;
};

describe('matchChatRoute (the reachable surface)', () => {
  it('matches allowlisted reads and extracts params by folder name', () => {
    expect(matchChatRoute('GET', '/api/tasks/abc')?.params).toEqual({ id: 'abc' });
    expect(matchChatRoute('GET', '/api/workspaces/w/schedules/s')?.params).toEqual({ id: 'w', scheduleId: 's' });
  });

  it('refuses anything else: other methods, other routes', () => {
    expect(matchChatRoute('DELETE', '/api/tasks/t1')).toBeNull();
    expect(matchChatRoute('GET', '/api/secrets')).toBeNull();
    expect(matchChatRoute('POST', '/api/secrets')).toBeNull();
    expect(matchChatRoute('POST', '/api/workers/claim')).toBeNull();
    expect(matchChatRoute('PATCH', '/api/workers/w1')).toBeNull();
    expect(matchChatRoute('PUT', '/api/github/pr')).toBeNull();
  });

  it('the visual review read is GET only and checked against the mission (get_visual_review)', () => {
    const m = matchChatRoute('GET', '/api/missions/m1/visual-review');
    expect(m?.entry.pattern).toBe('/api/missions/:id/visual-review');
    expect(m?.entry.methods).toEqual(['GET']);
    expect(m?.entry.reach.path).toEqual([{ param: 'id', is: 'mission' }]);
    expect(matchChatRoute('POST', '/api/missions/m1/visual-review/decisions')).toBeNull();
    expect(matchChatRoute('DELETE', '/api/missions/m1/visual-review/decisions/r1')).toBeNull();
  });

  it('a static segment wins over a param one (capabilities is not a mission id)', () => {
    expect(matchChatRoute('GET', '/api/missions/capabilities')?.entry.pattern).toBe('/api/missions/capabilities');
    expect(matchChatRoute('GET', '/api/releases/status')?.entry.pattern).toBe('/api/releases/status');
  });

  it('routesFor narrows to exactly the declared (method, pattern) pairs', () => {
    const r = routesFor(['GET /api/tasks/:id', 'PATCH /api/missions/:id']);
    expect(r.map(e => `${e.methods.join(',')} ${e.pattern}`)).toEqual(['GET /api/tasks/:id', 'PATCH /api/missions/:id']);
    expect(matchChatRoute('PATCH', '/api/tasks/t1', r)).toBeNull();
    expect(matchChatRoute('DELETE', '/api/missions/m1', r)).toBeNull();
  });
});

describe('createInProcessApi', () => {
  const routes = [{
    pattern: '/api/things/:id',
    methods: ['GET'],
    reach: TEST_REACH,
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
      routes: [{ pattern: '/api/x', methods: ['GET'], reach: TEST_REACH, load: async () => ({ GET: async () => Response.json({ error: 'no' }, { status: 403 }) }) }],
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
    { pattern: '/api/tasks', methods: ['GET'], reach: reachOf('/api/tasks'), load: echo(() => ({ tasks: [
      { id: 't-a', workspaceId: 'ws-ok', title: 'fine' },
      { id: 't-b', workspaceId: 'ws-sensitive', title: 'secret' },
      { id: 't-c', workspaceId: 'ws-other-team', title: 'elsewhere' },
    ] })) },
    { pattern: '/api/tasks/:id', methods: ['GET'], reach: reachOf('/api/tasks/:id'), load: echo((_r, p) => ({ id: p.id, workspaceId: 'ws-ok' })) },
    { pattern: '/api/tasks/:id/error-traces', methods: ['GET'], reach: reachOf('/api/tasks/:id/error-traces'), load: echo(() => ({ traces: [] })) },
    { pattern: '/api/missions', methods: ['GET', 'POST'], reach: reachOf('/api/missions'), load: echo(() => ({ missions: [
      { id: 'm-a', teamId: 't-1', workspaceId: null },
      { id: 'm-b', teamId: 't-2', workspaceId: null },
    ] })) },
    { pattern: '/api/missions/:id', methods: ['GET'], reach: reachOf('/api/missions/:id'), load: echo((_r, p) => ({ id: p.id })) },
    { pattern: '/api/workspaces', methods: ['GET'], reach: reachOf('/api/workspaces'), load: echo(() => ({ workspaces: [
      { id: 'ws-ok', name: 'ok' }, { id: 'ws-sensitive', name: 's' }, { id: 'ws-other-team', name: 'o' },
    ] })) },
    { pattern: '/api/workspaces/:id/artifacts', methods: ['GET'], reach: reachOf('/api/workspaces/:id/artifacts'), load: echo(() => ({ artifacts: [] })) },
  ];
  const owners = {
    'task:t-ok': { teamId: 't-1', workspaceId: 'ws-ok' },
    'task:t-sensitive': { teamId: 't-1', workspaceId: 'ws-sensitive' },
    'task:t-elsewhere': { teamId: 't-2', workspaceId: 'ws-other-team' },
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
      routes: [{ pattern: '/api/x', methods: ['GET'], reach: TEST_REACH, load: async () => ({ GET: async (req: NextRequest) => { auth = req.headers.get('authorization'); return Response.json({}); } }) }],
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

  it('a task\'s error traces are declared for chat and refused for a task outside the conversation team', () => {
    expect(matchChatRoute('GET', '/api/tasks/abc/error-traces')?.params).toEqual({ id: 'abc' });
    expect(routesFor(['GET /api/tasks/:id/error-traces']).map(r => r.pattern)).toEqual(['/api/tasks/:id/error-traces']);
  });

  it('refuses error traces of a task outside reach (sensitive workspace, unknown id)', async () => {
    const { api } = make();
    expect(await api('/api/tasks/t-ok/error-traces')).toEqual({ traces: [] });
    await expect(api('/api/tasks/t-sensitive/error-traces')).rejects.toThrow('API error: 404');
    await expect(api('/api/tasks/t-unknown/error-traces')).rejects.toThrow('API error: 404');
  });

  it('refuses a task\'s evidence when the task belongs to another team', async () => {
    const { api } = make();
    await expect(api('/api/tasks/t-elsewhere/error-traces')).rejects.toThrow('API error: 404');
    await expect(api('/api/tasks/t-elsewhere')).rejects.toThrow('API error: 404');
  });

  it('refuses a single-object response that names a workspace outside reach', async () => {
    const api = createInProcessApi({
      origin: 'http://localhost', headers: new Headers(), reach,
      routes: [{ pattern: '/api/workspaces/:id/schedules', methods: ['GET'], reach: reachOf('/api/workspaces/:id/schedules'), load: async () => ({ GET: async () => Response.json({ id: 's', workspaceId: 'ws-sensitive' }) }) }],
    });
    await expect(api('/api/workspaces/ws-ok/schedules')).rejects.toThrow('API error: 404');
  });

  it('checks scope fields in any write body, whatever the route (a missionId names a mission)', async () => {
    let dispatched = 0;
    const api = createInProcessApi({
      origin: 'http://localhost', headers: new Headers(), reach,
      routes: [{
        pattern: '/api/tasks/:id', methods: ['PATCH'], reach: { path: [{ param: 'id', is: 'task' }], result: 'rows' },
        load: async () => ({ PATCH: async () => { dispatched++; return Response.json({ id: 't-ok', workspaceId: 'ws-ok' }); } }),
      }],
    });
    // Linking an in-reach task to another team's mission is refused before dispatch.
    await expect(api('/api/tasks/t-ok', { method: 'PATCH', body: JSON.stringify({ missionId: 'm-other' }) })).rejects.toThrow('API error: 404');
    await expect(api('/api/tasks/t-ok', { method: 'PATCH', body: JSON.stringify({ dependsOn: ['t-ok', 't-sensitive'] }) })).rejects.toThrow('API error: 404');
    await expect(api('/api/tasks/t-ok', { method: 'PATCH', body: JSON.stringify({ workspaceId: 'ws-sensitive' }) })).rejects.toThrow('API error: 404');
    // A malformed scope value is refused, not ignored.
    await expect(api('/api/tasks/t-ok', { method: 'PATCH', body: JSON.stringify({ missionId: 42 }) })).rejects.toThrow('API error: 404');
    expect(dispatched).toBe(0);
    await api('/api/tasks/t-ok', { method: 'PATCH', body: JSON.stringify({ missionId: 'm-team', status: 'cancelled' }) });
    expect(dispatched).toBe(1);
  });

  it('a declared result resolver refuses a response whose object is outside reach', async () => {
    const api = createInProcessApi({
      origin: 'http://localhost', headers: new Headers(), reach,
      routes: [{
        pattern: '/api/pr', methods: ['GET'],
        reach: { requireQuery: ['workspaceId'], result: (b: any) => [{ kind: 'task', id: b.pr.taskId }] },
        // No workspaceId anywhere in the body: the generic field check would pass it.
        load: async () => ({ GET: async () => Response.json({ pr: { number: 7, taskId: 't-sensitive' } }) }),
      }],
    });
    await expect(api('/api/pr?workspaceId=ws-ok')).rejects.toThrow('API error: 404');
  });

  describe('runner rows carry a workspaceIds array (list_runners, GET /api/workers/active)', () => {
    const runnersApi = (body: unknown) => createInProcessApi({
      origin: 'http://localhost', headers: new Headers(), reach,
      routes: [{ pattern: '/api/workers/active', methods: ['GET'], reach: reachOf('/api/workers/active'), load: async () => ({ GET: async () => Response.json(body) }) }],
    });
    const rows = [
      { localUiUrl: 'http://r-both', accountName: 'both', workspaceIds: ['ws-ok', 'ws-sensitive'], workspaceNames: ['ok', 's'] },
      { localUiUrl: 'http://r-out', accountName: 'out', workspaceIds: ['ws-sensitive', 'ws-other-team'], workspaceNames: ['s', 'o'] },
      { localUiUrl: 'http://r-none', accountName: 'none', workspaceIds: [], workspaceNames: [] },
      { localUiUrl: 'http://r-ok', accountName: 'ok', workspaceIds: ['ws-ok'], workspaceNames: ['ok'] },
    ];

    it('hides a runner that serves only out-of-reach workspaces (or none)', async () => {
      const out = await runnersApi({ activeLocalUis: rows })('/api/workers/active');
      expect(out.activeLocalUis.map((r: any) => r.accountName)).toEqual(['both', 'ok']);
    });

    it('strips workspace ids outside reach from each row, and their names with them', async () => {
      const out = await runnersApi({ activeLocalUis: rows })('/api/workers/active');
      const both = out.activeLocalUis[0];
      expect(both.workspaceIds).toEqual(['ws-ok']);
      expect(both.workspaceNames).toEqual(['ok']);
      expect(JSON.stringify(out)).not.toContain('ws-sensitive');
      expect(JSON.stringify(out)).not.toContain('ws-other-team');
    });

    it('refuses a workspaceId outside reach before dispatch, and allows one in reach', async () => {
      await expect(runnersApi({ activeLocalUis: rows })('/api/workers/active?workspaceId=ws-sensitive')).rejects.toThrow('API error: 404');
      const out = await runnersApi({ activeLocalUis: rows, workspace: { id: 'ws-ok', name: 'ok' }, browserRunnerOnline: true })('/api/workers/active?workspaceId=ws-ok');
      expect(out.browserRunnerOnline).toBe(true);
    });

    it('is not shadowed by /api/workers/:id', () => {
      expect(matchChatRoute('GET', '/api/workers/active')?.entry.pattern).toBe('/api/workers/active');
    });
  });

  it('a requireQuery route with no pinning param is refused before dispatch', async () => {
    let dispatched = 0;
    const api = createInProcessApi({
      origin: 'http://localhost', headers: new Headers(), reach,
      routes: [{ pattern: '/api/pr', methods: ['GET'], reach: { requireQuery: ['workspaceId', 'workerId'], result: 'rows' }, load: async () => ({ GET: async () => { dispatched++; return Response.json({}); } }) }],
    });
    await expect(api('/api/pr?prNumber=7')).rejects.toThrow('API error: 400');
    expect(dispatched).toBe(0);
  });
});
