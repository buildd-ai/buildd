/**
 * The platform tier default (model-tier-platform-default.ts): the record a
 * platform admin writes for every team without a row of its own, the guard
 * rails every write passes, and the staleness suggestion the admin surfaces
 * show. Pure: catalog, certifications and the clock are arguments.
 */
import { describe, it, expect } from 'bun:test';
import type { CatalogEntry } from '../model-catalog';
import type { ModelCertification } from '../model-certification';
import {
  checkPlatformTierModel,
  describeModelFacts,
  parsePlatformTierDefault,
  platformTierDefaultKey,
  platformTierSuggestions,
  type PlatformTierDefault,
} from '../model-tier-platform-default';

const DAY = 86_400;
const NOW = Date.UTC(2026, 10, 14);
const entry = (id: string, input: number, created: number, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id,
  canonicalId: `${id}-20260101`,
  openRouterId: `anthropic/${id}`,
  provider: 'anthropic',
  displayName: id,
  contextLength: 1_000_000,
  created,
  input,
  output: input * 5,
  cacheRead: input / 10,
  cacheWrite: input * 1.25,
  ...extra,
});

// A catalog with one model per band and, in two bands, a newer release the
// static floor table does not know about.
const CATALOG: CatalogEntry[] = [
  entry('claude-fable-5-1', 10, 1_788_000_000),
  entry('claude-fable-5-9', 8, 1_794_000_000), // newer, not in the static table
  entry('claude-opus-5-5', 4, 1_790_000_000),
  entry('claude-sonnet-5-5', 2, 1_790_600_000),
  entry('claude-haiku-5-5', 0.1, 1_791_000_000),
  entry('claude-haiku-5-9', 0.5, 1_795_000_000), // newer, not in the static table
  entry('claude-haiku-5-9-20261201', 0.5, 1_795_000_000), // its dated snapshot
];

const cert = (model: string, over: Partial<ModelCertification>): [string, ModelCertification] => [
  model,
  { model, state: 'certified', certifiedAt: '2026-11-01T00:00:00.000Z', probe: { attempts: 1 }, ...over },
];

const row: PlatformTierDefault = {
  tier: 'premium-plus',
  provider: 'anthropic',
  model: 'claude-fable-5-1',
  setAt: '2026-11-14T00:00:00.000Z',
  setBy: { accountId: 'acct', userId: null, via: 'mcp' },
  reason: 'move',
  previous: null,
};

describe('platform tier default record', () => {
  it('keys one row per tier', () => {
    expect(platformTierDefaultKey('premium')).toBe('platform_tier_default:premium');
  });

  it('parses a stored record and refuses malformed ones', () => {
    expect(parsePlatformTierDefault(row)).toEqual(row);
    expect(parsePlatformTierDefault({ ...row, previous: { ...row, previous: undefined } })?.previous?.model).toBe('claude-fable-5-1');
    expect(parsePlatformTierDefault(null)).toBeNull();
    expect(parsePlatformTierDefault({ ...row, tier: 'ultra' })).toBeNull();
    expect(parsePlatformTierDefault({ ...row, model: 42 })).toBeNull();
    expect(parsePlatformTierDefault({ ...row, provider: 'openai' })).toBeNull();
    expect(parsePlatformTierDefault({ ...row, setBy: { via: 'cron' } })).toBeNull();
  });
});

describe('describeModelFacts', () => {
  it('reads price from the catalog and the floor from the static table', () => {
    const f = describeModelFacts('claude-opus-5-5', CATALOG, new Map(), NOW);
    expect(f.inCatalog).toBe(true);
    expect(f.price).toEqual({ input: 4, output: 20 });
    expect(f.floor).toBe('2.1.280');
    expect(f.certification).toBe('baseline');
    expect(f.certified).toBe(true);
  });

  it('reads a probe-learned floor for a model the table never named', () => {
    const certs = new Map([cert('claude-fable-5-9', { minCliVersion: '2.1.330' })]);
    const f = describeModelFacts('claude-fable-5-9', CATALOG, certs, NOW);
    expect(f.floor).toBe('2.1.330');
    expect(f.certification).toBe('certified');
    expect(f.certified).toBe(true);
  });

  it('an in-band release nobody probed is discovered, with no floor', () => {
    const f = describeModelFacts('claude-fable-5-9', CATALOG, new Map(), NOW);
    expect(f.certification).toBe('discovered');
    expect(f.floor).toBeNull();
    expect(f.certified).toBe(false);
  });

  it('a model the catalog does not list is reported as such, not priced', () => {
    const f = describeModelFacts('claude-sonnet-9', CATALOG, new Map(), NOW);
    expect(f.inCatalog).toBe(false);
    expect(f.price).toBeNull();
  });
});

