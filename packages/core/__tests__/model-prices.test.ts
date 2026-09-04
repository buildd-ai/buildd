import { describe, it, expect, afterEach } from 'bun:test';
import { estimateCostUsd, estimateCostUsdFromTotals, priceForModel, setCatalogPrices } from '../model-prices';
import { normalizeCatalog } from '../model-catalog';
import type { ModelUsage } from '../db/schema';
import fixture from './fixtures/openrouter-models.json';

function usage(overrides: Partial<ModelUsage> = {}): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUSD: 0,
    ...overrides,
  };
}

describe('priceForModel', () => {
  it('maps model IDs to the right tier', () => {
    expect(priceForModel('claude-opus-4-8').input).toBe(5);
    expect(priceForModel('claude-sonnet-4-6').input).toBe(3);
    expect(priceForModel('claude-haiku-4-5-20251001').input).toBe(1);
  });

  it('prices the current Opus generation at $5/$25, not the retired $15/$75', () => {
    // Regression: this table carried $15/$75 for ALL opus, which is Opus 4.1-era
    // pricing. Opus 4.5 onward is $5/$25. Because dailyBudgetPct is derived from
    // these numbers, a 3x overstatement trips the router's budget downshift (70%)
    // and its priority-0 pause (95%) on spend that never happened.
    for (const id of ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5']) {
      expect(priceForModel(id).input).toBe(5);
      expect(priceForModel(id).output).toBe(25);
    }
  });

  it('still prices the genuinely-$15 Opus 4 / 4.1 at the legacy rate', () => {
    expect(priceForModel('claude-opus-4-1').input).toBe(15);
    expect(priceForModel('claude-opus-4').input).toBe(15);
    expect(priceForModel('claude-opus-4-20250514').input).toBe(15);
  });

  it('prices Fable at the frontier rate instead of defaulting to sonnet', () => {
    // Fable is $10/$50. Falling through to the sonnet default billed it at
    // $3/$15 — a 3.3x UNDERstatement, the opposite failure to the opus row.
    expect(priceForModel('claude-fable-5-1').input).toBe(10);
    expect(priceForModel('claude-fable-5-1').output).toBe(50);
    expect(priceForModel('claude-mythos-5-1').input).toBe(10);
  });

  it('defaults unknown models to sonnet pricing', () => {
    expect(priceForModel('some-future-model').input).toBe(3);
  });

  it('prices sonnet-5 at the flat $2/$10 rate (Sep 1 increase was cancelled)', () => {
    // The previously scheduled Sep 1 2026 step-up to $3/$15 was cancelled on Aug 10-11 2026.
    // $2/$10 is now the permanent standard price regardless of date.
    expect(priceForModel('claude-sonnet-5').input).toBe(2);
    expect(priceForModel('claude-sonnet-5').output).toBe(10);
    expect(priceForModel('claude-sonnet-5-20251019').input).toBe(2);
  });

  it('sonnet-5 cache pricing is flat ($0.2 read / $2.5 write)', () => {
    const p = priceForModel('claude-sonnet-5');
    expect(p.cacheRead).toBeCloseTo(0.2, 6);
    expect(p.cacheWrite).toBeCloseTo(2.5, 6);
  });
});

describe('priceForModel with a live catalog loaded', () => {
  afterEach(() => setCatalogPrices([]));

  it('prices GPT models, which the static table cannot do at all', () => {
    // Without the catalog every GPT id falls through to the sonnet default
    // ($3/$15). gpt-5.6-luna is $0.20/$1.20 — a 15x overstatement on input.
    expect(priceForModel('gpt-5.6-luna').input).toBe(3); // static fallback
    setCatalogPrices(normalizeCatalog(fixture));
    expect(priceForModel('gpt-5.6-luna').input).toBeCloseTo(0.2, 6);
    expect(priceForModel('gpt-5.6-luna').output).toBeCloseTo(1.2, 6);
  });

  it('a model the catalog does not carry still falls back to the static table', () => {
    setCatalogPrices(normalizeCatalog(fixture));
    // Not in the fixture; the static opus row must still answer.
    expect(priceForModel('claude-opus-4-7').input).toBe(5);
  });

  it('clearing the catalog restores the static table', () => {
    setCatalogPrices(normalizeCatalog(fixture));
    expect(priceForModel('gpt-5.6-luna').input).toBeCloseTo(0.2, 6);
    setCatalogPrices([]);
    expect(priceForModel('gpt-5.6-luna').input).toBe(3);
  });
});

