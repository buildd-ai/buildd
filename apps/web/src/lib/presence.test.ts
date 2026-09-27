import { describe, it, expect } from 'bun:test';
import { getPresence, recordBeat, presenceKey, PRESENCE_TTL_SEC, type PresenceStore } from './presence';

const USER = 'user-1';

/** In-memory store; `unavailable` mimics no Redis (every read answers "could not ask"). */
function memoryStore(opts: { unavailable?: boolean } = {}) {
  const data = new Map<string, { value: unknown; ttl: number }>();
  const store: PresenceStore = {
    async set(key, value, ttl) {
      if (opts.unavailable) return false;
      data.set(key, { value, ttl });
      return true;
    },
    async get(key) {
      if (opts.unavailable) return undefined;
      return (data.get(key)?.value ?? null) as never;
    },
    async del(key) { data.delete(key); },
  };
  return { store, data };
}

const now = new Date('2026-09-27T12:00:00.000Z');

describe('presence', () => {
  it('a visible beat writes presence:<userId> with a 75s TTL', async () => {
    const { store, data } = memoryStore();
    await recordBeat(USER, { visible: true, conversationId: 'c-1' }, { store, now: () => now });
    const row = data.get(presenceKey(USER));
    expect(PRESENCE_TTL_SEC).toBe(75);
    expect(row?.ttl).toBe(75);
    expect(row?.value).toEqual({ conversationId: 'c-1', at: now.toISOString() });
    expect(await getPresence(USER, { store })).toEqual({ state: 'present', conversationId: 'c-1' });
  });

  it('no key means away', async () => {
    const { store } = memoryStore();
    expect((await getPresence(USER, { store })).state).toBe('away');
  });

  it('a hidden beat clears the key: a hidden tab counts as away', async () => {
    const { store } = memoryStore();
    await recordBeat(USER, { visible: true, conversationId: null }, { store, now: () => now });
    await recordBeat(USER, { visible: false, conversationId: null }, { store, now: () => now });
    expect((await getPresence(USER, { store })).state).toBe('away');
  });

  it('Redis missing reads as away (an extra ping, never a missed one)', async () => {
    const { store } = memoryStore({ unavailable: true });
    const beat = await recordBeat(USER, { visible: true, conversationId: null }, { store, now: () => now });
    expect(beat.stored).toBe(false);
    expect(await getPresence(USER, { store })).toEqual({ state: 'away', reason: 'unavailable' });
  });

  it('a store that throws reads as away', async () => {
    const store: PresenceStore = {
      set: async () => { throw new Error('boom'); },
      get: async () => { throw new Error('boom'); },
      del: async () => { throw new Error('boom'); },
    };
    expect((await getPresence(USER, { store })).state).toBe('away');
    expect((await recordBeat(USER, { visible: true, conversationId: null }, { store })).stored).toBe(false);
  });

  it('a malformed value reads as away', async () => {
    const { store, data } = memoryStore();
    data.set(presenceKey(USER), { value: 'garbage', ttl: 75 });
    expect((await getPresence(USER, { store })).state).toBe('away');
  });
});
