import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

// Route policy and the publish client for the Dispatch transport. The ack
// statements and the drain's exclusion are real-SQL: apps/web/tests/db/dispatch-handoff.test.ts.

let githubConfigured = true;
mock.module('@/lib/github', () => ({
  isGitHubAppConfigured: () => githubConfigured,
  dispatchToGitHubActions: async () => true,
  repositoryDispatchBody: () => ({}),
}));
mock.module('@/app/api/workers/claim/held-gate', () => ({ isTaskNotHeldOrLocal: async () => true }));
mock.module('@/lib/pusher', () => ({
  triggerEvent: async () => {},
  triggerEventChecked: async () => 'sent',
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { TASK_ASSIGNED: 'task:assigned', TASK_CREATED: 'task:created' },
}));

const { verifyRequest, parseKeyRing } = await import('@buildd/dispatch-contract');
const { routeFor, publishPendingDispatches, dispatchTransportConfig } = await import('./dispatch-transport');
type Row = Parameters<typeof routeFor>[0];

const WS = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const HOOK = { url: 'https://hooks.example.test/x', token: 'tok', enabled: true, events: ['task.created', 'task.unblocked', 'task.retry'] };

function row(over: Partial<Row> = {}): Row {
  return {
    id: '33333333-3333-4333-8333-333333333333', intent: 'work_execution', workspaceId: WS, taskId: TASK,
    cause: 'task.created', causes: ['task.created'], notBefore: new Date(Date.now() - 1000), dedupeKey: 'now',
    attemptCount: 0, metadata: null, mode: 'dispatch', ...over,
  } as Row;
}
const task = (over: Record<string, unknown> = {}) => ({
  id: TASK, title: 'Secret title', description: 'd', workspaceId: WS, backend: 'codex', runnerPreference: null,
  status: 'pending', startAt: null, ...over,
});
const ws = (over: Record<string, unknown> = {}) => ({ id: WS, name: 'acme', repo: 'https://example.test/r', webhookConfig: null, githubInstallationId: null, githubRepoId: null, ...over });
const T = (type: string) => `buildd:ws:${WS}:${type}`;

describe('routeFor', () => {
  it('a targeted local runner gets only the runner wake, with the target in the payload (AC-15)', () => {
    const r = routeFor(row({ metadata: { targetLocalUiUrl: 'http://r.test' } }), task() as never, ws({ webhookConfig: HOOK, githubInstallationId: 'i', githubRepoId: 'r' }) as never);
    expect(r!.steps).toEqual([{ target: T('runner-wake'), mode: 'first' }]);
    expect(r!.payload!.targetLocalUiUrl).toBe('http://r.test');
  });

  it('a wanted webhook goes first with resolve; GitHub Actions rides along for a legacy cause; the wake is last', () => {
    const r = routeFor(row(), task() as never, ws({ webhookConfig: HOOK, githubInstallationId: 'i', githubRepoId: 'r' }) as never);
    expect(r!.steps).toEqual([
      { target: T('webhook'), mode: 'first', resolve: true },
      { target: T('github-actions'), mode: 'also', resolve: true },
      { target: T('runner-wake'), mode: 'first' },
    ]);
  });

  it('no webhook step when the policy rules it out; no GitHub Actions for a non-legacy cause or a retried row', () => {
    const r1 = routeFor(row({ cause: 'path_claim.released', causes: ['path_claim.released'] }), task() as never,
      ws({ webhookConfig: { ...HOOK, events: ['task.created'] }, githubInstallationId: 'i', githubRepoId: 'r' }) as never);
    expect(r1!.steps.map(s => s.target)).toEqual([T('runner-wake')]);
    const r2 = routeFor(row({ attemptCount: 1 }), task() as never, ws({ githubInstallationId: 'i', githubRepoId: 'r' }) as never);
    expect(r2!.steps.map(s => s.target)).toEqual([T('runner-wake')]);
    githubConfigured = false;
    const r3 = routeFor(row(), task() as never, ws({ githubInstallationId: 'i', githubRepoId: 'r' }) as never);
    githubConfigured = true;
    expect(r3!.steps.map(s => s.target)).toEqual([T('runner-wake')]);
  });

  it('a scheduled row keeps its webhook step: startAt is judged at resolve time, not publish time', () => {
    const due = new Date(Date.now() + 3_600_000);
    const r = routeFor(row({ notBefore: due, cause: 'start_at.reached', causes: ['start_at.reached'] }), task({ startAt: due }) as never, ws({ webhookConfig: HOOK }) as never);
    expect(r!.steps[0]).toEqual({ target: T('webhook'), mode: 'first', resolve: true });
  });

  it('the inline runner-wake payload names the task, never its title', () => {
    const r = routeFor(row(), task() as never, ws() as never);
    expect(r!.payload).toEqual({ taskId: TASK, workspaceId: WS, backend: 'codex', workspace: { name: 'acme', repo: 'https://example.test/r' }, dispatchId: row().id });
    expect(JSON.stringify(r!.payload)).not.toContain('Secret title');
  });

  it('a non-work intent has no route (it is never published; the in-app drain parks it as no_adapter)', () => {
    expect(routeFor(row({ intent: 'human_action' }), task() as never, ws() as never)).toBeNull();
  });
});

