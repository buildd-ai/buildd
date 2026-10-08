/**
 * Code-level fallback defaults for the model tier registry.
 * No DB dependencies — safe to import from any context (runner, web, tests).
 *
 * These are the LAST RESORT — a team that has configured their registry never sees them.
 * The authoritative source of truth is the model_tier_registry table, resolved
 * through the standalone model policy (`model-policy.ts`).
 *
 * The defaults themselves are not written here: they are the policy's bundled
 * fallback (`DEFAULT_MODEL_POLICY`, @builddai/ai-kit/policy), read through its
 * resolver. One list of tier models, one resolver.
 */

import { resolveModelPolicy } from '@builddai/ai-kit/policy';
import type { TierPolicyMeta } from './model-policy';

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
   * hand-maintained fallback applies. 'policy' means the remote policy
   * service answered for a tier the registry leaves unset.
   */
  source?: 'workspace' | 'team' | 'default' | 'catalog' | 'policy';
  /** Set when the row that served this entry is scoped to one surface. */
  surface?: TierSurface;
  /**
   * The model-policy decision behind this entry (model-policy.ts): which
   * policy version answered, from which layer, and the planId to report
   * outcomes against when a policy service issued it.
   */
  policy?: TierPolicyMeta;
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

/**
 * A tier's bundled default: what the policy answers with no registry row, no
 * policy service and no catalog pick. Callers that need a code-level default
 * (the runner's sync fallback, the dispatch guard's last resort) ask this
 * rather than indexing a table of models of their own.
 */
export function bundledTierEntry(tier: Tier, surface: TierSurface = 'agent'): TierEntry {
  const d = resolveModelPolicy(null, { surface: surface === 'agent' ? 'coding' : 'chat', tier });
  return {
    provider: d.provider as TierProvider,
    model: d.model,
    ...(d.effort ? { defaultEffort: d.effort } : {}),
    source: 'default',
  };
}

// Opt-in only: nothing routes to premium-plus on its own. The kind×complexity
// matrix in model-router.ts tops out at `premium`, so premium-plus is reached
// solely by an explicit `tier` on a task or a role. Fable is ~2x premium per token.
export const TIER_DEFAULTS: Record<Tier, TierEntry> = Object.freeze(
  Object.fromEntries(TIERS.map((t) => [t, Object.freeze(bundledTierEntry(t))])),
) as Record<Tier, TierEntry>;

// Which model backs a tier is a policy call, so it is hand-maintained in the
// policy's bundled fallback (packages/ai-kit/src/policy/defaults.ts) and in
// `model_tier_registry` — `GET /v1/models` lists what exists, not what we
// should route to. `auditTierModels` (model-tier-liveness.ts) checks the choice
// against that list instead, because the choice can go stale silently: standard
// sat on `claude-sonnet-4-6` after `claude-sonnet-5` shipped CHEAPER
// ($2/$10 input/output per MTok against $3/$15), so the fleet paid more for an
// older model. Keep the tiers on one generation unless there is a stated reason.
