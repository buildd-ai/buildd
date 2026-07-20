import { describe, it, expect, afterEach } from 'bun:test';
import { BuilddTransport } from '../buildd-transport';

describe('BuilddTransport', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  // ── Auth header ────────────────────────────────────────────────────────────

  it('injects Authorization Bearer header', async () => {
    let captured: RequestInit | undefined;
    globalThis.fetch = ((url: string, init: RequestInit) => {
      captured = init;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as any;

    const t = new BuilddTransport({ baseUrl: 'https://api.example.com', apiKey: 'bld_test_key' });
    await t.request('/api/test');

    const headers = captured?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer bld_test_key');
  });

  it('sets Content-Type to application/json', async () => {
    let captured: RequestInit | undefined;
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      captured = init;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as any;

    const t = new BuilddTransport({ baseUrl: 'https://api.example.com', apiKey: 'key' });
    await t.request('/api/test');

    const headers = captured?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('merges caller-supplied headers without clobbering auth', async () => {
    let captured: RequestInit | undefined;
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      captured = init;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as any;

    const t = new BuilddTransport({ baseUrl: 'https://api.example.com', apiKey: 'mykey' });
    await t.request('/api/test', { headers: { 'X-Custom': 'value' } });

    const headers = captured?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer mykey');
    expect(headers['X-Custom']).toBe('value');
  });

  // ── URL construction ───────────────────────────────────────────────────────

  it('builds the full URL from baseUrl + route', async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = ((url: string) => {
      capturedUrl = url;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as any;

    const t = new BuilddTransport({ baseUrl: 'https://api.example.com', apiKey: 'key' });
    await t.request('/api/workers/claim');

    expect(capturedUrl).toBe('https://api.example.com/api/workers/claim');
  });

  // ── Timeout ────────────────────────────────────────────────────────────────

  it('attaches AbortSignal.timeout when timeoutMs is configured', async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as any;

    const t = new BuilddTransport({ baseUrl: 'https://api.example.com', apiKey: 'key', timeoutMs: 30_000 });
    await t.request('/api/test');

    expect(capturedSignal).toBeDefined();
  });

  it('does not attach a timeout when timeoutMs is undefined', async () => {
    let capturedSignal: AbortSignal | undefined | null;
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as any;

    const t = new BuilddTransport({ baseUrl: 'https://api.example.com', apiKey: 'key' });
    await t.request('/api/test');

    expect(capturedSignal == null).toBe(true);
  });

  it('prefers a caller-supplied signal over the config timeout', async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as any;

    const callerSignal = new AbortController().signal;
    const t = new BuilddTransport({ baseUrl: 'https://api.example.com', apiKey: 'key', timeoutMs: 30_000 });
    await t.request('/api/test', { signal: callerSignal });

    expect(capturedSignal).toBe(callerSignal);
  });

  // ── Interceptors ───────────────────────────────────────────────────────────

  it('passes body through a single interceptor before sending', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as any;

    const redact = (body: string, _route: string) => body.replace('secret', '[REDACTED]');
    const t = new BuilddTransport({ baseUrl: 'https://api.example.com', apiKey: 'key', interceptors: [redact] });
    await t.request('/api/test', { method: 'POST', body: JSON.stringify({ value: 'secret' }) });

    expect(capturedBody).toBe('{"value":"[REDACTED]"}');
  });

  it('applies interceptors in order', async () => {
    const calls: string[] = [];
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      calls.push('fetch:' + (init.body as string));
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as any;

    const first  = (body: string) => { calls.push('first');  return body + 'A'; };
    const second = (body: string) => { calls.push('second'); return body + 'B'; };
    const t = new BuilddTransport({ baseUrl: 'https://api.example.com', apiKey: 'key', interceptors: [first, second] });
    await t.request('/api/test', { method: 'POST', body: 'X' });

    expect(calls).toEqual(['first', 'second', 'fetch:XAB']);
  });

  it('passes route to interceptors', async () => {
    let capturedRoute: string | undefined;
    globalThis.fetch = (() => Promise.resolve(new Response('{}', { status: 200 }))) as any;

    const t = new BuilddTransport({
      baseUrl: 'https://api.example.com',
      apiKey: 'key',
      interceptors: [
        (body, route) => { capturedRoute = route; return body; },
      ],
    });
    await t.request('/api/workers/claim', { method: 'POST', body: '{}' });

    expect(capturedRoute).toBe('/api/workers/claim');
  });

  it('skips interceptors when body is undefined', async () => {
    let interceptorCalled = false;
    globalThis.fetch = (() => Promise.resolve(new Response('{}', { status: 200 }))) as any;

    const t = new BuilddTransport({
      baseUrl: 'https://api.example.com',
      apiKey: 'key',
      interceptors: [(_body) => { interceptorCalled = true; return _body; }],
    });
    await t.request('/api/test'); // no body

    expect(interceptorCalled).toBe(false);
  });

  // ── Response passthrough ───────────────────────────────────────────────────

  it('returns the raw Response so callers decide error handling', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response('Not Found', { status: 404 }))) as any;

    const t = new BuilddTransport({ baseUrl: 'https://api.example.com', apiKey: 'key' });
    const res = await t.request('/api/missing');

    // Transport does NOT throw on non-ok — that's the caller's job
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not Found');
  });

  it('returns a 200 Response intact', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response('{"ok":true}', { status: 200 }))) as any;

    const t = new BuilddTransport({ baseUrl: 'https://api.example.com', apiKey: 'key' });
    const res = await t.request('/api/test');

    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ ok: true });
  });

  // ── HTTP method ────────────────────────────────────────────────────────────

  it('defaults to GET when no method supplied', async () => {
    let capturedMethod: string | undefined;
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      capturedMethod = init.method as string;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as any;

    const t = new BuilddTransport({ baseUrl: 'https://api.example.com', apiKey: 'key' });
    await t.request('/api/test');

    expect(capturedMethod).toBe('GET');
  });

  it('passes through the caller method', async () => {
    let capturedMethod: string | undefined;
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      capturedMethod = init.method as string;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as any;

    const t = new BuilddTransport({ baseUrl: 'https://api.example.com', apiKey: 'key' });
    await t.request('/api/test', { method: 'PATCH' });

    expect(capturedMethod).toBe('PATCH');
  });
});
