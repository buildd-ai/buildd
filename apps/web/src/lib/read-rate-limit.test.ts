import { describe, it, expect, mock } from 'bun:test';
import {
  READ_RATE_DEFAULTS,
  readRateConfig,
  limitsFor,
  classifyApiRead,
  decideBucket,
  bucketParams,
  gateApiRead,
  rateLimitedResponse,
  readSubjectForKey,
  readSubjectForUser,
} from './read-rate-limit';

const NOW = 1_800_000_000_000;

describe('readRateConfig: constants with env overrides', () => {
  it('defaults: free 120 read / 30 poll per minute, paid 4x, burst 2x', () => {
    expect(readRateConfig({})).toEqual(READ_RATE_DEFAULTS);
    expect(READ_RATE_DEFAULTS).toEqual({ freeReadPerMin: 120, freePollPerMin: 30, paidMultiplier: 4, burstMultiplier: 2, enabled: true });
  });

  it('an env var replaces one number; a bad value keeps the default', () => {
    const c = readRateConfig({ RATE_LIMIT_FREE_READ_PER_MIN: '200', RATE_LIMIT_PAID_MULTIPLIER: 'lots', RATE_LIMIT_BURST_MULTIPLIER: '-1' });
    expect(c.freeReadPerMin).toBe(200);
    expect(c.paidMultiplier).toBe(4);
    expect(c.burstMultiplier).toBe(2);
  });

  it('RATE_LIMIT_READS=off turns the limiter off', () => {
    expect(readRateConfig({ RATE_LIMIT_READS: 'off' }).enabled).toBe(false);
  });
});

describe('limitsFor: free vs paid', () => {
  const c = READ_RATE_DEFAULTS;
  it('free plan gets the base numbers, burst 2x', () => {
    expect(limitsFor('free', 'read', c)).toEqual({ perMinute: 120, burst: 240 });
    expect(limitsFor('free', 'poll', c)).toEqual({ perMinute: 30, burst: 60 });
  });

  it('every paid plan gets 4x', () => {
    for (const plan of ['pro', 'team'] as const) {
      expect(limitsFor(plan, 'read', c)).toEqual({ perMinute: 480, burst: 960 });
      expect(limitsFor(plan, 'poll', c)).toEqual({ perMinute: 120, burst: 240 });
    }
  });

  it('bucketParams: the refill interval is a whole number of ms', () => {
    expect(bucketParams({ perMinute: 120, burst: 240 })).toEqual({ intervalMs: 500, burst: 240 });
    expect(bucketParams({ perMinute: 7, burst: 14 })).toEqual({ intervalMs: 8571, burst: 14 });
  });
});

describe('classifyApiRead: what is counted', () => {
  it('list and polling endpoints are the poll class', () => {
    expect(classifyApiRead('GET', '/api/missions/stages')).toBe('poll');
    expect(classifyApiRead('GET', '/api/missions/recent')).toBe('poll');
    expect(classifyApiRead('GET', '/api/tasks')).toBe('poll');
  });

  it('other GETs under /api are the read class', () => {
    expect(classifyApiRead('GET', '/api/tasks/0b7c1e2a-0000-4000-8000-000000000000')).toBe('read');
    expect(classifyApiRead('GET', '/api/missions')).toBe('read');
    expect(classifyApiRead('HEAD', '/api/workspaces')).toBe('read');
  });

  it('writes are not read APIs', () => {
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) expect(classifyApiRead(m, '/api/tasks')).toBeNull();
  });

  it('runner coordination is exempt, whatever the method', () => {
    const id = '0b7c1e2a-0000-4000-8000-000000000000';
    for (const m of ['GET', 'POST', 'PATCH']) {
      expect(classifyApiRead(m, '/api/workers/claim')).toBeNull();
      expect(classifyApiRead(m, '/api/workers/queue')).toBeNull();
      expect(classifyApiRead(m, '/api/workers/heartbeat')).toBeNull();
      expect(classifyApiRead(m, `/api/workers/${id}`)).toBeNull();
      expect(classifyApiRead(m, `/api/workers/${id}/prompt-bundles`)).toBeNull();
    }
  });

  it('auth, cron, webhooks and OAuth are exempt', () => {
    expect(classifyApiRead('GET', '/api/auth/session')).toBeNull();
    expect(classifyApiRead('GET', '/api/cron/schedules')).toBeNull();
    expect(classifyApiRead('GET', '/api/webhooks/github')).toBeNull();
    expect(classifyApiRead('GET', '/api/oauth/authorize')).toBeNull();
  });

  it('pages and non-API paths are never counted', () => {
    expect(classifyApiRead('GET', '/app/home')).toBeNull();
    expect(classifyApiRead('GET', '/apiary')).toBeNull();
  });
});

