import { describe, expect, test } from 'bun:test';
import { verifyRequest } from '@buildd/dispatch-contract';
import { CALLBACK_PATHS, createProducerClient, parseResolveResponse } from './producer';
import { recordingFetch } from './test-support';

const RING = { c1: 'callback-secret' };

describe('producer client', () => {
  test('signs callbacks with the first ring key, verifiable by the producer', async () => {
    const f = recordingFetch(() => Response.json({ decision: 'decline', why: 'no' }));
    const c = createProducerClient({ server: 'https://producer.example/', ring: RING, fetch: f.fn });
    expect(await c.resolve({ id: 'i', attempt: 1, target: 't' })).toEqual({ decision: 'decline', why: 'no' });
    const call = f.calls[0]!;
    expect(call.url).toBe(`https://producer.example${CALLBACK_PATHS.resolve}`);
    const headers = new Headers(call.init.headers);
    const v = await verifyRequest({ keys: RING, method: 'POST', path: CALLBACK_PATHS.resolve, body: call.init.body as string, headers });
    expect(v).toEqual({ ok: true, keyId: 'c1' });
  });

  test('not configured without a server or a ring, and sends nothing', async () => {
    const f = recordingFetch();
    for (const c of [
      createProducerClient({ server: undefined, ring: RING, fetch: f.fn }),
      createProducerClient({ server: 'https://producer.example', ring: {}, fetch: f.fn }),
    ]) {
      expect(c.configured).toBe(false);
      await expect(c.resolve({ id: 'i', attempt: 1, target: 't' })).rejects.toThrow('not_configured');
      expect(await c.sendReceipts([])).toBe(false);
    }
    expect(f.calls).toHaveLength(0);
  });

  test('non-2xx and malformed answers throw (retryable); receipts report false', async () => {
    const c503 = createProducerClient({ server: 'https://p.example', ring: RING, fetch: recordingFetch(() => new Response('x', { status: 503 })).fn });
    await expect(c503.relay({ id: 'i', attempt: 1, target: 't' })).rejects.toThrow('relay_http_503');
    expect(await c503.sendReceipts([{ id: 'i', attempt: 1, event: 'delivered', at: 'x' }])).toBe(false);
    const bad = createProducerClient({ server: 'https://p.example', ring: RING, fetch: recordingFetch(() => Response.json({ decision: 'maybe' })).fn });
    await expect(bad.resolve({ id: 'i', attempt: 1, target: 't' })).rejects.toThrow('resolve_bad_response');
  });

  test('parseResolveResponse', () => {
    expect(parseResolveResponse({ decision: 'deliver', payload: {}, grant: { url: 'u', headers: { a: 1 } } })).toBeNull();
    expect(parseResolveResponse({ decision: 'reschedule', notBefore: 'soon' })).toBeNull();
    expect(parseResolveResponse({ decision: 'skip', why: 'held' })).toEqual({ decision: 'skip', why: 'held' });
  });
});
