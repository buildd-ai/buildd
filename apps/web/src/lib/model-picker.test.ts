import { describe, expect, it } from 'bun:test';
import {
  TIER_ROUTES,
  buildPickerRows,
  compareRows,
  formatContext,
  formatPrice,
  groupPickerRows,
  sameModel,
  withKeyStatus,
  type PickerModelInput,
  type PickerRow,
} from './model-picker';

// Illustrative catalog: shapes that matter, not a capture.
const T = (iso: string) => Date.parse(iso) / 1000;
const or = (vendor: string, slug: string, input: number, output: number, created: string, extra: Partial<PickerModelInput> = {}): PickerModelInput => ({
  id: slug, provider: vendor === 'anthropic' ? 'anthropic' : vendor === 'openai' ? 'openai' : 'other',
  openRouterId: `${vendor}/${slug}`, vendor, inputPrice: input, outputPrice: output, contextLength: 1_000_000, created: T(created), ...extra,
});

const MODELS: PickerModelInput[] = [
  // Registry entry for the standard tier: no price, a "(tier)" label.
  { id: 'claude-sonnet-5', displayName: 'claude-sonnet-5 (standard)', provider: 'anthropic' },
  or('anthropic', 'claude-sonnet-5', 2, 10, '2026-06-30'),
  or('anthropic', 'claude-sonnet-4-6', 3, 15, '2026-02-01'),
  or('anthropic', 'claude-opus-5', 5, 25, '2026-07-15'),
  or('anthropic', 'claude-haiku-4-5', 1, 5, '2025-10-01'),
  { id: 'claude-haiku-4-5-20251001', provider: 'anthropic', inputPrice: 1, outputPrice: 5, created: T('2025-10-01') },
  or('openai', 'gpt-5.6-terra', 2.5, 15, '2026-08-01'),
  or('openai', 'gpt-5.3-codex', 1.75, 14, '2026-03-01'),
  or('google', 'gemini-3.1-pro-preview', 2, 12, '2026-08-20'),
  or('google', 'gemini-3-pro', 2, 12, '2026-05-01'),
  or('google', 'gemini-3-flash', 0.5, 3, '2026-05-01'),
  or('deepseek', 'deepseek-v4-pro', 1.6, 3.2, '2026-08-10'),
  or('deepseek', 'deepseek-v3.2', 0.27, 1.1, '2025-12-01'),
  or('qwen', 'qwen3-coder', 1.8, 7, '2026-01-10'),
  or('qwen', 'qwen3.6-max', 2.2, 9, '2026-09-01'),
  or('qwen', 'qwen3.5-max', 2.0, 8, '2026-04-01'),
  or('qwen', 'qwen3-235b', 1.6, 6, '2026-02-01'),
  or('qwen', 'qwen3-32b', 1.55, 6, '2026-02-15'),
  or('qwen', 'qwen3-next', 1.7, 6.5, '2026-03-15'),
  or('x-ai', 'grok-4-fast', 0.2, 0.5, '2026-03-01', { expiresAt: T('2026-10-15') }),
];

const NOW = T('2026-09-26');
const rows = buildPickerRows(MODELS, TIER_ROUTES, 'standard', [{ route: 'anthropic', model: 'claude-sonnet-5' }], NOW);
const row = (route: string, model: string) => rows.find((r) => r.route === route && r.model === model);
const view = (over: Partial<Parameters<typeof groupPickerRows>[2]> = {}) =>
  groupPickerRows(rows, TIER_ROUTES, { query: '', band: 'fits', showHidden: false, expanded: new Set(), ...over });
const visible = (g: ReturnType<typeof view>, routeId: string) =>
  g.find((x) => x.route.id === routeId)!.vendors.flatMap((v) => v.rows.map((r) => r.model));

