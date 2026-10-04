import { describe, expect, test } from 'bun:test';
import { MAX_LOOKUP_IDS, MAX_PUBLISH_BATCH, signRequest } from '@buildd/dispatch-contract';
import type { DispatchConfigEnv } from './config';
import { handleRequest, type GetQueue, type QueueHandle } from './http';
import { SCOPE_KEY, T0, envelope, harness } from './test-support';

const ENV: DispatchConfigEnv = {
  BUILDD_SERVER: 'https://producer.example',
  PUBLISH_SECRET: 'p1:publish-secret-one,p2:publish-secret-two',
  CALLBACK_SECRET: 'c1:callback-secret',
};
const BASE = 'https://dispatch.example';
const now = () => T0;

/** Real engines behind the RPC shape, one per scope key. */
function queues() {
  const byKey = new Map<string, ReturnType<typeof harness>>();
  const lookups: string[] = [];
  const get: GetQueue = key => {
    lookups.push(key);
    let h = byKey.get(key);
    if (!h) { h = harness(); byKey.set(key, h); }
    const e = h.engine;
    const handle: QueueHandle = {
      publish: (k, envs) => e.publish(k, envs),
      lookup: async ids => e.lookup(ids),
      detail: async id => e.detail(id),
      counts: async () => e.counts(),
      setPaused: p => e.setPaused(p),
      putTarget: async (id, type, options) => e.putTarget(id, type, options),
    };
    return handle;
  };
  return { get, byKey, lookups };
}

async function signed(method: string, path: string, body?: unknown, key = { keyId: 'p2', secret: 'publish-secret-two' }) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const headers = await signRequest({ ...key, method, path, body: text, now: Math.floor(T0 / 1000) });
  return new Request(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(text ? { body: text } : {}) });
}

describe('auth and config', () => {
  test('/health is unsigned and reports configured', async () => {
    const q = queues();
    const res = await handleRequest(new Request(`${BASE}/health`), ENV, q.get, now);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, configured: true });
  });

  test.each([
    ['no signature', async () => new Request(`${BASE}/v1/scopes/${SCOPE_KEY}`), 'missing'],
    ['unknown key id', () => signed('GET', `/v1/scopes/${SCOPE_KEY}`, undefined, { keyId: 'zz', secret: 'publish-secret-two' }), 'unknown_key'],
    ['wrong secret', () => signed('GET', `/v1/scopes/${SCOPE_KEY}`, undefined, { keyId: 'p1', secret: 'nope' }), 'bad_signature'],
  ])('%s -> 401 and no queue is touched', async (_l, make, why) => {
    const q = queues();
    const res = await handleRequest(await make(), ENV, q.get, now);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', why });
    expect(q.lookups).toHaveLength(0);
  });

  test('a body tampered after signing -> 401', async () => {
    const q = queues();
    const req = await signed('POST', '/v1/envelopes', { envelopes: [envelope()] });
    const tampered = new Request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify({ envelopes: [envelope()] }) });
    expect((await handleRequest(tampered, ENV, q.get, now)).status).toBe(401);
  });

  test('a signature outside the skew window -> 401', async () => {
    const q = queues();
    const req = await signed('GET', `/v1/scopes/${SCOPE_KEY}`);
    const res = await handleRequest(req, ENV, q.get, () => T0 + 301_000);
    expect(await res.json()).toEqual({ error: 'unauthorized', why: 'skew' });
  });

  test.each([
    ['PUBLISH_SECRET empty', { ...ENV, PUBLISH_SECRET: '' }],
    ['CALLBACK_SECRET empty', { ...ENV, CALLBACK_SECRET: ' ' }],
    ['BUILDD_SERVER unset', { ...ENV, BUILDD_SERVER: undefined }],
    ['BUILDD_SERVER not a URL', { ...ENV, BUILDD_SERVER: 'producer.example' }],
  ])('%s -> 503 not_configured even with a valid signature', async (_l, env) => {
    const q = queues();
    const res = await handleRequest(await signed('POST', '/v1/envelopes', { envelopes: [envelope()] }), env, q.get, now);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'not_configured' });
    expect(q.lookups).toHaveLength(0);
    const health = await handleRequest(new Request(`${BASE}/health`), env, q.get, now);
    expect(await health.json()).toEqual({ ok: true, configured: false });
  });
});

describe('POST /v1/envelopes', () => {
  test('groups by scope, routes to system:scope, and preserves input order', async () => {
    const q = queues();
    const a = envelope();
    const other = envelope({ source: { system: 'buildd', scope: 'workspace:ws-other' } });
    const bad = { ...envelope(), kind: 'nonsense' };
    const foreign = envelope({ source: { system: 'elsewhere', scope: 'workspace:x' } });
    const dupe = { ...a };
    const res = await handleRequest(await signed('POST', '/v1/envelopes', { envelopes: [a, other, bad, foreign, dupe] }), ENV, q.get, now);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      results: [
        { id: a.id, status: 'accepted' },
        { id: other.id, status: 'accepted' },
        { id: bad.id, status: 'rejected', why: 'kind' },
        { id: foreign.id, status: 'rejected', why: 'unknown_system' },
        { id: a.id, status: 'duplicate' },
      ],
    });
    expect([...q.byKey.keys()].sort()).toEqual(['buildd:workspace:ws-other', SCOPE_KEY]);
    expect(q.byKey.get(SCOPE_KEY)!.engine.counts().intents.queued).toBe(1);
  });

  test('rejects an empty or oversized batch', async () => {
    const q = queues();
    expect((await handleRequest(await signed('POST', '/v1/envelopes', { envelopes: [] }), ENV, q.get, now)).status).toBe(400);
    const many = Array.from({ length: MAX_PUBLISH_BATCH + 1 }, () => envelope());
    expect((await handleRequest(await signed('POST', '/v1/envelopes', { envelopes: many }), ENV, q.get, now)).status).toBe(413);
  });

  test('a queue that throws leaves its envelopes unacked, others still ack', async () => {
    const q = queues();
    const get: GetQueue = key => (key === SCOPE_KEY ? { ...q.get(key), publish: async () => { throw new Error('do down'); } } : q.get(key));
    const a = envelope();
    const b = envelope({ source: { system: 'buildd', scope: 'workspace:ws-other' } });
    const res = await handleRequest(await signed('POST', '/v1/envelopes', { envelopes: [a, b] }), ENV, get, now);
    expect((await res.json()).results).toEqual([
      { id: a.id, status: 'rejected', why: 'queue_unavailable' },
      { id: b.id, status: 'accepted' },
    ]);
  });
});

