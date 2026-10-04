import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { signRequest } from '@buildd/dispatch-contract';

// Callback auth and the per-key rate limit (docs/specs/task-dispatch-authority.md,
// invariant 21). The limiter is injected; the Redis counter itself is a
// fixed-window INCR (lib/redis.ts incrWindow).

const { verifyDispatchCallback, callbackRateLimit, CALLBACK_RATE_LIMIT } = await import('./dispatch-callback-auth');

const PATH = '/api/dispatch/v1/resolve';
let saved: string | undefined;
beforeEach(() => { saved = process.env.DISPATCH_CALLBACK_SECRET; process.env.DISPATCH_CALLBACK_SECRET = 'k1:cb-one,k2:cb-two'; });
afterEach(() => { if (saved === undefined) delete process.env.DISPATCH_CALLBACK_SECRET; else process.env.DISPATCH_CALLBACK_SECRET = saved; });

async function signed(keyId = 'k1', secret = 'cb-one', payload: unknown = { id: 'x' }) {
  const body = JSON.stringify(payload);
  const headers = await signRequest({ keyId, secret, method: 'POST', path: PATH, body });
  return new Request(`https://buildd.test${PATH}`, { method: 'POST', headers, body });
}

describe('verifyDispatchCallback rate limit', () => {
  it('under the limit: verified as before, and the bucket is the key id', async () => {
    const hit = mock(async (_key: string) => ({ allowed: true as const }));
    const v = await verifyDispatchCallback(await signed(), { limit: hit });
    expect(v.ok).toBe(true);
    expect(hit).toHaveBeenCalledWith('k1');
    await verifyDispatchCallback(await signed('k2', 'cb-two'), { limit: hit });
    expect(hit).toHaveBeenLastCalledWith('k2');
  });

  it('over the limit: 429 with Retry-After, and nothing past auth runs', async () => {
    const hit = mock(async () => ({ allowed: false as const, retryAfterSec: 7 }));
    const v = await verifyDispatchCallback(await signed(), { limit: hit });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.response.status).toBe(429);
    expect(v.response.headers.get('Retry-After')).toBe('7');
    expect(await v.response.json()).toEqual({ error: 'rate_limited' });
  });

  it('a forged or unsigned request is refused before the counter: it cannot spend a real key\'s budget', async () => {
    const hit = mock(async () => ({ allowed: true as const }));
    const v = await verifyDispatchCallback(await signed('k1', 'wrong'), { limit: hit });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.response.status).toBe(401);
    expect(hit).not.toHaveBeenCalled();
  });
});

describe('callbackRateLimit', () => {
  const W = CALLBACK_RATE_LIMIT.windowSec;
  const at = (s: number) => s * 1000;

  it('allows up to the limit per window per key, then answers with the seconds left in the window', async () => {
    const counts = new Map<string, number>();
    const incr = mock(async (key: string, _ttl: number) => { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return n; });
    const now = at(W * 1000 + 3); // 3 s into a window
    for (let i = 0; i < CALLBACK_RATE_LIMIT.limit; i++) expect(await callbackRateLimit('k1', { incr, now: () => now })).toEqual({ allowed: true });
    expect(await callbackRateLimit('k1', { incr, now: () => now })).toEqual({ allowed: false, retryAfterSec: W - 3 });
    // Another key id has its own bucket; the next window starts fresh.
    expect(await callbackRateLimit('k2', { incr, now: () => now })).toEqual({ allowed: true });
    expect(await callbackRateLimit('k1', { incr, now: () => at(W * 1001) })).toEqual({ allowed: true });
    expect(incr.mock.calls[0][0]).toBe(`buildd:dispatch:rl:k1:${1000}`);
    expect(incr.mock.calls[0][1]).toBeGreaterThan(W);
  });

  it('fails open with a (throttled) warning when Redis is unconfigured or erroring', async () => {
    const warn = mock(() => {});
    const orig = console.warn;
    console.warn = warn;
    try {
      const incr = mock(async () => null);
      expect(await callbackRateLimit('k1', { incr, now: () => 0 })).toEqual({ allowed: true });
      expect(await callbackRateLimit('k1', { incr, now: () => 1000 })).toEqual({ allowed: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String((warn.mock.calls[0] as unknown[])[0])).toContain('rate limit unavailable');
    } finally {
      console.warn = orig;
    }
  });
});
