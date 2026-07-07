/**
 * Model pricing — USD per 1M tokens (Anthropic list prices).
 *
 * Used to derive cost from token usage when the SDK's `total_cost_usd` is not
 * meaningful — notably on OAuth / subscription auth, where it has historically
 * reported $0. Token counts are always reported regardless of auth, so pricing
 * them at list rates matches how the Agent SDK credit pool is billed.
 *
 * Update these numbers when Anthropic changes list pricing.
 */
import type { ModelUsage } from './db/schema';

interface TokenPrice {
  /** USD per 1M fresh input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M cache-read input tokens (≈0.1× input) */
  cacheRead: number;
  /** USD per 1M cache-write/creation tokens (≈1.25× input) */
  cacheWrite: number;
}

// Keyed by tier; model IDs are matched to a tier by substring in priceForModel.
const TIER_PRICES: Record<'opus' | 'sonnet' | 'haiku', TokenPrice> = {
  opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

// Sonnet 5 intro pricing: $2/$10 per MTok through Aug 31 2026; standard $3/$15 from Sep 1 2026.
const SONNET_5_INTRO_CUTOFF = new Date('2026-09-01T00:00:00Z');
const SONNET_5_INTRO: TokenPrice = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const SONNET_5_STANDARD: TokenPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

function sonnet5Price(atDate: Date): TokenPrice {
  return atDate < SONNET_5_INTRO_CUTOFF ? SONNET_5_INTRO : SONNET_5_STANDARD;
}

/**
 * Resolve list pricing for a model ID (e.g. "claude-opus-4-8"). Defaults to sonnet.
 *
 * @param atDate - Reference date for date-based tiers (defaults to now). Pass a
 *   fixed date in tests to make assertions deterministic.
 */
export function priceForModel(modelId: string, atDate: Date = new Date()): TokenPrice {
  const id = modelId.toLowerCase();
  if (id.includes('opus')) return TIER_PRICES.opus;
  // sonnet-5 has its own intro/standard date-gated pricing (checked before generic 'sonnet')
  if (id.includes('sonnet-5')) return sonnet5Price(atDate);
  if (id.includes('haiku')) return TIER_PRICES.haiku;
  return TIER_PRICES.sonnet;
}

/**
 * Estimate cost in USD from per-model token usage (the SDK's `usage.byModel`).
 * Returns 0 for empty/missing usage.
 */
export function estimateCostUsd(
  modelUsage: Record<string, ModelUsage> | null | undefined,
): number {
  if (!modelUsage) return 0;
  let total = 0;
  for (const [modelId, u] of Object.entries(modelUsage)) {
    if (!u) continue;
    const p = priceForModel(modelId);
    total +=
      (u.inputTokens * p.input +
        u.outputTokens * p.output +
        u.cacheReadInputTokens * p.cacheRead +
        u.cacheCreationInputTokens * p.cacheWrite) /
      1_000_000;
  }
  return total;
}
