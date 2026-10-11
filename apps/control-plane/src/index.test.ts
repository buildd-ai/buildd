import { describe, expect, it } from 'bun:test';
import worker, { anonymousGithubProbe, executionMode, matchRoute, ROUTES, SERVED_BY } from './index';
import { NextRequest, NextResponse, after } from './next-server-shim';
import { runInRequest } from './request-context';

describe('the execution routes the control plane serves', () => {
  it('matches exactly the execution path, with path params', () => {
    expect(matchRoute('POST', '/api/workers/claim')?.params).toEqual({});
    expect(matchRoute('PATCH', '/api/workers/w-1')?.params).toEqual({ id: 'w-1' });
    expect(matchRoute('POST', '/api/github/webhook')).not.toBeNull();
    expect(matchRoute('POST', '/api/dispatch/v1/resolve')).not.toBeNull();
    expect(matchRoute('POST', '/api/dispatch/v1/receipts')).not.toBeNull();
    // Product routes stay on the web app.
    for (const [m, p] of [['GET', '/api/missions'], ['POST', '/api/chat'], ['GET', '/api/workers/claim/extra'], ['DELETE', '/api/workers/w-1']]) {
      expect(matchRoute(m, p)).toBeNull();
    }
    expect(matchRoute('POST', '/api/dispatch/v1/relay')).not.toBeNull();
    expect(ROUTES).toHaveLength(7);
  });
});

describe('the next/server shim', () => {
  it('NextRequest carries nextUrl; NextResponse.json and redirect behave like Next', async () => {
    const req = new NextRequest('https://cp.example/api/x?revision=2');
    expect(req.nextUrl.searchParams.get('revision')).toBe('2');
    const res = NextResponse.json({ ok: 1 }, { status: 201 });
    expect([res.status, res.headers.get('content-type'), await res.json()]).toEqual([201, 'application/json', { ok: 1 }]);
    expect(NextResponse.redirect('https://r.example/a').headers.get('location')).toBe('https://r.example/a');
  });

  it('after() hands its work to the request\'s waitUntil, and throws outside a request like Next', async () => {
    const waited: Promise<unknown>[] = [];
    let ran = false;
    runInRequest((p) => waited.push(p), () => after(() => { ran = true; }));
    await Promise.all(waited);
    expect(ran).toBe(true);
    expect(() => after(() => {})).toThrow('outside a request scope');
  });
});

