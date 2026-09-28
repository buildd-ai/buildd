'use client';

/**
 * The new-chat composer's state, shared by every place an app starts a chat
 * (a home card, the chat page, a canvas): the unsent draft, the scope and the
 * tier. Generalised from buildd's `components/chat/composer-store.ts`.
 *
 * Create one store at module scope, so it survives client navigation between
 * those places. It is keyed (e.g. by team or household): a draft or scope
 * never crosses keys.
 *
 * Persistence is the app's, through `ComposerPrefsAdapter`:
 * - `load(key)` seeds the person's last scope and tier once per key (apply any
 *   policy, like a team's tier cap, on the server before returning it);
 * - `save(key, patch)` remembers a choice, so the next new chat on any device
 *   starts there.
 * A field the person already changed is never overwritten by a seed that lands
 * late. The draft is not persisted (in memory only).
 *
 * Existing conversations keep their own pin; call `store.setScope` /
 * `store.setTier` from their pickers too if a choice there should also be the
 * next new chat's default (buildd does).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/** Absent = never chosen (keep the current value); null = chosen "all" / "Auto". */
export interface ComposerSeed {
  scope?: string | null;
  tier?: string | null;
}

export interface ComposerPrefsAdapter {
  load(key: string): Promise<ComposerSeed | null> | ComposerSeed | null;
  save(key: string, patch: ComposerSeed): Promise<void> | void;
}

export interface ComposerSnapshot {
  key: string | null;
  draft: string;
  /** Null = all. */
  scope: string | null;
  /** Null = Auto. */
  tier: string | null;
  seeded: boolean;
  /** Fields the person set before the seed arrived. */
  touched: { scope: boolean; tier: boolean };
}

const EMPTY: ComposerSnapshot = { key: null, draft: '', scope: null, tier: null, seeded: false, touched: { scope: false, tier: false } };

/** Pure: a seed never overwrites what the person already chose. */
export function applyComposerSeed(s: ComposerSnapshot, seed: ComposerSeed | null): ComposerSnapshot {
  if (!seed) return { ...s, seeded: true };
  return {
    ...s,
    seeded: true,
    scope: s.touched.scope || seed.scope === undefined ? s.scope : seed.scope,
    tier: s.touched.tier || seed.tier === undefined ? s.tier : seed.tier,
  };
}

export interface ComposerStore {
  get(): ComposerSnapshot;
  subscribe(fn: () => void): () => void;
  /** Seed once per key from the adapter. Concurrent callers share one load. */
  seed(key: string): Promise<void>;
  setDraft(key: string, draft: string): void;
  /** The person picked a scope: use it and remember it. */
  setScope(key: string, scope: string | null): void;
  /** The person picked a tier: use it and remember it. */
  setTier(key: string, tier: string | null): void;
  /** Tests. */
  reset(): void;
}

export function createComposerStore(opts: { prefs?: ComposerPrefsAdapter; onError?(e: unknown): void } = {}): ComposerStore {
  let state: ComposerSnapshot = EMPTY;
  let seeding: { key: string; promise: Promise<void> } | null = null;
  const listeners = new Set<() => void>();
  const set = (next: ComposerSnapshot) => { state = next; for (const l of listeners) l(); };
  const forKey = (key: string) => (state.key === key ? state : { ...EMPTY, key });
  const remember = (key: string, patch: ComposerSeed) => {
    try {
      void Promise.resolve(opts.prefs?.save(key, patch)).catch(e => opts.onError?.(e));
    } catch (e) { opts.onError?.(e); }
  };
  return {
    get: () => state,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    seed(key) {
      if (state.key === key && state.seeded) return Promise.resolve();
      if (seeding?.key === key) return seeding.promise;
      set(forKey(key));
      if (!opts.prefs) { set({ ...state, seeded: true }); return Promise.resolve(); }
      const promise = (async () => {
        let seed: ComposerSeed | null = null;
        try { seed = await opts.prefs!.load(key); } catch (e) { opts.onError?.(e); }
        if (state.key !== key) return; // the key changed while loading
        set(applyComposerSeed(state, seed));
      })().finally(() => { if (seeding?.key === key) seeding = null; });
      seeding = { key, promise };
      return promise;
    },
    setDraft(key, draft) { set({ ...forKey(key), draft }); },
    setScope(key, scope) {
      const s = forKey(key);
      set({ ...s, scope, touched: { ...s.touched, scope: true } });
      remember(key, { scope });
    },
    setTier(key, tier) {
      const s = forKey(key);
      set({ ...s, tier, touched: { ...s.touched, tier: true } });
      remember(key, { tier });
    },
    reset() { state = EMPTY; seeding = null; },
  };
}

const serverSnapshot = () => EMPTY;

/**
 * The shared composer for `key`. `pageScope` is the page's own scope (an
 * object's workspace, a `?scope=` param): it wins until the person picks
 * another. With `scopes`, a remembered scope that isn't one of them reads as
 * all. Wire the result to `<ChatComposer value onChange>`, `<ScopePicker value
 * onChange>` and `<TierPicker value onChange>`.
 */
export function useComposerState(store: ComposerStore, key: string, opts: { scopes?: readonly { id: string }[]; pageScope?: string | null } = {}) {
  const snap = useSyncExternalStore(store.subscribe, store.get, serverSnapshot);
  const [pageScope, setPageScope] = useState(opts.pageScope ?? null);
  useEffect(() => { void store.seed(key); }, [store, key]);
  const mine = snap.key === key ? snap : { ...EMPTY, key };
  const picked = pageScope ?? mine.scope;
  const scope = picked && (!opts.scopes || opts.scopes.some(s => s.id === picked)) ? picked : null;
  return {
    draft: mine.draft,
    scope,
    tier: mine.tier,
    seeded: mine.seeded,
    setDraft: useCallback((d: string) => store.setDraft(key, d), [store, key]),
    setScope: useCallback((s: string | null) => { setPageScope(null); store.setScope(key, s); }, [store, key]),
    setTier: useCallback((t: string | null) => store.setTier(key, t), [store, key]),
  };
}
