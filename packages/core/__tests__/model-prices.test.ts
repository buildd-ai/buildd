import { describe, it, expect } from 'bun:test';
import { estimateCostUsd, estimateCostUsdFromTotals, priceForModel } from '../model-prices';
import type { ModelUsage } from '../db/schema';

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
    expect(priceForModel('claude-opus-4-8').input).toBe(15);
    expect(priceForModel('claude-sonnet-4-6').input).toBe(3);
    expect(priceForModel('claude-haiku-4-5-20251001').input).toBe(1);
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
    // 1M opus cache-read ($1.50) + 1M opus cache-write ($18.75) = $20.25
    const cost = estimateCostUsd({
      'claude-opus-4-8': usage({ cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000 }),
    });
    expect(cost).toBeCloseTo(20.25, 6);
  });

  it('sums across multiple models', () => {
    const cost = estimateCostUsd({
      'claude-haiku-4-5': usage({ inputTokens: 1_000_000 }), // $1
      'claude-opus-4-8': usage({ outputTokens: 1_000_000 }), // $75
    });
    expect(cost).toBeCloseTo(76, 6);
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

  it('honours the model tier — opus costs 5x sonnet on input', () => {
    const totals = { inputTokens: 1_000_000, outputTokens: 0 };
    expect(estimateCostUsdFromTotals(totals, 'claude-opus-4-8')).toBeCloseTo(15, 6);
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
