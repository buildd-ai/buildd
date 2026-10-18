/**
 * An in-memory stand-in for the parts of lib/redis.ts that lib/caller-cache.ts
 * uses, for tests: `mock.module('./redis', () => fakeRedis.module)` before
 * importing the code under test. `down` answers the way redis.ts does when
 * the client errors; `configured: false` the way it does with no client.
 */
export function createFakeRedis() {
  const store = new Map<string, unknown>();
  const ttls = new Map<string, number>();
  const state = { configured: true, down: false };
  const module = {
    isRedisConfigured: () => state.configured,
    getKey: async (k: string) => (state.down ? undefined : (store.get(k) ?? null)),
    getKeys: async (ks: string[]) => (state.down ? undefined : ks.map((k) => store.get(k) ?? null)),
    setWithTtl: async (k: string, v: unknown, ttlSec: number) => {
      if (state.down) return false;
      ttls.set(k, ttlSec);
      // Round-trip through JSON like the real client (Dates become strings).
      store.set(k, JSON.parse(JSON.stringify(v)));
      return true;
    },
    delKey: async (k: string) => { store.delete(k); },
  };
  return {
    module,
    state,
    store,
    ttls,
    reset() {
      store.clear();
      ttls.clear();
      state.configured = true;
      state.down = false;
    },
  };
}
