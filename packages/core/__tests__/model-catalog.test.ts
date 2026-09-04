import { describe, test, expect } from 'bun:test';
import {
  normalizeCatalog,
  priceFromCatalog,
  pickTierModel,
  TIER_PRICE_BANDS,
} from '../model-catalog';
import fixture from './fixtures/openrouter-models.json';

/**
 * OpenRouter's `/api/v1/models` is the only model catalog we can read with NO
 * credential — Anthropic's `/v1/models` and OpenAI's both require a key, which
 * is why `auditTierModels` never actually ran anywhere without one, and why the
 * GPT side had no catalog at all.
 *
 * The fixture is a trimmed capture of the real response (2026-09-04), kept in
 * the shapes that bite: a `:batch` variant, a `~`-prefixed deprecated alias, a
 * no-tools image model, Anthropic ids written with DOTS (`claude-haiku-4.5`)
 * where the native SDK id uses dashes, and the two price-band boundary cases —
 * Sonnet 4.6 at exactly $3.00 and the retired $15 Opus 4.1.
 */

const entries = normalizeCatalog(fixture);
const byId = (id: string) => entries.find((e) => e.id === id);

describe('normalizeCatalog', () => {
  test('strips the vendor prefix to the native SDK model id', () => {
    expect(byId('claude-opus-5')?.openRouterId).toBe('anthropic/claude-opus-5');
    expect(byId('gpt-5.6-terra')?.openRouterId).toBe('openai/gpt-5.6-terra');
  });

  test('rewrites Anthropic dotted versions to the dashed native id', () => {
    // OpenRouter says `claude-haiku-4.5`; the Anthropic API only answers to
    // `claude-haiku-4-5`. Passing the dotted form to the SDK is a 404.
    expect(byId('claude-haiku-4-5')).toBeDefined();
    expect(byId('claude-haiku-4.5')).toBeUndefined();
  });

  test('leaves OpenAI dotted versions alone — those dots are real', () => {
    expect(byId('gpt-5.3-codex')).toBeDefined();
    expect(byId('gpt-5-3-codex')).toBeUndefined();
  });

  test('drops :batch variants — a different endpoint, not a routable model', () => {
    expect(entries.some((e) => e.openRouterId.includes(':batch'))).toBe(false);
  });

  test('drops ~-prefixed deprecated aliases', () => {
    expect(entries.some((e) => e.openRouterId.startsWith('~'))).toBe(false);
  });

  test('drops floating -latest aliases', () => {
    // A `-latest` id changes what actually runs underneath a task without the
    // tier changing, so the same tier stops being reproducible across claims.
    // The live catalog carries `openai/gpt-chat-latest`, which was resolving as
    // the OpenAI premium tier before this filter existed.
    const withAlias = normalizeCatalog({
      data: [
        {
          id: 'openai/gpt-chat-latest',
          name: 'GPT Chat (latest)',
          created: 9_999_999_999,
          context_length: 400_000,
          architecture: { output_modalities: ['text'] },
          pricing: { prompt: '0.000005', completion: '0.00003' },
          supported_parameters: ['tools'],
        },
      ],
    });
    expect(withAlias).toEqual([]);
  });

  test('drops models that cannot call tools — every worker needs tools', () => {
    // openai/gpt-5-image is in the fixture precisely because it has no `tools`
    // in supported_parameters. Routing a worker to it would fail on turn one.
    expect(byId('gpt-5-image')).toBeUndefined();
  });

  test('tags the provider', () => {
    expect(byId('claude-opus-5')?.provider).toBe('anthropic');
    expect(byId('gpt-5.6-luna')?.provider).toBe('openai');
  });

  test('converts per-token pricing to USD per 1M tokens', () => {
    const opus = byId('claude-opus-5')!;
    expect(opus.input).toBeCloseTo(5, 6);
    expect(opus.output).toBeCloseTo(25, 6);
    expect(opus.cacheRead).toBeCloseTo(0.5, 6);
    expect(opus.cacheWrite).toBeCloseTo(6.25, 6);
  });

  test('carries context length and release time', () => {
    const sonnet = byId('claude-sonnet-5')!;
    expect(sonnet.contextLength).toBe(1_000_000);
    expect(sonnet.created).toBeGreaterThan(0);
  });

  test('a failed or garbage fetch yields an empty catalog, never a throw', () => {
    // Same discipline as auditTierModels: the caller must be able to tell
    // "we learned nothing" from "the answer is none", and neither may crash a
    // claim. See docs — a gate that condemns everything off an empty set is the
    // inverse of one that passes having measured nothing.
    expect(normalizeCatalog(null)).toEqual([]);
    expect(normalizeCatalog({})).toEqual([]);
    expect(normalizeCatalog({ data: 'nope' })).toEqual([]);
    expect(normalizeCatalog({ data: [{ id: 'x' }] })).toEqual([]);
  });
});

