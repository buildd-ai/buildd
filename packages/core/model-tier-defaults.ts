/**
 * Code-level fallback defaults for the model tier registry.
 * No DB dependencies — safe to import from any context (runner, web, tests).
 *
 * These are the LAST RESORT — a team that has configured their registry never sees them.
 * The authoritative source of truth is the model_tier_registry table.
 */

export type Tier = 'premium' | 'standard' | 'budget';
export type TierProvider = 'anthropic' | 'openai-codex' | 'openrouter';

export interface TierEntry {
  provider: TierProvider;
  model: string;
  defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  defaultMaxTurns?: number;
  source?: 'workspace' | 'team' | 'default';
}

export const TIER_DEFAULTS: Record<Tier, TierEntry> = {
  premium:  { provider: 'anthropic', model: 'claude-opus-5',             source: 'default' },
  standard: { provider: 'anthropic', model: 'claude-sonnet-5',           source: 'default' },
  budget:   { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', source: 'default' },
};

// Which model backs a tier is a policy call, so it is hand-maintained here and
// in `model_tier_registry` — `GET /v1/models` lists what exists, not what we
// should route to. `auditTierModels` (model-tier-liveness.ts) checks the choice
// against that list instead, because the choice can go stale silently: standard
// sat on `claude-sonnet-4-6` after `claude-sonnet-5` shipped CHEAPER
// ($2/$10 input/output per MTok against $3/$15), so the fleet paid more for an
// older model. Keep the tiers on one generation unless there is a stated reason.