describe('buildPickerRows', () => {
  it('offers each route the ids it stores', () => {
    expect(row('anthropic', 'claude-sonnet-5')).toBeDefined();
    expect(row('openrouter', 'anthropic/claude-sonnet-5')).toBeDefined();
    expect(row('openrouter', 'qwen/qwen3-coder')).toBeDefined();
    expect(row('openai', 'gpt-5.6-terra')).toBeDefined();
    expect(row('openai-codex', 'gpt-5.3-codex')).toBeDefined();
    expect(rows.some((r) => r.route === 'anthropic' && r.vendor !== 'anthropic')).toBe(false);
  });

  it('merges the unpriced registry entry into the priced catalog row', () => {
    const r = rows.filter((x) => x.route === 'anthropic' && x.model === 'claude-sonnet-5');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ inputPrice: 2, outputPrice: 10, band: 'in' });
  });

  it('marks the saved value current, and recommends the newest in-band Anthropic model', () => {
    expect(row('anthropic', 'claude-sonnet-5')!.badges).toEqual(['current', 'recommended']);
    expect(row('openrouter', 'anthropic/claude-sonnet-5')!.badges).toContain('recommended');
    expect(row('openai', 'gpt-5.6-terra')!.badges).toContain('recommended');
  });

  it('names the cheapest in-band model per route', () => {
    const cheap = rows.filter((r) => r.route === 'openrouter' && r.badges.includes('cheapest')).map((r) => r.model);
    expect(cheap).toEqual(['deepseek/deepseek-v4-pro']);
  });

  it('hides previews, deprecations, snapshots with an undated sibling, and superseded family members', () => {
    expect(row('openrouter', 'google/gemini-3.1-pro-preview')!.hidden).toBe('preview');
    expect(row('openrouter', 'x-ai/grok-4-fast')!.hidden).toBe('deprecated');
    expect(row('anthropic', 'claude-haiku-4-5-20251001')!.hidden).toBe('snapshot');
    expect(row('anthropic', 'claude-sonnet-4-6')!.hidden).toBe('superseded');
    expect(row('openrouter', 'qwen/qwen3.5-max')!.hidden).toBe('superseded');
    expect(row('openrouter', 'qwen/qwen3.6-max')!.badges).toContain('newest');
  });

  it('never hides the current value, and lists it even when the catalog does not', () => {
    const r = buildPickerRows(MODELS, TIER_ROUTES, 'standard', [
      { route: 'anthropic', model: 'claude-sonnet-4-6' },
      { route: 'openrouter', model: 'vendor/unlisted-model' },
    ], NOW);
    expect(r.find((x) => x.model === 'claude-sonnet-4-6' && x.route === 'anthropic')!.hidden).toBeNull();
    const ghost = r.find((x) => x.model === 'vendor/unlisted-model')!;
    expect(ghost).toMatchObject({ listed: false, badges: ['current'] });
  });

  it('matches a saved OpenRouter id written with dashes to the dotted catalog id', () => {
    // The screen used to say "(not in catalog)" for a listed model because the
    // two spellings of the same version never compared equal.
    const cat = [or('anthropic', 'claude-sonnet-4.5', 3, 15, '2025-09-29')];
    const r = buildPickerRows(cat, TIER_ROUTES, 'standard', [{ route: 'openrouter', model: 'anthropic/claude-sonnet-4-5' }], NOW);
    const hits = r.filter((x) => x.route === 'openrouter');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ model: 'anthropic/claude-sonnet-4.5', listed: true });
    expect(hits[0].badges).toContain('current');
  });
});