describe('checkPlatformTierModel: guard rails, not trust', () => {
  const base = { catalog: CATALOG, certifications: new Map<string, ModelCertification>(), now: NOW, confirm: true, confirmBandChange: false };

  it('accepts a certified in-band catalog model', () => {
    const r = checkPlatformTierModel({ ...base, tier: 'premium', model: 'claude-opus-5-5' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.facts.floor).toBe('2.1.280');
  });

  it('refuses an unknown tier and a malformed model id before anything else', () => {
    expect(checkPlatformTierModel({ ...base, tier: 'ultra' as never, model: 'claude-opus-5-5' })).toMatchObject({ ok: false, refusal: { code: 'unknown_tier', status: 400 } });
    expect(checkPlatformTierModel({ ...base, tier: 'premium', model: 'gpt-5' })).toMatchObject({ ok: false, refusal: { code: 'invalid_model', status: 400 } });
    expect(checkPlatformTierModel({ ...base, tier: 'premium', model: '' })).toMatchObject({ ok: false, refusal: { code: 'invalid_model' } });
  });

  it('refuses when the live catalog cannot be read: nothing is verified either way', () => {
    const r = checkPlatformTierModel({ ...base, catalog: [], tier: 'premium', model: 'claude-opus-5-5' });
    expect(r).toMatchObject({ ok: false, refusal: { code: 'catalog_unavailable', status: 503 } });
  });

  it('refuses a model that is not in the live catalog', () => {
    const r = checkPlatformTierModel({ ...base, tier: 'premium', model: 'claude-opus-9' });
    expect(r).toMatchObject({ ok: false, refusal: { code: 'model_not_in_catalog', status: 422 } });
  });

  it('refuses a model with no certified CLI floor and points at the probe', () => {
    const r = checkPlatformTierModel({ ...base, tier: 'premium-plus', model: 'claude-fable-5-9' });
    expect(r).toMatchObject({ ok: false, refusal: { code: 'not_certified', status: 422, detail: { certification: 'discovered' } } });
    if (!r.ok) expect(r.refusal.error).toContain('probe');
  });

  it('a probe-certified model with a learned floor passes', () => {
    const certs = new Map([cert('claude-fable-5-9', { minCliVersion: '2.1.330' })]);
    const r = checkPlatformTierModel({ ...base, certifications: certs, tier: 'premium-plus', model: 'claude-fable-5-9' });
    expect(r.ok).toBe(true);
  });

  it('a failed or incompatible probe is not a floor', () => {
    for (const state of ['failed', 'incompatible', 'probing'] as const) {
      const certs = new Map([cert('claude-fable-5-9', { state, minCliVersion: state === 'incompatible' ? '2.1.330' : null })]);
      const r = checkPlatformTierModel({ ...base, certifications: certs, tier: 'premium-plus', model: 'claude-fable-5-9' });
      expect({ state, code: r.ok ? 'ok' : r.refusal.code }).toEqual({ state, code: 'not_certified' });
    }
  });

  it('refuses a retired model outright', () => {
    const certs = new Map([cert('claude-opus-5-5', { deprecated: { source: 'admin', at: '2026-10-01T00:00:00.000Z', retiresAt: '2026-11-01T00:00:00.000Z' } })]);
    const r = checkPlatformTierModel({ ...base, certifications: certs, tier: 'premium', model: 'claude-opus-5-5' });
    expect(r).toMatchObject({ ok: false, refusal: { code: 'retired', status: 422 } });
  });

  it('a model outside the tier price band needs an explicit band confirm, in either direction', () => {
    // Lowering premium-plus onto a $4 model.
    const down = checkPlatformTierModel({ ...base, tier: 'premium-plus', model: 'claude-opus-5-5' });
    expect(down).toMatchObject({ ok: false, refusal: { code: 'spend_band_change', status: 409, detail: { direction: 'below' } } });
    // Raising standard onto a $10 model.
    const up = checkPlatformTierModel({ ...base, tier: 'standard', model: 'claude-fable-5-1' });
    expect(up).toMatchObject({ ok: false, refusal: { code: 'spend_band_change', detail: { direction: 'above' } } });
    expect(checkPlatformTierModel({ ...base, tier: 'premium-plus', model: 'claude-opus-5-5', confirmBandChange: true }).ok).toBe(true);
  });

  it('every write needs confirm, checked after the facts so the caller learns the real problem first', () => {
    expect(checkPlatformTierModel({ ...base, confirm: false, tier: 'premium', model: 'claude-opus-5-5' }))
      .toMatchObject({ ok: false, refusal: { code: 'confirm_required', status: 409 } });
    expect(checkPlatformTierModel({ ...base, confirm: false, tier: 'premium', model: 'claude-opus-9' }))
      .toMatchObject({ ok: false, refusal: { code: 'model_not_in_catalog' } });
  });

  it('the dated snapshot id resolves to its catalog entry', () => {
    const r = checkPlatformTierModel({ ...base, tier: 'premium', model: 'claude-opus-5-5-20260101' });
    expect(r.ok).toBe(true);
  });
});

describe('platformTierSuggestions: staleness made visible, never auto-applied', () => {
  const effective = {
    'premium-plus': { provider: 'anthropic', model: 'claude-fable-5-1' },
    premium: { provider: 'anthropic', model: 'claude-opus-5-5' },
    standard: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    budget: { provider: 'anthropic', model: 'claude-haiku-5-5' },
  };

  it('names the newer same-family release with its price, floor and whether Apply can run', () => {
    const certs = new Map([cert('claude-haiku-5-9', { minCliVersion: '2.1.340' })]);
    const out = platformTierSuggestions(effective, CATALOG, certs, NOW);
    const budget = out.find((s) => s.tier === 'budget');
    expect(budget).toMatchObject({
      kind: 'newer', model: 'claude-haiku-5-5', newer: 'claude-haiku-5-9',
      applicable: true, needsBandConfirm: false,
      facts: { price: { input: 0.5, output: 2.5 }, floor: '2.1.340', certified: true },
    });
    // The undated id is suggested, never its dated snapshot.
    expect(budget!.newer).not.toContain('2026');
    const pp = out.find((s) => s.tier === 'premium-plus');
    expect(pp).toMatchObject({ kind: 'newer', newer: 'claude-fable-5-9', applicable: false });
    expect(pp!.why).toContain('not certified');
    // Nothing newer for premium and standard: no suggestion.
    expect(out.filter((s) => s.tier === 'premium' || s.tier === 'standard')).toEqual([]);
  });

  it('a newer release outside the band is applicable only with a band confirm', () => {
    const catalog = [...CATALOG, entry('claude-haiku-6', 2, 1_796_000_000)];
    const certs = new Map([cert('claude-haiku-6', { minCliVersion: '2.1.350' })]);
    const budget = platformTierSuggestions(effective, catalog, certs, NOW).find((s) => s.tier === 'budget');
    expect(budget).toMatchObject({ newer: 'claude-haiku-6', applicable: true, needsBandConfirm: true });
  });

  it('flags an effective model the catalog no longer lists', () => {
    const out = platformTierSuggestions({ premium: { provider: 'anthropic', model: 'claude-opus-4-8' } }, CATALOG, new Map(), NOW);
    expect(out).toEqual([expect.objectContaining({ tier: 'premium', kind: 'missing', model: 'claude-opus-4-8', newer: null })]);
  });

  it('says nothing when the catalog is empty: an empty list is not evidence', () => {
    expect(platformTierSuggestions(effective, [], new Map(), NOW)).toEqual([]);
  });

  it('leaves non-Anthropic tiers alone', () => {
    expect(platformTierSuggestions({ standard: { provider: 'openai-codex', model: 'gpt-5-codex' } }, CATALOG, new Map(), NOW)).toEqual([]);
  });
});
