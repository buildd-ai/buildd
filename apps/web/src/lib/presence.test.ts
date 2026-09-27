import { describe, it, expect } from 'bun:test';
import { getPresence, recordBeat, presenceKey, PRESENCE_TTL_SEC, type PresenceStore } from './presence';

const USER = 'user-1';

/** In-memory sorted set per key; `unavailable` mimics no Redis. */
function memoryStore(opts: { unavailable?: boolean } = {}) {
  const sets = new Map<string, Map<string, number>>();
  const ttls = new Map<string, number>();
  const store: PresenceStore = {
    async add(key, member, expiresAtMs, ttlSec, nowMs) {
      if (opts.unavailable) return false;
      const s = sets.get(key) ?? new Map<string, number>();
      s.set(member, expiresAtMs);
      for (const [m, exp] of s) if (exp <= nowMs) s.delete(m);
      sets.set(key, s);
      ttls.set(key, ttlSec);
      return true;
    },
    async remove(key, member) { sets.get(key)?.delete(member); },
    async live(key, nowMs) {
      if (opts.unavailable) return undefined;
      return [...(sets.get(key) ?? new Map()).entries()].filter(([, exp]) => exp > nowMs).map(([m]) => m);
    },
  };
  return { store, sets, ttls };
}

const t0 = new Date('2026-09-27T12:00:00.000Z');
const at = (sec: number) => () => new Date(t0.getTime() + sec * 1000);

describe('presence', () => {
  it('a visible beat makes the person present for 75s', async () => {
    const { store, ttls } = memoryStore();
    await recordBeat(USER, { visible: true, conversationId: 'c-1', tabId: 'tab-a' }, { store, now: at(0) });
    expect(PRESENCE_TTL_SEC).toBe(75);
    expect(ttls.get(presenceKey(USER))).toBe(75);
    expect(await getPresence(USER, { store, now: at(74) })).toEqual({ state: 'present', conversationId: 'c-1' });
    expect((await getPresence(USER, { store, now: at(76) })).state).toBe('away');
  });

  it('no beat means away', async () => {
    const { store } = memoryStore();
    expect((await getPresence(USER, { store, now: at(0) })).state).toBe('away');
  });

  it('a hidden beat clears that tab: a hidden tab counts as away', async () => {
    const { store } = memoryStore();
    await recordBeat(USER, { visible: true, conversationId: null, tabId: 'tab-a' }, { store, now: at(0) });
    await recordBeat(USER, { visible: false, conversationId: null, tabId: 'tab-a' }, { store, now: at(1) });
    expect((await getPresence(USER, { store, now: at(2) })).state).toBe('away');
  });

  it('two tabs: hiding one leaves the person present through the other', async () => {
    const { store } = memoryStore();
    await recordBeat(USER, { visible: true, conversationId: 'c-1', tabId: 'tab-a' }, { store, now: at(0) });
    await recordBeat(USER, { visible: true, conversationId: 'c-2', tabId: 'tab-b' }, { store, now: at(0) });
    await recordBeat(USER, { visible: false, conversationId: 'c-1', tabId: 'tab-a' }, { store, now: at(1) });
    expect(await getPresence(USER, { store, now: at(2) })).toEqual({ state: 'present', conversationId: 'c-2' });
  });

  it('a late hidden beacon from a replaced page does not clear the new page', async () => {
    const { store } = memoryStore();
    // Page 1 (tab id 1) navigates to page 2 (tab id 2); page 2's visible beat
    // lands before page 1's hidden beacon.
    await recordBeat(USER, { visible: true, conversationId: 'c-1', tabId: 'mount-1' }, { store, now: at(0) });
    await recordBeat(USER, { visible: true, conversationId: 'c-2', tabId: 'mount-2' }, { store, now: at(1) });
    await recordBeat(USER, { visible: false, conversationId: 'c-1', tabId: 'mount-1' }, { store, now: at(2) });
    expect(await getPresence(USER, { store, now: at(3) })).toEqual({ state: 'present', conversationId: 'c-2' });
  });

  it('Redis missing reads as away (an extra ping, never a missed one)', async () => {
    const { store } = memoryStore({ unavailable: true });
    const beat = await recordBeat(USER, { visible: true, conversationId: null, tabId: 't' }, { store, now: at(0) });
    expect(beat.stored).toBe(false);
    expect(await getPresence(USER, { store, now: at(0) })).toEqual({ state: 'away', reason: 'unavailable' });
  });

  it('a store that throws reads as away', async () => {
    const store: PresenceStore = {
      add: async () => { throw new Error('boom'); },
      remove: async () => { throw new Error('boom'); },
      live: async () => { throw new Error('boom'); },
    };
    expect((await getPresence(USER, { store })).state).toBe('away');
    expect((await recordBeat(USER, { visible: true, conversationId: null }, { store })).stored).toBe(false);
  });

  it('malformed members read as away', async () => {
    const store: PresenceStore = { add: async () => true, remove: async () => {}, live: async () => ['garbage', 7 as never] };
    expect((await getPresence(USER, { store })).state).toBe('away');
  });

  it('keeps the signature other callers use: getPresence(userId) -> { state }', async () => {
    const { store } = memoryStore();
    const p = await getPresence(USER, { store });
    expect(['present', 'away']).toContain(p.state);
  });
});
