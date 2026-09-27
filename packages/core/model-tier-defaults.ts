/**
 * Code-level fallback defaults for the model tier registry.
 * No DB dependencies — safe to import from any context (runner, web, tests).
 *
 * These are the LAST RESORT — a team that has configured their registry never sees them.
 * The authoritative source of truth is the model_tier_registry table.
 */

export type Tier = 'premium-plus' | 'premium' | 'standard' | 'budget';

/**
 * Every tier, most to least capable. Validation sites import this rather than
 * inlining the list — the four separate hardcoded copies of
 * `['premium','standard','budget']` are exactly why adding a tier used to mean
 * hunting through routes and MCP handlers.
 */
export const TIERS: readonly Tier[] = ['premium-plus', 'premium', 'standard', 'budget'];
// 'openai' is the OpenAI API (an API key: server-side calls such as chat);
// 'openai-codex' is the Codex subscription backend (runner only).
export type TierProvider = 'anthropic' | 'openai' | 'openai-codex' | 'openrouter';

/**
 * Who asks for a tier: agent runs (runner credentials) or chat and inference
 * calls (API keys). A registry row with no surface serves both.
 */
export type TierSurface = 'agent' | 'chat';
export const TIER_SURFACES: readonly TierSurface[] = ['agent', 'chat'];

export interface TierEntry {
  provider: TierProvider;
  model: string;
  defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  defaultMaxTurns?: number;
  /**
   * 'catalog' means no registry row exists for this tier and the live catalog
   * picked the newest in-band release — the self-healing path. 'default'
   * means even the catalog had nothing (empty/failed fetch), so the
   * hand-maintained fallback applies.
   */
  source?: 'workspace' | 'team' | 'default' | 'catalog';
  /** Set when the row that served this entry is scoped to one surface. */
  surface?: TierSurface;
}

/**
 * One tier as `GET /api/model-tiers` returns it: the shared (surface-less)
 * resolution, plus what each surface resolves to. A surface entry carrying
 * `surface` came from that surface's own row, which means the tier is split.
 */
export interface TierEntryWithSurfaces extends TierEntry {
  bySurface: Record<TierSurface, TierEntry>;
}

export function isTierSurface(v: unknown): v is TierSurface {
  return v === 'agent' || v === 'chat';
}

export const TIER_DEFAULTS: Record<Tier, TierEntry> = {
  // Opt-in only: nothing routes here on its own. The kind×complexity matrix in
  // model-router.ts tops out at `premium`, so premium-plus is reached solely by
  // an explicit `tier` on a task or a role. Fable is ~2x premium per token.
  'premium-plus': { provider: 'anthropic', model: 'claude-fable-5-1',      source: 'default' },
  premium:        { provider: 'anthropic', model: 'claude-opus-5',         source: 'default' },
  standard:       { provider: 'anthropic', model: 'claude-sonnet-5',       source: 'default' },
  budget:         { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', source: 'default' },
};

// Which model backs a tier is a policy call, so it is hand-maintained here and
// in `model_tier_registry` — `GET /v1/models` lists what exists, not what we
// should route to. `auditTierModels` (model-tier-liveness.ts) checks the choice
// against that list instead, because the choice can go stale silently: standard
// sat on `claude-sonnet-4-6` after `claude-sonnet-5` shipped CHEAPER
// ($2/$10 input/output per MTok against $3/$15), so the fleet paid more for an
// older model. Keep the tiers on one generation unless there is a stated reason.
