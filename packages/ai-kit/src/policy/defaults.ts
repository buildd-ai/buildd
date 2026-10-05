/**
 * The bundled fallback policy: what the kit resolves to with no policy
 * service and nothing configured for a tier. Every tier is set, so resolution
 * always ends in a callable model.
 *
 * Mirrors buildd's code-level tier defaults (`TIER_DEFAULTS`,
 * packages/core/model-tier-defaults.ts); `contract.test.ts` fails if the two
 * drift. An app that cannot call Anthropic directly should pass its own
 * `fallback`.
 */

import type { KitTier, ModelPolicy, PolicyRoute } from './types';

export const DEFAULT_MODEL_POLICY: ModelPolicy & { tiers: Record<KitTier, PolicyRoute> } = {
  version: 'bundled',
  tiers: {
    'premium-plus': { provider: 'anthropic', model: 'claude-fable-5-1' },
    premium: { provider: 'anthropic', model: 'claude-opus-5' },
    standard: { provider: 'anthropic', model: 'claude-sonnet-5' },
    budget: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  },
};
