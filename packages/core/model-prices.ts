/**
 * Model pricing — USD per 1M tokens.
 *
 * Used to derive cost from token usage when the SDK's `total_cost_usd` is not
 * meaningful — notably on OAuth / subscription auth, where it has historically
 * reported $0. Token counts are always reported regardless of auth, so pricing
 * them at list rates matches how the Agent SDK credit pool is billed.
 *
 * TWO SOURCES, in order:
 * 1. The live catalog (`setCatalogPrices`, fed from OpenRouter's public model
 *    list). Covers every vendor including OpenAI, and cannot go stale.
 * 2. The static table below, for when the catalog has not been loaded (runner
 *    cold start, tests) or does not know the model.
 *
 * The static table exists to be a floor, not the truth. It was wrong for
 * months: `opus` carried $15/$75 — Opus 4.1-era pricing — while every current
 * Opus (5, 4.8, 4.7, 4.6, 4.5) is $5/$25. That overstated Opus cost 3x, and
 * because `dailyBudgetPct` is derived from these numbers, it tripped the
 * router's budget downshift and 95% pause on spend that never happened.
 *
 * Source: platform.claude.com/docs/en/about-claude/pricing
 * Last verified: 2026-09-04 (against the Anthropic pricing page + OpenRouter)
 */
import type { ModelUsage } from './db/schema';
import type { CatalogEntry } from './model-catalog';
import { priceFromCatalog } from './model-catalog';

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
const TIER_PRICES: Record<'fable' | 'opusLegacy' | 'opus' | 'sonnet5' | 'sonnet' | 'haiku', TokenPrice> = {
  // Fable / Mythos — the frontier tier, ~2x Opus.
  fable: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  // Opus 4 and 4.1 only. Every Opus from 4.5 on is the $5/$25 row below.
  opusLegacy: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  opus: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // Sonnet 5 is flat at $2/$10. The previously scheduled Sep 1 2026 increase to $3/$15 was
  // cancelled on Aug 10–11 2026. Official confirmation:
  // platform.claude.com/docs/en/about-claude/pricing — Note id="claude-sonnet-5-introductory-pricing"
  sonnet5: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/**
 * The live catalog, when something has loaded it. Module-level because
 * `priceForModel` is synchronous and sits in hot paths (per-usage-row cost
 * math) that cannot await a fetch.
 */
let catalogPrices: readonly CatalogEntry[] = [];

/**
 * Publish a live catalog for pricing. Callers: the web app's catalog refresh
 * and the runner at startup. Passing [] clears it — the static table applies.
 */
export function setCatalogPrices(entries: readonly CatalogEntry[]): void {
  catalogPrices = entries;
}

/**
 * Catalog-only price lookup — null when the catalog is cold or does not know
 * the model, with NO static fallback.
 *
 * For callers whose static fallback is their own (the Codex backend prices GPT
 * models; this module's table is Anthropic-shaped and would answer `sonnet`
 * for `gpt-5.6-luna`, which is worse than admitting it does not know).
 */
export function catalogPriceFor(modelId: string): TokenPrice | null {
  return priceFromCatalog(catalogPrices, modelId);
}

/**
 * Resolve list pricing for a model ID (e.g. "claude-opus-5", "gpt-5.6-terra").
 *
 * The live catalog wins when it knows the model; otherwise the static table.
 * Unknown Anthropic-shaped models still fall back to sonnet — a wrong-but-close
 * number beats 0, which would make a real spend invisible to the budget gates.
 */
export function priceForModel(modelId: string): TokenPrice {
  const fromCatalog = priceFromCatalog(catalogPrices, modelId);
  if (fromCatalog) return fromCatalog;

  const id = modelId.toLowerCase();
  if (id.includes('fable') || id.includes('mythos')) return TIER_PRICES.fable;
  // Opus 4 / 4.1 are the only $15 models; match them before the generic opus row.
  if (/opus-4(-1)?($|-\d{8})/.test(id)) return TIER_PRICES.opusLegacy;
  if (id.includes('opus')) return TIER_PRICES.opus;
  // sonnet-5 is checked before generic 'sonnet' to avoid shadowing by the Sonnet 4.x tier.
  if (id.includes('sonnet-5')) return TIER_PRICES.sonnet5;
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

/**
 * All-in token totals for a session, as the runner reports them in
 * `resultMeta.totalUsage`. `inputTokens` is the ALL-IN input figure (fresh +
 * cache read + cache creation); the two cache fields are the breakdown of it.
 */
export interface SessionTokenTotals {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
}

const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Estimate cost from SESSION TOTALS priced against one known model.
 *
 * Why this exists alongside estimateCostUsd: per-model attribution
 * (`usage.byModel`) is empty on seat/OAuth auth — which is precisely the auth
 * mode the estimate exists for, so estimateCostUsd returned 0 exactly when it
 * was needed. Top-level totals ARE populated on OAuth, so price those instead.
 *
 * Requires a model id: pricing spans 15× between haiku and opus, so guessing a
 * tier would invent a number rather than estimate one. The runner reports the
 * session's actual model, and this returns 0 when it is unknown (an older runner
 * that omits it keeps today's behaviour rather than getting a fabricated charge).
 *
 * Cache tokens are priced at their own rates: pricing a 40k cache-read context
 * as fresh input overstates spend ~10×.
 */
export function estimateCostUsdFromTotals(
  totals: SessionTokenTotals | null | undefined,
  modelId: string | null | undefined,
): number {
  if (!totals || !modelId || !modelId.trim()) return 0;
  const p = priceForModel(modelId);
  const cacheRead = finite(totals.cacheReadInputTokens);
  const cacheWrite = finite(totals.cacheCreationInputTokens);
  // inputTokens is all-in, so the fresh portion is what remains after the cache
  // components. Clamped: a partial/older report can carry cache fields that
  // exceed the total.
  const freshInput = Math.max(0, finite(totals.inputTokens) - cacheRead - cacheWrite);
  return (
    (freshInput * p.input +
      finite(totals.outputTokens) * p.output +
      cacheRead * p.cacheRead +
      cacheWrite * p.cacheWrite) /
    1_000_000
  );
}