describe('priceFromCatalog', () => {
  test('prices Opus 5 at $5/$25 — NOT the $15/$75 the static table carried', () => {
    // The static TIER_PRICES.opus row was Opus 4.1-era pricing. Every current
    // Opus (5, 4.8, 4.7, 4.6) is $5/$25, so cost was overstated 3x, which
    // inflates dailyBudgetPct and trips the router's budget downshift early.
    const p = priceFromCatalog(entries, 'claude-opus-5')!;
    expect(p.input).toBeCloseTo(5, 6);
    expect(p.output).toBeCloseTo(25, 6);
  });

  test('matches a dated snapshot to its base model', () => {
    // Workers report `claude-sonnet-5-20260630`; the catalog is keyed on
    // `claude-sonnet-5`. Without snapshot folding every real usage row misses.
    const p = priceFromCatalog(entries, 'claude-sonnet-5-20260630')!;
    expect(p.input).toBeCloseTo(2, 6);
  });

  test('prices GPT models too — the static table had no OpenAI rows at all', () => {
    expect(priceFromCatalog(entries, 'gpt-5.6-luna')!.input).toBeCloseTo(0.2, 6);
    expect(priceFromCatalog(entries, 'gpt-5.3-codex')!.output).toBeCloseTo(14, 6);
  });

  test('returns null for an unknown model rather than guessing a tier', () => {
    // The caller falls back to the static table. Silently pricing an unknown
    // model as sonnet is how a $10/$50 model gets billed at $3/$15.
    expect(priceFromCatalog(entries, 'some-future-model')).toBeNull();
    expect(priceFromCatalog([], 'claude-opus-5')).toBeNull();
  });
});

