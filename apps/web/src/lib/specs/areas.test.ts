import { describe, expect, it, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));
const { proposeTaxonomy, domainHintOf, MAX_AREA_SHARE } = await import('./areas');
const { specCard } = await import('./card');

/** A spec card with a few topic words, so clustering has something to read. */
const item = (id: string, domain: string | null, words: string) => ({
  specId: id, title: `${words.split(' ')[0]} ${id}`, domainHint: domain,
  card: specCard(`${words.split(' ')[0]} ${id}`, `# x\n${words}.\n- **AC-1** ${words} ${words}.\n`),
});
const topics = {
  billing: 'invoice payment refund charge card',
  search: 'query index ranking filter facet',
  auth: 'login password session token signin',
  ui: 'button layout mobile screen theme',
  deploy: 'release rollout canary deploy production',
};

describe('proposeTaxonomy (R-4)', () => {
  it('AC-66: three distinct domain values give one proposal with one product and areas holding every spec', () => {
    const items = [
      ...[1, 2, 3].map((i) => item(`b${i}`, 'billing', topics.billing)),
      ...[1, 2, 3].map((i) => item(`s${i}`, 'search', topics.search)),
      ...[1, 2, 3].map((i) => item(`a${i}`, 'auth', topics.auth)),
    ];
    const p = proposeTaxonomy(items, { title: 'Shop' });
    expect(p.product.title).toBe('Shop');
    expect(p.areas.map((a) => a.title).sort()).toEqual(['Auth', 'Billing', 'Search']);
    expect(p.areas.flatMap((a) => a.members.map((m) => m.specId)).sort()).toEqual(items.map((i) => i.specId).sort());
    expect(new Set(p.areas.map((a) => a.key)).size).toBe(3);
    for (const a of p.areas) expect(a.charter.length).toBeGreaterThan(10);
    // Pure and deterministic: the same specs give the same proposal, so an accept matches the dry run.
    expect(proposeTaxonomy(items, { title: 'Shop' })).toEqual(p);
  });

  it('AC-90: a value holding a third of all specs is split across two or more areas', () => {
    const items = [
      ...[1, 2, 3, 4].map((i) => item(`b${i}`, 'platform', topics.billing)),
      ...[1, 2, 3, 4].map((i) => item(`d${i}`, 'platform', topics.deploy)),
      ...[1, 2, 3, 4].map((i) => item(`s${i}`, 'search', topics.search)),
      ...[1, 2, 3, 4].map((i) => item(`a${i}`, 'auth', topics.auth)),
      ...[1, 2, 3, 4].map((i) => item(`u${i}`, 'ui-kit', topics.ui)),
      ...[1, 2, 3, 4].map((i) => item(`x${i}`, 'deploys', topics.deploy)),
    ];
    const p = proposeTaxonomy(items, { title: 'Shop' });
    const platform = p.areas.filter((a) => a.members.some((m) => /^[bd]\d$/.test(m.specId) && a.hint === 'platform'));
    expect(platform.length).toBeGreaterThanOrEqual(2);
    for (const a of p.areas) expect(a.members.length / items.length).toBeLessThanOrEqual(MAX_AREA_SHARE);
  });

  it('AC-90: a cross-cutting value such as `surfaces` is never an area of its own; its specs split by what they are about', () => {
    const items = [
      ...[1, 2, 3].map((i) => item(`b${i}`, 'surfaces', topics.billing)),
      ...[1, 2, 3].map((i) => item(`s${i}`, 'surfaces', topics.search)),
      ...[1, 2, 3].map((i) => item(`a${i}`, 'auth', topics.auth)),
    ];
    const p = proposeTaxonomy(items, { title: 'Shop' });
    expect(p.areas.map((a) => a.title)).not.toContain('Surfaces');
    const holding = p.areas.filter((a) => a.members.some((m) => /^[bs]\d$/.test(m.specId)));
    expect(holding.length).toBeGreaterThanOrEqual(2);
    // The billing specs end up together, apart from the search ones.
    const billingHome = new Set(p.areas.filter((a) => a.members.some((m) => m.specId.startsWith('b'))).map((a) => a.key));
    expect(billingHome.size).toBe(1);
    expect(p.areas.find((a) => billingHome.has(a.key))!.members.some((m) => m.specId.startsWith('s'))).toBe(false);
  });

  it('with no hints at all it still proposes more than one area, none over the share', () => {
    const items = [...Object.values(topics)].flatMap((w, t) => [1, 2, 3].map((i) => item(`t${t}-${i}`, null, w)));
    const p = proposeTaxonomy(items, { title: 'Shop' });
    expect(p.areas.length).toBeGreaterThanOrEqual(2);
    for (const a of p.areas) expect(a.members.length / items.length).toBeLessThanOrEqual(MAX_AREA_SHARE);
  });

  it('reads a domain hint only from a body that opens with frontmatter', () => {
    expect(domainHintOf('---\ntitle: X\ndomain: knowledge # the KB\n---\n# X')).toBe('knowledge');
    expect(domainHintOf('# X\ndomain: knowledge')).toBeNull();
  });
});
