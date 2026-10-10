import { describe, expect, it } from 'bun:test';
import worker, { executionMode, matchRoute, ROUTES, SERVED_BY } from './index';
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