describe('inspection and control routes', () => {
  test('GET /v1/intents requires scope and ids', async () => {
    const q = queues();
    const e = envelope();
    await handleRequest(await signed('POST', '/v1/envelopes', { envelopes: [e] }), ENV, q.get, now);
    expect((await handleRequest(await signed('GET', `/v1/intents?ids=${e.id}`), ENV, q.get, now)).status).toBe(400);
    expect((await handleRequest(await signed('GET', `/v1/intents?scope=${SCOPE_KEY}`), ENV, q.get, now)).status).toBe(400);
    const res = await handleRequest(await signed('GET', `/v1/intents?scope=${SCOPE_KEY}&ids=${e.id},missing`), ENV, q.get, now);
    expect(await res.json()).toEqual({ known: [{ id: e.id, state: 'queued', attempt: 0 }], unknown: ['missing'] });
  });

  test('GET /v1/intents verifies a percent-encoded query signed as sent (the producer floor builds it with URLSearchParams)', async () => {
    const q = queues();
    const e = envelope();
    await handleRequest(await signed('POST', '/v1/envelopes', { envelopes: [e] }), ENV, q.get, now);
    await q.byKey.get(SCOPE_KEY)!.runToAlarm();
    const search = new URLSearchParams({ scope: SCOPE_KEY, ids: [e.id, 'missing'].join(',') }).toString();
    expect(search).toContain('%3A');
    const res = await handleRequest(await signed('GET', `/v1/intents?${search}`), ENV, q.get, now);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      known: [{ id: e.id, state: 'delivered', attempt: 1, via: 'relay:pusher', closedAt: new Date(T0).toISOString() }],
      unknown: ['missing'],
    });
    const tooMany = Array.from({ length: MAX_LOOKUP_IDS + 1 }, (_, i) => `id-${i}`).join(',');
    expect((await handleRequest(await signed('GET', `/v1/intents?scope=${SCOPE_KEY}&ids=${tooMany}`), ENV, q.get, now)).status).toBe(400);
  });

  test('GET /v1/intents/:id returns detail or 404', async () => {
    const q = queues();
    const e = envelope();
    await handleRequest(await signed('POST', '/v1/envelopes', { envelopes: [e] }), ENV, q.get, now);
    const ok = await handleRequest(await signed('GET', `/v1/intents/${e.id}?scope=${SCOPE_KEY}`), ENV, q.get, now);
    expect(await ok.json()).toMatchObject({ id: e.id, state: 'queued', nextDue: new Date(T0).toISOString() });
    expect((await handleRequest(await signed('GET', `/v1/intents/missing?scope=${SCOPE_KEY}`), ENV, q.get, now)).status).toBe(404);
  });

  test('pause, resume, counts and target registration', async () => {
    const q = queues();
    const paused = await handleRequest(await signed('POST', `/v1/scopes/${SCOPE_KEY}/pause`), ENV, q.get, now);
    expect(await paused.json()).toEqual({ paused: true });
    const counts = await handleRequest(await signed('GET', `/v1/scopes/${SCOPE_KEY}`), ENV, q.get, now);
    expect(await counts.json()).toMatchObject({ paused: true, pendingReceipts: 0 });
    const resumed = await handleRequest(await signed('POST', `/v1/scopes/${SCOPE_KEY}/resume`), ENV, q.get, now);
    expect(await resumed.json()).toEqual({ paused: false });

    const tpath = `/v1/scopes/${SCOPE_KEY}/targets/buildd%3Aws%3Aws-test%3Ahook`;
    const put = await handleRequest(await signed('PUT', tpath, { type: 'http', options: { timeoutMs: 5000 } }), ENV, q.get, now);
    expect(await put.json()).toEqual({ id: 'buildd:ws:ws-test:hook', type: 'http', options: { timeoutMs: 5000 } });
    expect((await handleRequest(await signed('PUT', tpath, { type: 'carrier-pigeon' }), ENV, q.get, now)).status).toBe(400);
    const secret = await handleRequest(await signed('PUT', tpath, { type: 'http', options: { authToken: 'x' } }), ENV, q.get, now);
    expect(await secret.json()).toEqual({ error: 'options_must_not_hold_secrets' });
  });

  test('unknown paths 404 and a bad scope key 400', async () => {
    const q = queues();
    expect((await handleRequest(new Request(`${BASE}/nope`), ENV, q.get, now)).status).toBe(404);
    expect((await handleRequest(await signed('GET', '/v1/scopes/noscope'), ENV, q.get, now)).status).toBe(400);
  });
});
