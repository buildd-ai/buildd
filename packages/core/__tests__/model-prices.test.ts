import { describe, it, expect } from 'bun:test';
import { estimateCostUsd, priceForModel } from '../model-prices';
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

  it('prices sonnet-5 at intro rate ($2/$10) before Sep 1 2026', () => {
    const before = new Date('2026-08-31T23:59:59Z');
    expect(priceForModel('claude-sonnet-5', before).input).toBe(2);
    expect(priceForModel('claude-sonnet-5', before).output).toBe(10);
    expect(priceForModel('claude-sonnet-5-20251019', before).input).toBe(2);
  });

  it('prices sonnet-5 at standard rate ($3/$15) from Sep 1 2026', () => {
    const after = new Date('2026-09-01T00:00:00Z');
    expect(priceForModel('claude-sonnet-5', after).input).toBe(3);
    expect(priceForModel('claude-sonnet-5', after).output).toBe(15);
    expect(priceForModel('claude-sonnet-5-20251019', after).input).toBe(3);
  });

  it('sonnet-5 cache pricing scales with input price', () => {
    const intro = priceForModel('claude-sonnet-5', new Date('2026-08-01T00:00:00Z'));
    expect(intro.cacheRead).toBeCloseTo(0.2, 6);
    expect(intro.cacheWrite).toBeCloseTo(2.5, 6);

    const standard = priceForModel('claude-sonnet-5', new Date('2026-09-01T00:00:00Z'));
    expect(standard.cacheRead).toBeCloseTo(0.3, 6);
    expect(standard.cacheWrite).toBeCloseTo(3.75, 6);
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