describe('groupPickerRows', () => {
  it('groups by route in the owner order, then by vendor inside OpenRouter', () => {
    const g = view();
    expect(g.map((x) => x.route.id)).toEqual(['anthropic', 'openai', 'openrouter', 'openai-codex']);
    expect(g.find((x) => x.route.id === 'openrouter')!.vendors.map((v) => v.vendor)).toEqual(['anthropic', 'openai', 'google', 'deepseek', 'qwen']);
  });

  it('defaults to the tier band and says how many other prices it dropped', () => {
    const g = view();
    expect(visible(g, 'anthropic')).toEqual(['claude-sonnet-5']);
    expect(g.find((x) => x.route.id === 'anthropic')!.filtered).toBe(2); // opus above, haiku below
    expect(visible(view({ band: 'all' }), 'anthropic')).toEqual(['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5']);
  });

  it('folds a vendor after three rows, keeps recommended/current visible, and expands on request', () => {
    const qwen = view().find((x) => x.route.id === 'openrouter')!.vendors.find((v) => v.vendor === 'qwen')!;
    expect(qwen.rows).toHaveLength(3);
    expect(qwen.more).toBe(2);
    const all = rows.filter((r) => r.route === 'openrouter' && r.vendor === 'qwen' && !r.hidden && r.band === 'in');
    expect(qwen.rows.length + qwen.more).toBe(all.length);
    const open = view({ expanded: new Set(['openrouter::qwen']) }).find((x) => x.route.id === 'openrouter')!.vendors.find((v) => v.vendor === 'qwen')!;
    expect(open.more).toBe(0);
  });

  it('search is fuzzy across vendor and model, ignores band and folding', () => {
    const g = view({ query: 'gem flash' });
    expect(visible(g, 'openrouter')).toEqual(['google/gemini-3-flash']);
    const byVendor = view({ query: 'deepseek' });
    expect(visible(byVendor, 'openrouter')).toEqual(['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v3.2']);
    expect(byVendor.map((x) => x.route.id)).toEqual(['openrouter']);
  });

  it('shows hidden variants only when asked', () => {
    expect(visible(view({ query: 'gemini' }), 'openrouter')).not.toContain('google/gemini-3.1-pro-preview');
    expect(visible(view({ query: 'gemini', showHidden: true }), 'openrouter')).toContain('google/gemini-3.1-pro-preview');
  });
});

describe('compareRows', () => {
  it('reads price, context and release against the current row', () => {
    const base = row('anthropic', 'claude-sonnet-5')!;
    const ds = row('openrouter', 'deepseek/deepseek-v4-pro')!;
    const cells = compareRows(ds, base);
    expect(cells.map((c) => [c.label, c.value, c.delta, c.better])).toEqual([
      ['in', '$1.6', '-20%', true],
      ['out', '$3.2', '-68%', true],
      ['ctx', '1M', '=', null],
      ['released', 'Aug 2026', 'newer', true],
    ]);
  });

  it('has no deltas against itself', () => {
    const base = row('anthropic', 'claude-sonnet-5')! as PickerRow;
    expect(compareRows(base, base).every((c) => c.delta === '')).toBe(true);
  });
});

describe('helpers', () => {
  it('sameModel ignores case, dots vs dashes and a date suffix', () => {
    expect(sameModel('anthropic/claude-sonnet-4.5', 'anthropic/claude-sonnet-4-5')).toBe(true);
    expect(sameModel('claude-haiku-4-5-20251001', 'claude-haiku-4-5')).toBe(true);
    expect(sameModel('claude-opus-5', 'claude-sonnet-5')).toBe(false);
  });

  it('formats prices and context windows compactly', () => {
    expect([formatPrice(2), formatPrice(2.5), formatPrice(0.27), formatPrice(15), formatPrice(0.05)]).toEqual(['$2', '$2.5', '$0.27', '$15', '$0.05']);
    expect([formatContext(200_000), formatContext(1_000_000), formatContext(1_048_576)]).toEqual(['200k', '1M', '1M']);
  });

  it('withKeyStatus tags key routes and leaves runner routes alone', () => {
    const r = withKeyStatus(TIER_ROUTES, { anthropic: true, openrouter: false });
    expect(r.map((x) => [x.id, x.key])).toEqual([
      ['anthropic', 'set'], ['openai', undefined], ['openrouter', 'missing'], ['openai-codex', undefined],
    ]);
  });
});