// ── publish client ─────────────────────────────────────────────────────────

const ENV_KEYS = ['DISPATCH_URL', 'DISPATCH_PUBLISH_SECRET'] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; });
afterEach(() => { for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } });

function configure() {
  process.env.DISPATCH_URL = 'https://dispatch.example.test/';
  process.env.DISPATCH_PUBLISH_SECRET = 'k2:secret-two,k1:secret-one';
}

function deps(rows: Row[], respond: (body: { envelopes: Array<{ id: string }> }) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const acked: unknown[] = [];
  const merged: unknown[] = [];
  const d = {
    selectForPublish: mock(async (_o: unknown) => rows),
    ackHandoff: mock(async (a: unknown[]) => { acked.push(...a); return a.length; }),
    ackMerged: mock(async (m: unknown[]) => { merged.push(...m); return m.length; }),
    loadRouteContext: mock(async (ids: string[]) => new Map(ids.map(id => [id, { task: task({ id }), workspace: ws() }]))),
    fetch: mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(JSON.parse(init.body as string));
    }) as unknown as typeof fetch,
  };
  return { d, calls, acked, merged };
}
const ok = (results: unknown[]) => new Response(JSON.stringify({ results }), { status: 202 });

describe('publishPendingDispatches', () => {
  it('is a no-op without DISPATCH_URL and DISPATCH_PUBLISH_SECRET: nothing is read', async () => {
    delete process.env.DISPATCH_URL;
    delete process.env.DISPATCH_PUBLISH_SECRET;
    const { d } = deps([row()], () => ok([]));
    expect(await publishPendingDispatches({}, d as never)).toEqual({ status: 'unconfigured' });
    expect(d.selectForPublish).not.toHaveBeenCalled();
    process.env.DISPATCH_URL = 'https://dispatch.example.test';
    expect(dispatchTransportConfig()).toBeNull();
  });

  it('POSTs one signed batch to /v1/envelopes with the first key of the ring', async () => {
    configure();
    const { d, calls } = deps([row()], () => ok([{ id: row().id, status: 'accepted' }]));
    await publishPendingDispatches({ taskId: TASK }, d as never);
    expect(d.selectForPublish).toHaveBeenCalledWith({ taskId: TASK, limit: 25 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://dispatch.example.test/v1/envelopes');
    const headers = new Headers(calls[0].init.headers as Record<string, string>);
    expect(headers.get('Dispatch-Key-Id')).toBe('k2');
    const body = calls[0].init.body as string;
    const v = await verifyRequest({ keys: parseKeyRing('k2:secret-two'), method: 'POST', path: '/v1/envelopes', body, headers });
    expect(v.ok).toBe(true);
    const sent = JSON.parse(body);
    expect(sent.envelopes[0]).toMatchObject({ id: row().id, kind: 'work_execution', source: { scope: `workspace:${WS}` } });
  });

  it('acks accepted and duplicate in one call, merged in another, and leaves rejected pending', async () => {
    configure();
    const ids = ['a1111111-1111-4111-8111-111111111111', 'a2222222-2222-4222-8222-222222222222', 'a3333333-3333-4333-8333-333333333333', 'a4444444-4444-4444-8444-444444444444'];
    const rows = ids.map((id, i) => row({ id, mode: i === 1 ? 'shadow' : 'dispatch' }));
    const { d, acked, merged } = deps(rows, () => ok([
      { id: ids[0], status: 'accepted' },
      { id: ids[1], status: 'duplicate' },
      { id: ids[2], status: 'merged', into: ids[0] },
      { id: ids[3], status: 'rejected', why: 'payload too large' },
      { id: 'b0000000-0000-4000-8000-000000000000', status: 'accepted' }, // not ours: ignored
    ]));
    const out = await publishPendingDispatches({}, d as never);
    expect(d.ackHandoff).toHaveBeenCalledTimes(1);
    expect(d.ackMerged).toHaveBeenCalledTimes(1);
    expect(acked).toEqual([{ id: ids[0], mode: 'dispatch' }, { id: ids[1], mode: 'shadow' }]);
    expect(merged).toEqual([{ id: ids[2], mode: 'dispatch', into: ids[0] }]);
    expect(out).toMatchObject({ status: 'ok', published: 4, acked: 2, merged: 1, rejected: 1 });
  });

  it('a Worker that errors or is slower than the budget acks nothing and never throws', async () => {
    configure();
    const a = deps([row()], () => new Response('boom', { status: 500 }));
    expect(await publishPendingDispatches({}, a.d as never)).toMatchObject({ status: 'failed', published: 1 });
    expect(a.d.ackHandoff).not.toHaveBeenCalled();

    const b = deps([row()], () => new Promise<Response>(() => {}));
    b.d.fetch = mock(async (_u: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')));
    })) as unknown as typeof fetch;
    const started = Date.now();
    expect(await publishPendingDispatches({ timeoutMs: 50 }, b.d as never)).toMatchObject({ status: 'failed' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('nothing to publish → idle, no request', async () => {
    configure();
    const { d, calls } = deps([], () => ok([]));
    expect(await publishPendingDispatches({}, d as never)).toEqual({ status: 'idle' });
    expect(calls).toHaveLength(0);
  });

  it('a row whose task is gone is not published', async () => {
    configure();
    const { d, calls } = deps([row()], () => ok([]));
    d.loadRouteContext = mock(async () => new Map());
    expect(await publishPendingDispatches({}, d as never)).toEqual({ status: 'idle' });
    expect(calls).toHaveLength(0);
  });
});

// ── repair floor: lookup and re-publish ───────────────────────────────────

const { lookupIntents, republishDispatches } = await import('./dispatch-transport');

describe('lookupIntents', () => {
  it('GETs /v1/intents signed over pathname + search exactly as sent, verifiable by the Worker', async () => {
    configure();
    const ids = ['a1111111-1111-4111-8111-111111111111', 'a2222222-2222-4222-8222-222222222222'];
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ known: [{ id: ids[0], state: 'queued', attempt: 0 }], unknown: [ids[1]] });
    }) as unknown as typeof fetch;
    const scope = `buildd:workspace:${WS}`;
    const res = await lookupIntents(scope, ids, { fetch: fetchFn });
    expect(res).toEqual({ known: [{ id: ids[0], state: 'queued', attempt: 0 }], unknown: [ids[1]] });

    const u = new URL(calls[0].url);
    expect(u.pathname).toBe('/v1/intents');
    expect(u.searchParams.get('scope')).toBe(scope);
    expect(u.searchParams.get('ids')).toBe(ids.join(','));
    const headers = new Headers(calls[0].init.headers as Record<string, string>);
    // The Worker verifies `url.pathname + url.search` of the request it received.
    const v = await verifyRequest({ keys: parseKeyRing('k2:secret-two'), method: 'GET', path: u.pathname + u.search, body: '', headers });
    expect(v.ok).toBe(true);
  });

  it('throws on non-2xx, a malformed body, a bad id count, or no config', async () => {
    configure();
    const f = (r: Response) => mock(async () => r) as unknown as typeof fetch;
    await expect(lookupIntents('buildd:workspace:x', ['a'], { fetch: f(new Response('x', { status: 503 })) })).rejects.toThrow('lookup_http_503');
    await expect(lookupIntents('buildd:workspace:x', ['a'], { fetch: f(Response.json({ nope: 1 })) })).rejects.toThrow('lookup_bad_response');
    await expect(lookupIntents('buildd:workspace:x', [], { fetch: f(Response.json({})) })).rejects.toThrow();
    await expect(lookupIntents('buildd:workspace:x', Array.from({ length: 101 }, (_, i) => `i${i}`), { fetch: f(Response.json({})) })).rejects.toThrow();
    delete process.env.DISPATCH_URL;
    await expect(lookupIntents('buildd:workspace:x', ['a'], { fetch: f(Response.json({ known: [], unknown: [] })) })).rejects.toThrow('not configured');
  });
});

describe('republishDispatches', () => {
  const ids = ['c1111111-1111-4111-8111-111111111111', 'c2222222-2222-4222-8222-222222222222', 'c3333333-3333-4333-8333-333333333333', 'c4444444-4444-4444-8444-444444444444'];

  it('re-sends the handed-off rows through the publish endpoint and sorts the outcomes, acking nothing', async () => {
    configure();
    const rows = [row({ id: ids[0] }), row({ id: ids[1] }), row({ id: ids[2] }), row({ id: ids[3], mode: 'in_app' as never })];
    const { d, calls } = deps([], () => ok([
      { id: ids[0], status: 'accepted' },
      { id: ids[1], status: 'merged', into: ids[0] },
      { id: ids[2], status: 'rejected', why: 'source.scope' },
    ]));
    const selectForRepublish = mock(async (_ids: readonly string[]) => rows);
    const out = await republishDispatches(ids, { ...d, selectForRepublish } as never);
    expect(selectForRepublish).toHaveBeenCalledWith(ids);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].init.body as string).envelopes.map((e: { id: string }) => e.id)).toEqual(ids.slice(0, 3));
    expect(out).toEqual({ republished: [ids[0]], merged: [{ id: ids[1], into: ids[0] }], rejected: [ids[2]], notDispatch: [ids[3]] });
    expect(d.ackHandoff).not.toHaveBeenCalled();
    expect(d.ackMerged).not.toHaveBeenCalled();
  });

  it('throws when the Worker answers non-2xx, so the floor takes the rows back', async () => {
    configure();
    const { d } = deps([], () => new Response('down', { status: 502 }));
    const selectForRepublish = mock(async () => [row({ id: ids[0] })]);
    await expect(republishDispatches([ids[0]], { ...d, selectForRepublish } as never)).rejects.toThrow('http_502');
  });

  it('a row with no route any more (task gone) is reported rejected without a request', async () => {
    configure();
    const { d, calls } = deps([], () => ok([]));
    d.loadRouteContext = mock(async () => new Map());
    const out = await republishDispatches([ids[0]], { ...d, selectForRepublish: mock(async () => [row({ id: ids[0] })]) } as never);
    expect(out.rejected).toEqual([ids[0]]);
    expect(calls).toHaveLength(0);
  });
});
