/** Ported from buildd's components/chat/composer-store.test.ts, against the app adapter instead of fetch. */
import { describe, expect, it } from 'bun:test';
import { applyComposerSeed, createComposerStore, tierPrefs, type ComposerSeed, type ComposerSnapshot } from './composer-store';
import { defineTierPolicy } from '@builddai/ai-kit/chat/contract';

const base: ComposerSnapshot = { key: 't', draft: '', scope: null, tier: null, seeded: false, touched: { scope: false, tier: false } };

function harness(seed: ComposerSeed | null = { scope: 'ws-1', tier: 'premium' }) {
  const loads: string[] = [];
  const saves: Array<[string, ComposerSeed]> = [];
  let release: () => void = () => {};
  const store = createComposerStore({
    prefs: {
      load: async key => { loads.push(key); await new Promise<void>(r => { release = r; }); return seed; },
      save: (key, patch) => { saves.push([key, patch]); },
    },
  });
  return { store, loads, saves, release: () => release() };
}

describe('applyComposerSeed', () => {
  it('takes the remembered scope and tier', () => {
    expect(applyComposerSeed(base, { scope: 'ws-1', tier: 'premium' })).toMatchObject({ scope: 'ws-1', tier: 'premium', seeded: true });
  });
  it('never overwrites a field already picked', () => {
    const s = { ...base, scope: 'ws-2', tier: 'budget', touched: { scope: true, tier: true } };
    expect(applyComposerSeed(s, { scope: 'ws-1', tier: 'premium' })).toMatchObject({ scope: 'ws-2', tier: 'budget' });
  });
  it('an absent field leaves the current value; null means all / Auto', () => {
    expect(applyComposerSeed({ ...base, scope: 'ws-2' }, { tier: null })).toMatchObject({ scope: 'ws-2', tier: null });
    expect(applyComposerSeed({ ...base, scope: 'ws-2' }, { scope: null }).scope).toBeNull();
    expect(applyComposerSeed(base, null)).toMatchObject({ seeded: true, scope: null });
  });
});

describe('createComposerStore', () => {
  it('seeds once per key, and a choice made while seeding wins and is remembered', async () => {
    const h = harness();
    const p = h.store.seed('t');
    void h.store.seed('t');
    h.store.setTier('t', 'budget');
    h.release();
    await p;
    expect(h.loads).toEqual(['t']);
    expect(h.store.get()).toMatchObject({ key: 't', scope: 'ws-1', tier: 'budget', seeded: true });
    expect(h.saves).toEqual([['t', { tier: 'budget' }]]);
    await h.store.seed('t');
    expect(h.loads).toEqual(['t']);
  });

  it('a draft and a scope survive between composers, never across keys', () => {
    const h = harness();
    h.store.setDraft('t', 'ship the thing');
    h.store.setScope('t', null);
    expect(h.store.get()).toMatchObject({ draft: 'ship the thing', scope: null });
    expect(h.saves.at(-1)).toEqual(['t', { scope: null }]);
    h.store.setDraft('t2', '');
    expect(h.store.get()).toMatchObject({ key: 't2', draft: '', seeded: false });
  });

  it('a seed that lands after the key changed is dropped; a failing adapter still seeds', async () => {
    const h = harness();
    const p = h.store.seed('t');
    h.store.setDraft('t2', 'x');
    h.release();
    await p;
    expect(h.store.get()).toMatchObject({ key: 't2', scope: null });
    const errors: unknown[] = [];
    const broken = createComposerStore({ prefs: { load: () => { throw new Error('down'); }, save: () => { throw new Error('down'); } }, onError: e => errors.push(e) });
    await broken.seed('t');
    broken.setTier('t', 'budget');
    expect(broken.get()).toMatchObject({ seeded: true, tier: 'budget' });
    expect(errors).toHaveLength(2);
  });

  it('without an adapter it is an in-memory shared draft', async () => {
    const store = createComposerStore();
    await store.seed('t');
    store.setScope('t', 'ws-9');
    expect(store.get()).toMatchObject({ seeded: true, scope: 'ws-9' });
  });
});

describe('createComposerStore with a tier policy (0.6.0)', () => {
  const policy = defineTierPolicy({ defaultTier: 'budget', auto: false, labels: { budget: 'Economy' } });

  it('starts on the app default, then the saved choice (saved → app default → kit default)', async () => {
    let saved: string | null = 'premium';
    const store = createComposerStore({ tiers: policy, prefs: tierPrefs({ load: () => saved, save: t => { saved = t; } }) });
    expect(store.initial.tier).toBe('budget');
    await store.seed('t');
    expect(store.get().tier).toBe('premium');

    saved = null;
    const fresh = createComposerStore({ tiers: policy, prefs: tierPrefs({ load: () => saved, save: () => {} }) });
    await fresh.seed('t');
    expect(fresh.get().tier).toBe('budget');

    const kit = createComposerStore({ prefs: tierPrefs({ load: () => null, save: () => {} }) });
    await kit.seed('t');
    expect(kit.get().tier).toBeNull(); // no policy: Auto, as before
  });

  it('a saved tier the app no longer offers reads as the default', async () => {
    const store = createComposerStore({ tiers: policy, prefs: tierPrefs({ load: () => 'premium-plus', save: () => {} }) });
    await store.seed('t');
    expect(store.get().tier).toBe('budget');
  });

  it('setTier saves an offered tier and ignores one that is not', async () => {
    const saves: Array<string | null> = [];
    const errors: unknown[] = [];
    const store = createComposerStore({ tiers: policy, onError: e => errors.push(e), prefs: tierPrefs({ load: () => null, save: t => { saves.push(t); } }) });
    store.setTier('t', 'standard');
    store.setTier('t', null);
    store.setTier('t', 'premium-plus');
    expect(store.get().tier).toBe('standard');
    expect(saves).toEqual(['standard']);
    expect(errors).toHaveLength(2);
  });

  it('peek seeds at once for the first paint; load still wins; a pick in between wins over both', async () => {
    let release: (v: string) => void = () => {};
    const store = createComposerStore({
      tiers: policy,
      prefs: tierPrefs({ peek: () => 'standard', load: () => new Promise<string>(r => { release = r; }), save: () => {} }),
    });
    const p = store.seed('t');
    expect(store.get()).toMatchObject({ tier: 'standard', seeded: false });
    release('premium');
    await p;
    expect(store.get()).toMatchObject({ tier: 'premium', seeded: true });

    const picked = createComposerStore({
      tiers: policy,
      prefs: tierPrefs({ peek: () => 'standard', load: () => new Promise<string>(r => { release = r; }), save: () => {} }),
    });
    const q = picked.seed('t');
    picked.setTier('t', 'budget');
    release('premium');
    await q;
    expect(picked.get().tier).toBe('budget');
  });

  it('tierPrefs ignores scope patches', () => {
    const saves: Array<string | null> = [];
    const a = tierPrefs({ load: () => null, save: t => { saves.push(t); } });
    void a.save('t', { scope: 'ws' });
    void a.save('t', { tier: 'budget' });
    expect(saves).toEqual(['budget']);
  });
});