describe('EXECUTION_MODE', () => {
  it('only an exact "own" takes the routes; anything else passes through', () => {
    expect(executionMode('own')).toBe('own');
    for (const v of [undefined, '', 'shadow', 'OWN', 'on']) expect(executionMode(v)).toBe('shadow');
  });

  it('in shadow, an execution route passes through to the origin untouched, tagged web', async () => {
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (r: Request) => { seen.push(`${r.method} ${new URL(r.url).pathname}`); return new Response('origin', { status: 201 }); }) as typeof fetch;
    try {
      const res = await worker.fetch(new Request('https://buildd.dev/api/workers/claim', { method: 'POST', body: '{}' }), { EXECUTION_MODE: 'shadow' }, { waitUntil() {}, passThroughOnException() {} } as never);
      expect([res.status, await res.text(), res.headers.get(SERVED_BY)]).toEqual([201, 'origin', 'web']);
      // A route the Worker does not serve passes through even when it owns the execution routes.
      const other = await worker.fetch(new Request('https://buildd.dev/api/workers/w-1/artifacts', { method: 'POST' }), { EXECUTION_MODE: 'own' }, { waitUntil() {}, passThroughOnException() {} } as never);
      expect(other.headers.get(SERVED_BY)).toBe('web');
      expect(seen).toEqual(['POST /api/workers/claim', 'POST /api/workers/w-1/artifacts']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('the committed config', () => {
  it('records the deployed cutover: the Worker owns the execution routes, and shadow is the one-line rollback', async () => {
    const { readFileSync } = await import('node:fs');
    const cfg = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    expect(cfg).toContain('"EXECUTION_MODE": "own"');
    for (const r of ['buildd.dev/api/workers/*', 'buildd.dev/api/github/webhook', 'buildd.dev/api/dispatch/v1/*']) expect(cfg).toContain(r);
    expect(executionMode('shadow')).toBe('shadow');
  });
});

describe('outbound fetch', () => {
  it('adds a User-Agent when a request has none (GitHub refuses requests without one), and keeps one it has', async () => {
    const { withDefaultUserAgent, CONTROL_PLANE_USER_AGENT } = await import('./outbound-fetch');
    const seen: Array<string | null> = [];
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('user-agent'));
      return new Response('ok');
    }) as typeof fetch;
    const f = withDefaultUserAgent(base);
    await f('https://api.github.com/repos/o/r/pulls/1/files', { headers: { Authorization: 'Bearer t' } });
    await f(new Request('https://api.github.com/zen'));
    await f('https://x.example', { headers: { 'User-Agent': 'mine' } });
    expect(seen).toEqual([CONTROL_PLANE_USER_AGENT, CONTROL_PLANE_USER_AGENT, 'mine']);
  });
});

describe('pusher shim', () => {
  it('signs a trigger the way the Pusher REST API documents (body_md5 + HMAC-SHA256 over the sorted query)', async () => {
    const { signedEventsUrl } = await import('./pusher-shim');
    // The worked example from Pusher's REST API auth reference.
    const body = '{"name":"foo","channels":["project-3"],"data":"{\\"some\\":\\"data\\"}"}';
    const url = new URL(signedEventsUrl({ appId: '3', key: '278d425bdf160c739803', secret: '7ad3773142a6692b25b8', cluster: 'mt1' }, body, 1353088179));
    expect(url.origin + url.pathname).toBe('https://api-mt1.pusher.com/apps/3/events');
    expect(url.searchParams.get('body_md5')).toBe('ec365a775a4cd0599faeb73354201b6f');
    expect(url.searchParams.get('auth_signature')).toBe('da454824c97ba181a32ccc17a72625ba02771f50b50e1e7430e47a1f3f457e6c');
  });
});

describe('health', () => {
  it('reports the deployed commit, so release CI can verify lockstep with the web app', async () => {
    const res = await worker.fetch(new Request('https://control-plane.buildd.dev/__control-plane/health'), { EXECUTION_MODE: 'own', GIT_SHA: 'abc123' }, { waitUntil() {}, passThroughOnException() {} } as never);
    expect(await res.json()).toEqual({ ok: true, service: 'control-plane', mode: 'own', commit: 'abc123' });
  });
});

describe('deep health', () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
  const deep = (auth?: string) => new Request('https://control-plane.buildd.dev/__control-plane/health?deep=1', auth ? { headers: { Authorization: auth } } : {});

  it('is a 404 without CRON_SECRET, and makes no outbound call', async () => {
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (r: RequestInfo | URL) => { seen.push(String(r)); return new Response('x'); }) as typeof fetch;
    try {
      for (const auth of [undefined, 'Bearer wrong', 'Bearer s3cret-but-longer']) {
        expect((await worker.fetch(deep(auth), { EXECUTION_MODE: 'own', CRON_SECRET: 's3cret' }, ctx)).status).toBe(404);
      }
      // No secret configured: never open.
      expect((await worker.fetch(deep('Bearer '), { EXECUTION_MODE: 'own' }, ctx)).status).toBe(404);
      expect(seen).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('with the secret runs the probes, and never echoes upstream error text', async () => {
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (r: RequestInfo | URL) => { seen.push(String(r instanceof Request ? r.url : r)); throw new Error('upstream-said-something-private'); }) as typeof fetch;
    try {
      const res = await worker.fetch(deep('Bearer s3cret'), { EXECUTION_MODE: 'own', CRON_SECRET: 's3cret' }, ctx);
      const text = await res.text();
      expect(res.status).toBe(503);
      expect(seen).toContain('https://api.github.com/zen');
      expect(JSON.parse(text)).toMatchObject({ ok: false, github: 0 });
      expect(text).not.toContain('upstream-said-something-private');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  /** Every probe healthy except what `zen` answers. */
  async function deepWith(zen: Response) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (r: RequestInfo | URL) => {
      const u = String(r instanceof Request ? r.url : r);
      return u.endsWith('/zen') ? zen.clone() : new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const res = await worker.fetch(deep('Bearer s3cret'), { EXECUTION_MODE: 'own', CRON_SECRET: 's3cret' }, ctx);
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it("an anonymous GitHub budget spent on the Worker's shared IP reads rate_limited and fails nothing", async () => {
    const limited = await deepWith(new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }));
    expect(limited.body.github).toBe('rate_limited');
    const secondary = await deepWith(new Response('', { status: 429 }));
    expect(secondary.body.github).toBe('rate_limited');
    expect(anonymousGithubProbe(403, '0')).toEqual({ report: 'rate_limited', healthy: true });
    expect(anonymousGithubProbe(429, null)).toEqual({ report: 'rate_limited', healthy: true });
    expect(anonymousGithubProbe(200, '59')).toEqual({ report: 200, healthy: true });
  });

  it('regression: a 403 with budget left (the missing User-Agent of the cutover) still fails the probe', async () => {
    const r = await deepWith(new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '42' } }));
    expect(r.body).toMatchObject({ ok: false, github: 403 });
    expect(r.status).toBe(503);
    expect(anonymousGithubProbe(403, '42')).toEqual({ report: 403, healthy: false });
    expect(anonymousGithubProbe(403, null)).toEqual({ report: 403, healthy: false });
    expect(anonymousGithubProbe(0, null)).toEqual({ report: 0, healthy: false });
  });

  it('shallow health stays public', async () => {
    const res = await worker.fetch(new Request('https://control-plane.buildd.dev/__control-plane/health'), { EXECUTION_MODE: 'own', CRON_SECRET: 's3cret' }, ctx);
    expect([res.status, (await res.json() as { ok: boolean }).ok]).toEqual([200, true]);
  });
});