describe('pickTierModel', () => {
  test('resolves the Anthropic tiers to the current generation', () => {
    expect(pickTierModel('premium-plus', entries, 'anthropic')?.id).toBe('claude-fable-5-1');
    expect(pickTierModel('premium', entries, 'anthropic')?.id).toBe('claude-opus-5');
    expect(pickTierModel('standard', entries, 'anthropic')?.id).toBe('claude-sonnet-5');
    expect(pickTierModel('budget', entries, 'anthropic')?.id).toBe('claude-haiku-4-5');
  });

  test('Sonnet 4.6 at exactly $3.00 cannot reach premium', () => {
    // The premium floor is $4 for this reason. At a $3 floor, Sonnet 4.x sits
    // inside the premium band and only loses on release date — luck, not policy.
    // A future $3 Sonnet would capture premium and downgrade all planning work.
    const sonnet46 = byId('claude-sonnet-4-6')!;
    expect(sonnet46.input).toBeCloseTo(3, 6);
    expect(sonnet46.input).toBeLessThan(TIER_PRICE_BANDS.premium.minInput);
    expect(pickTierModel('premium', entries, 'anthropic')?.id).not.toBe('claude-sonnet-4-6');
  });

  test('a retired $15 flagship does not outrank the current one on price alone', () => {
    // Opus 4.1 ($15) shares the premium-plus band with Fable 5.1 ($10).
    // Newest-wins is what settles it; price must not.
    expect(byId('claude-opus-4-1')!.input).toBeCloseTo(15, 6);
    expect(pickTierModel('premium-plus', entries, 'anthropic')?.id).toBe('claude-fable-5-1');
  });

  test('resolves the OpenAI tiers — no key, no hand-maintained GPT list', () => {
    expect(pickTierModel('standard', entries, 'openai')?.id).toBe('gpt-5.6-terra');
    expect(pickTierModel('budget', entries, 'openai')?.id).toBe('gpt-5.6-luna');
  });

  test('newest wins inside a band, so a new release is adopted without a deploy', () => {
    // gpt-5.6-terra ($2, 2026-07-09) over gpt-5.3-codex ($1.75, 2026-02-24):
    // both sit in the standard band, the newer one wins.
    const std = pickTierModel('standard', entries, 'openai')!;
    const codex = byId('gpt-5.3-codex')!;
    expect(std.created).toBeGreaterThan(codex.created);
  });

  test('a band has a FLOOR, so a cheap new model can never capture premium', () => {
    // This is the whole reason bands are two-sided. Sonnet 5 is newer than any
    // Opus 4.x and far cheaper; with a ceiling-only band it would win `premium`
    // and quietly downgrade every planning task.
    const premium = pickTierModel('premium', entries, 'anthropic')!;
    expect(premium.input).toBeGreaterThanOrEqual(TIER_PRICE_BANDS.premium.minInput);
    expect(premium.id).not.toBe('claude-sonnet-5');
  });

  test('a band has a CEILING, so a pricier flagship cannot capture premium either', () => {
    // Fable 5.1 is $10/$50 AND the newest Anthropic model in the fixture
    // (2026-09-01, newer than Opus 5). Without a ceiling, newest-wins would
    // hand it `premium` and double the cost of every premium task unreviewed.
    // It belongs to premium-plus, which is opt-in.
    const fable = byId('claude-fable-5-1')!;
    expect(fable.created).toBeGreaterThan(byId('claude-opus-5')!.created);
    expect(fable.input).toBeGreaterThanOrEqual(TIER_PRICE_BANDS.premium.maxInput);
    expect(pickTierModel('premium', entries, 'anthropic')?.id).toBe('claude-opus-5');
  });

  test('picks the base variant over -pro indexed seconds later the same day', () => {
    // Exactly the live shape: gpt-5.6-terra-pro carries a `created` FOUR SECONDS
    // after gpt-5.6-terra at an identical price. Comparing raw seconds made that
    // artifact decide the tier, so `standard` resolved to `-pro` — a different
    // product with different latency and limits, chosen by indexing noise.
    const base = byId('gpt-5.6-terra')!;
    const pro = {
      ...base,
      id: 'gpt-5.6-terra-pro',
      openRouterId: 'openai/gpt-5.6-terra-pro',
      created: base.created + 4,
    };
    // Same answer regardless of catalog order.
    expect(pickTierModel('standard', [...entries, pro], 'openai')?.id).toBe('gpt-5.6-terra');
    expect(pickTierModel('standard', [pro, ...entries], 'openai')?.id).toBe('gpt-5.6-terra');
  });

  test('but a genuinely newer release on a later day still wins', () => {
    // Day granularity must not flatten real generational order.
    const base = byId('gpt-5.6-terra')!;
    const next = { ...base, id: 'gpt-5.7-terra', created: base.created + 86_400 * 30 };
    expect(pickTierModel('standard', [...entries, next], 'openai')?.id).toBe('gpt-5.7-terra');
  });

  test('returns null when nothing qualifies instead of picking a wrong tier', () => {
    expect(pickTierModel('premium', [], 'anthropic')).toBeNull();
    expect(pickTierModel('premium', entries, 'openai')).toBeNull(); // no $3-6 GPT in fixture
  });
});
