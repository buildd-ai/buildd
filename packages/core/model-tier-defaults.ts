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
  premium:  { provider: 'anthropic', model: 'claude-opus-4-8',           source: 'default' },
  standard: { provider: 'anthropic', model: 'claude-sonnet-4-6',         source: 'default' },
  budget:   { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', source: 'default' },
};