describe('decideBucket: token bucket math (GCRA)', () => {
  const p = { intervalMs: 500, burst: 240 };

  it('an empty bucket allows a full burst at once, then refuses', () => {
    let tat: number | null = null;
    for (let i = 0; i < 240; i++) {
      const d = decideBucket(tat, NOW, p);
      expect(d.allowed).toBe(true);
      tat = d.tat;
    }
    const over = decideBucket(tat, NOW, p);
    expect(over.allowed).toBe(false);
    // One token comes back after one interval.
    expect(over.retryAfterMs).toBe(500);
    expect(over.tat).toBe(tat);
  });

  it('refills at the per-minute rate: one more allowed per interval', () => {
    let tat: number | null = null;
    for (let i = 0; i < 240; i++) tat = decideBucket(tat, NOW, p).tat;
    expect(decideBucket(tat, NOW + 499, p).allowed).toBe(false);
    const after = decideBucket(tat, NOW + 500, p);
    expect(after.allowed).toBe(true);
    expect(decideBucket(after.tat, NOW + 500, p).allowed).toBe(false);
  });

  it('steady traffic at the rate never trips', () => {
    let tat: number | null = null;
    for (let i = 0; i < 1000; i++) {
      const d = decideBucket(tat, NOW + i * 500, p);
      expect(d.allowed).toBe(true);
      tat = d.tat;
    }
  });

  it('a stale TAT in the past is a full bucket', () => {
    const d = decideBucket(NOW - 60_000, NOW, p);
    expect(d.allowed).toBe(true);
    expect(d.tat).toBe(NOW + 500);
  });

  it('a refused request does not move the TAT', () => {
    const full = NOW + 240 * 500;
    const d = decideBucket(full, NOW, p);
    expect(d.allowed).toBe(false);
    expect(d.tat).toBe(full);
  });
});

describe('subjects', () => {
  it('a key subject is a hash, never the key', () => {
    const s = readSubjectForKey('bld_secret_value');
    expect(s.startsWith('key:')).toBe(true);
    expect(s).not.toContain('secret');
    expect(readSubjectForKey('bld_secret_value')).toBe(s);
    expect(readSubjectForKey('bld_other')).not.toBe(s);
  });

  it('a user subject is the user id', () => {
    expect(readSubjectForUser('u1')).toBe('user:u1');
  });
});

describe('rateLimitedResponse: the 429 shape', () => {
  it('429, Retry-After in whole seconds, JSON body naming the limit', async () => {
    const res = rateLimitedResponse({ allowed: false, retryAfterSec: 3, cls: 'poll', limitPerMin: 30 });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.code).toBe('rate_limited');
    expect(body.retryAfterSec).toBe(3);
    expect(body.limitPerMin).toBe(30);
    expect(typeof body.error).toBe('string');
  });
});

describe('gateApiRead', () => {
  const req = (path: string, method = 'GET') => ({ method, pathname: path });

  it('exempt routes never reach the bucket', async () => {
    const bucket = mock(async () => ({ allowed: false, retryAfterMs: 1000, plan: 'free' }));
    const v = await gateApiRead(req('/api/workers/claim', 'POST'), 'key:x', { bucket, now: () => NOW });
    expect(v).toEqual({ allowed: true });
    await gateApiRead(req('/api/workers/heartbeat'), 'key:x', { bucket, now: () => NOW });
    expect(bucket).not.toHaveBeenCalled();
  });

  it('no subject (unauthenticated) is not counted: the route answers 401 itself', async () => {
    const bucket = mock(async () => ({ allowed: false, retryAfterMs: 1000, plan: 'free' }));
    expect(await gateApiRead(req('/api/tasks'), null, { bucket })).toEqual({ allowed: true });
    expect(bucket).not.toHaveBeenCalled();
  });

  it('passes the class bucket key, the plan key and both plans\' params', async () => {
    const bucket = mock(async (_a: unknown) => ({ allowed: true, retryAfterMs: 0, plan: 'free' }));
    await gateApiRead(req('/api/tasks'), 'key:abc', { bucket, now: () => NOW });
    expect(bucket).toHaveBeenCalledWith({
      bucketKey: 'buildd:rl:poll:key:abc',
      planKey: 'buildd:rl:plan:key:abc',
      nowMs: NOW,
      free: { intervalMs: 2000, burst: 60 },
      paid: { intervalMs: 500, burst: 240 },
    });
  });

  it('over the limit: refused with whole-second Retry-After and the plan\'s limit', async () => {
    const bucket = mock(async () => ({ allowed: false, retryAfterMs: 1200, plan: 'free' }));
    const v = await gateApiRead(req('/api/missions/recent'), 'key:abc', { bucket, now: () => NOW });
    expect(v).toEqual({ allowed: false, retryAfterSec: 2, cls: 'poll', limitPerMin: 30 });
  });

  it('a paid or unknown plan reports the paid limit', async () => {
    const bucket = mock(async () => ({ allowed: false, retryAfterMs: 10, plan: '' }));
    const v = await gateApiRead(req('/api/missions'), 'key:abc', { bucket, now: () => NOW });
    expect(v).toEqual({ allowed: false, retryAfterSec: 1, cls: 'read', limitPerMin: 480 });
  });

  it('fails open when Redis throws', async () => {
    const bucket = mock(async () => { throw new Error('ECONNRESET'); });
    expect(await gateApiRead(req('/api/tasks'), 'key:abc', { bucket, now: () => NOW })).toEqual({ allowed: true });
  });

  it('fails open when Redis is not configured (bucket answers null)', async () => {
    const bucket = mock(async () => null);
    expect(await gateApiRead(req('/api/tasks'), 'key:abc', { bucket, now: () => NOW })).toEqual({ allowed: true });
  });

  it('switched off: nothing is counted', async () => {
    const bucket = mock(async () => ({ allowed: false, retryAfterMs: 1000, plan: 'free' }));
    const v = await gateApiRead(req('/api/tasks'), 'key:abc', { bucket, config: { ...READ_RATE_DEFAULTS, enabled: false } });
    expect(v).toEqual({ allowed: true });
    expect(bucket).not.toHaveBeenCalled();
  });
});
