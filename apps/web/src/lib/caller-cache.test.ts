import { describe, it, expect, beforeEach, mock } from 'bun:test';

// In-memory stand-in for lib/redis.ts. `down` makes every op answer the way
// redis.ts does when the client errors (undefined / false).
const store = new Map<string, { v: unknown; ttl: number }>();
const fake = { configured: true, down: false };
const ops: string[] = [];

mock.module('./redis', () => ({
  isRedisConfigured: () => fake.configured,
  getKey: async (k: string) => { ops.push(`get ${k}`); return fake.down ? undefined : (store.get(k)?.v ?? null); },
  getKeys: async (ks: string[]) => { ops.push(`mget ${ks.length}`); return fake.down ? undefined : ks.map(k => store.get(k)?.v ?? null); },
  setWithTtl: async (k: string, v: unknown, ttl: number) => {
    if (fake.down) return false;
    // Round-trip through JSON like the real client.
    store.set(k, { v: JSON.parse(JSON.stringify(v)), ttl });
    return true;
  },
  delKey: async (k: string) => { store.delete(k); },
}));

import { cachedCaller, clearCallerCache, dropCallerEntry, callerDep, CALLER_CACHE_MAX_TTL_SEC } from './caller-cache';

beforeEach(() => {
  store.clear();
  ops.length = 0;
  fake.configured = true;
  fake.down = false;
});

describe('cachedCaller', () => {
  it('loads once, then answers from the cache', async () => {
    const load = mock(async () => ({ id: 'a1' }));
    for (let i = 0; i < 100; i++) {
      expect(await cachedCaller('k', load, { known: [callerDep.account('a1')] })).toEqual({ id: 'a1' });
    }
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never stores a refusal: a grant made after a null is seen on the next call', async () => {
    let granted = false;
    const load = mock(async () => (granted ? { ok: true } : null));
    expect(await cachedCaller('k', load)).toBeNull();
    expect(await cachedCaller('k', load)).toBeNull();
    granted = true;
    expect(await cachedCaller('k', load)).toEqual({ ok: true });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('a clear on a known dep ends the entry at once', async () => {
    let level = 'admin';
    const load = mock(async () => ({ level }));
    const opts = { known: [callerDep.user('u1')] };
    expect(await cachedCaller('k', load, opts)).toEqual({ level: 'admin' });
    level = 'worker';
    expect(await cachedCaller('k', load, opts)).toEqual({ level: 'admin' });
    await clearCallerCache(callerDep.user('u1'));
    expect(await cachedCaller('k', load, opts)).toEqual({ level: 'worker' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a clear on a dep only the value names ends the entry too', async () => {
    const load = mock(async () => ({ workspaceIds: ['w1', 'w2'] }));
    const opts = { depsOf: (v: { workspaceIds: string[] }) => v.workspaceIds.map(callerDep.workspace) };
    await cachedCaller('k', load, opts);
    await cachedCaller('k', load, opts);
    expect(load).toHaveBeenCalledTimes(1);
    await clearCallerCache(callerDep.workspace('w2'));
    await cachedCaller('k', load, opts);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a clear racing the load leaves the entry stale, not fresh', async () => {
    let calls = 0;
    const load = async () => {
      calls++;
      // The change (and its clear) lands while the old answer is being read.
      if (calls === 1) await clearCallerCache(callerDep.grant('g1'));
      return { calls };
    };
    const opts = { known: [callerDep.grant('g1')] };
    expect(await cachedCaller('k', load, opts)).toEqual({ calls: 1 });
    expect(await cachedCaller('k', load, opts)).toEqual({ calls: 2 });
    expect(await cachedCaller('k', load, opts)).toEqual({ calls: 2 });
  });

  it('a generation that expires and is written again never matches an old entry', async () => {
    const load = mock(async () => ({ v: 1 }));
    const opts = { known: [callerDep.account('a1')] };
    await clearCallerCache(callerDep.account('a1'));
    await cachedCaller('k', load, opts);
    store.delete('buildd:caller-gen:account:a1'); // expired
    await clearCallerCache(callerDep.account('a1'));
    await cachedCaller('k', load, opts);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('caps the TTL at 60 s and skips values whose TTL is under a second', async () => {
    await cachedCaller('long', async () => ({ v: 1 }), { ttlSec: 3600 });
    expect(store.get('buildd:caller:long')?.ttl).toBe(CALLER_CACHE_MAX_TTL_SEC);
    await cachedCaller('fn', async () => ({ v: 1 }), { ttlSec: () => 12.7 });
    expect(store.get('buildd:caller:fn')?.ttl).toBe(12);
    await cachedCaller('expiring', async () => ({ v: 1 }), { ttlSec: () => 0.5 });
    expect(store.has('buildd:caller:expiring')).toBe(false);
  });

  it('treats a cached value failing `valid` as a miss', async () => {
    const load = mock(async () => ({ shape: 2 }));
    store.set('buildd:caller:k', { v: { v: { shape: 1 }, d: [], s: [] }, ttl: 60 });
    expect(await cachedCaller('k', load, { valid: (v: { shape: number }) => v.shape === 2 })).toEqual({ shape: 2 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('ignores an entry of the wrong shape', async () => {
    store.set('buildd:caller:k', { v: { id: 'forged' }, ttl: 60 });
    expect(await cachedCaller('k', async () => ({ id: 'real' }))).toEqual({ id: 'real' });
  });

  it('fails open to the loader when Redis is down, and stores nothing', async () => {
    fake.down = true;
    const load = mock(async () => ({ id: 'a1' }));
    expect(await cachedCaller('k', load)).toEqual({ id: 'a1' });
    expect(await cachedCaller('k', load)).toEqual({ id: 'a1' });
    expect(load).toHaveBeenCalledTimes(2);
    fake.down = false;
    expect(store.size).toBe(0);
  });

  it('goes straight to the loader when Redis is not configured', async () => {
    fake.configured = false;
    const load = mock(async () => ({ id: 'a1' }));
    await cachedCaller('k', load);
    await cachedCaller('k', load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(ops).toEqual([]);
  });

  it('propagates a loader error and stores nothing', async () => {
    await expect(cachedCaller('k', async () => { throw new Error('db down'); })).rejects.toThrow('db down');
    expect(store.has('buildd:caller:k')).toBe(false);
  });

  it('dropCallerEntry removes one entry', async () => {
    const load = mock(async () => ({ id: 'a1' }));
    await cachedCaller('k', load);
    await dropCallerEntry('k');
    await cachedCaller('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('clearCallerCache', () => {
  it('reports a write Redis could not take', async () => {
    fake.down = true;
    expect(await clearCallerCache(callerDep.user('u1'))).toBe(false);
  });

  it('is a no-op with no deps', async () => {
    expect(await clearCallerCache()).toBe(true);
    expect(store.size).toBe(0);
  });
});