describe('estimateCostUsd', () => {
  it('returns 0 for missing usage', () => {
    expect(estimateCostUsd(null)).toBe(0);
    expect(estimateCostUsd(undefined)).toBe(0);
    expect(estimateCostUsd({})).toBe(0);
  });

  it('prices input + output tokens at list rates', () => {
    // 1M sonnet input ($3) + 1M sonnet output ($15) = $18
    const cost = estimateCostUsd({
      'claude-sonnet-4-6': usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    });
    expect(cost).toBeCloseTo(18, 6);
  });

  it('prices cache tokens at discounted/premium rates', () => {
    // 1M opus cache-read ($0.50) + 1M opus cache-write ($6.25) = $6.75
    const cost = estimateCostUsd({
      'claude-opus-4-8': usage({ cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000 }),
    });
    expect(cost).toBeCloseTo(6.75, 6);
  });

  it('sums across multiple models', () => {
    const cost = estimateCostUsd({
      'claude-haiku-4-5': usage({ inputTokens: 1_000_000 }), // $1
      'claude-opus-4-8': usage({ outputTokens: 1_000_000 }), // $25
    });
    expect(cost).toBeCloseTo(26, 6);
  });
});

describe('estimateCostUsdFromTotals (seat/OAuth path)', () => {
  it('prices session totals against the session model', () => {
    // 1M fresh sonnet input ($3) + 1M output ($15)
    const cost = estimateCostUsdFromTotals(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      'claude-sonnet-4-6',
    );
    expect(cost).toBeCloseTo(18, 6);
  });

  it('prices the cache breakdown at cache rates, not fresh input', () => {
    // inputTokens is ALL-IN: 1.1M total = 100k fresh + 1M cache read.
    // Sonnet: 100k fresh = $0.30, 1M cache read = $0.30 → $0.60.
    // Pricing the all-in figure as fresh input would be $3.30.
    const cost = estimateCostUsdFromTotals(
      { inputTokens: 1_100_000, outputTokens: 0, cacheReadInputTokens: 1_000_000 },
      'claude-sonnet-4-6',
    );
    expect(cost).toBeCloseTo(0.6, 6);
  });

  it('prices cache creation at the write rate', () => {
    // 1M cache-write on sonnet = $3.75, no fresh input left over.
    const cost = estimateCostUsdFromTotals(
      { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 1_000_000 },
      'claude-sonnet-4-6',
    );
    expect(cost).toBeCloseTo(3.75, 6);
  });

  it('honours the model tier — opus costs 5x haiku on input', () => {
    const totals = { inputTokens: 1_000_000, outputTokens: 0 };
    expect(estimateCostUsdFromTotals(totals, 'claude-opus-4-8')).toBeCloseTo(5, 6);
    expect(estimateCostUsdFromTotals(totals, 'claude-haiku-4-5')).toBeCloseTo(1, 6);
  });

  it('returns 0 without a model — never fabricates a tier', () => {
    const totals = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(estimateCostUsdFromTotals(totals, null)).toBe(0);
    expect(estimateCostUsdFromTotals(totals, '')).toBe(0);
    expect(estimateCostUsdFromTotals(totals, '   ')).toBe(0);
  });

  it('returns 0 for missing or empty totals', () => {
    expect(estimateCostUsdFromTotals(null, 'claude-sonnet-4-6')).toBe(0);
    expect(estimateCostUsdFromTotals(undefined, 'claude-sonnet-4-6')).toBe(0);
    expect(estimateCostUsdFromTotals({}, 'claude-sonnet-4-6')).toBe(0);
  });

  it('clamps a cache breakdown that exceeds the all-in input figure', () => {
    // Defensive: a partial report must not produce a negative fresh-input charge.
    const cost = estimateCostUsdFromTotals(
      { inputTokens: 500, outputTokens: 0, cacheReadInputTokens: 1_000_000 },
      'claude-sonnet-4-6',
    );
    expect(cost).toBeCloseTo(0.3, 6);
  });
});
