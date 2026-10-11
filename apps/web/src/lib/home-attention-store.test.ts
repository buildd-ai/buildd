import { describe, expect, it } from 'bun:test';

// A page opened directly (not via Home) shows the badge Home last published,
// read back from storage; an old value is ignored rather than shown stale.
const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } } };
type Store = typeof import('./home-attention-store');
const fresh = (tag: string) => import(`./home-attention-store?${tag}`) as Promise<Store>;

describe('home attention count survives a direct page load', () => {
  it('publish writes the count to storage', async () => {
    const m = await fresh('a');
    m.publishHomeAttentionCount(7);
    expect(JSON.parse(store.get('buildd.homeAttentionCount')!).n).toBe(7);
    expect(m.readHomeAttentionCount()).toBe(7);
  });
  it('a fresh page reads a recent count and ignores an old one', async () => {
    store.set('buildd.homeAttentionCount', JSON.stringify({ n: 4, at: Date.now() }));
    expect((await fresh('b')).readHomeAttentionCount()).toBe(4);
    store.set('buildd.homeAttentionCount', JSON.stringify({ n: 9, at: Date.now() - 60 * 60_000 }));
    expect((await fresh('c')).readHomeAttentionCount()).toBeNull();
  });
});
