import type { ModelDivergence, ScanBounds } from './usage-stats';
import type { DerivedMetric } from '@buildd/core/derived-metric';
/**
 * Turning the three model values a task carries into something a person reads.
 *
 * The three are allowed to disagree, and their disagreement is the point:
 *  - REQUESTED  `tasks.tier`
 *  - RESOLVED   `tasks.predicted_model` + `context.resolvedTier{tier,provider,source}`
 *  - ACTUAL     `worker.result_meta.modelUsage` keys
 *
 * Humanising and comparing model ids lives in `@buildd/core/model-display`; this
 * module only knows about task shapes. No DB import — safe on both sides of the
 * client boundary. See `docs/design/task-model-visibility.md`.
 */
import {
  getModelDisplayName,
  primaryModelFromUsage,
  compareAssignedActual,
} from '@buildd/core/model-display';

/** Legacy alias → canonical tier. Mirrors `ModelPicker`'s map, minus the React. */
const ALIAS_TO_TIER: Record<string, string> = {
  opus: 'premium',
  sonnet: 'standard',
  haiku: 'budget',
};

const TIER_WORDS = new Set(['premium', 'standard', 'budget']);

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The label for a role's or skill's configured model.
 *
 * `inherit` is a real value here (take the workspace default) and an absent
 * model means the same thing, so both read as "Inherit". Everything else goes
 * through the shared humaniser — the map this replaced named a generation, so it
 * announced "Claude Opus 4" long after the premium tier moved on.
 */
export function roleModelLabel(model: string | null | undefined): string {
  const raw = (model ?? '').trim();
  if (!raw || raw.toLowerCase() === 'inherit') return 'Inherit';
  if (TIER_WORDS.has(raw.toLowerCase())) return titleCase(raw.toLowerCase());
  return getModelDisplayName(raw);
}

/**
 * Only reasons a reader would want explained. `baseline` is absent on purpose —
 * the normal path needs no label, and rendering one for it would make the
 * interesting cases harder to spot.
 */
const REASON_LABELS: Record<string, string> = {
  explicit_override: 'pinned',
  budget_downshift: 'budget downshift',
  paused: 'routing paused',
};

type UsageEntry = { inputTokens?: number; outputTokens?: number } | null;

export interface TaskModelInputs {
  /** `tasks.tier` — the tier the caller asked for. */
  tier?: string | null;
  /** `tasks.predicted_model` — what the router resolved at claim time. */
  predictedModel?: string | null;
  /** `tasks.context` — carries `model` and, on the tier path, `resolvedTier`. */
  context?: unknown;
  /** `worker.result_meta.modelUsage` — what actually ran. */
  modelUsage?: Record<string, UsageEntry> | null;
}

export interface TaskModelSummary {
  /** Primary label: the tier word, or "Pinned" when a pin bypassed the tier. */
  tierLabel: string | null;
  /** Canonical tier word behind `tierLabel`, null when pinned or unknown. */
  tier: string | null;
  /** The tier originally requested, kept even when a pin overrode it. */
  requestedTier: string | null;
  /** Secondary detail: the concrete resolved id, exactly as stored. */
  modelId: string | null;
  modelLabel: string | null;
  /** Why this model: 'workspace' | 'team' | 'default'. Null off the tier path. */
  source: string | null;
  pinned: boolean;
  /** True when budget pressure moved this task to a cheaper model. */
  downshifted: boolean;
  /**
   * Human label for a routing reason worth surfacing, else null. `baseline` is
   * deliberately null: "nothing unusual happened" needs no words.
   */
  reasonLabel: string | null;
  /** Highest-token model the SDK reported, null when nothing was attributed. */
  actualModelId: string | null;
  actualModelCount: number;
  /**
   * Humanised name of what ran, ONLY when it disagrees with what was assigned.
   * Missing attribution is never divergence — that is how a rate reads 0% and
   * means "never recorded".
   */
  divergedTo: string | null;
  /** True when there is nothing to render, so callers omit the row entirely. */
  isEmpty: boolean;
}

function readContext(context: unknown): {
  contextModel: string | null;
  resolvedTier: string | null;
  source: string | null;
  routingReason: string | null;
} {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return { contextModel: null, resolvedTier: null, source: null, routingReason: null };
  }
  const c = context as Record<string, unknown>;
  const contextModel = typeof c.model === 'string' && c.model.trim() ? c.model.trim() : null;
  const routingReason =
    typeof c.routingReason === 'string' && c.routingReason.trim() ? c.routingReason.trim() : null;
  const rt = c.resolvedTier;
  if (!rt || typeof rt !== 'object' || Array.isArray(rt)) {
    return { contextModel, resolvedTier: null, source: null, routingReason };
  }
  const r = rt as Record<string, unknown>;
  return {
    contextModel,
    routingReason,
    resolvedTier: typeof r.tier === 'string' && r.tier.trim() ? r.tier.trim().toLowerCase() : null,
    source: typeof r.source === 'string' && r.source.trim() ? r.source.trim() : null,
  };
}

export function deriveTaskModel(inputs: TaskModelInputs): TaskModelSummary {
  const { contextModel, resolvedTier, source, routingReason } = readContext(inputs.context);
  const rawModel = (inputs.predictedModel ?? '').trim() || contextModel;
  // `inherit` is a real value in `context.model` and it names no model — showing
  // it as a pinned id would invent a decision nobody made.
  const modelId = rawModel && rawModel.toLowerCase() !== 'inherit' ? rawModel : null;
  const requestedRaw = (inputs.tier ?? '').trim().toLowerCase() || null;
  const requestedTier = requestedRaw ? (ALIAS_TO_TIER[requestedRaw] ?? requestedRaw) : null;

  const idAsAlias = modelId ? (ALIAS_TO_TIER[modelId.toLowerCase()] ?? null) : null;
  const idIsTierWord = modelId ? TIER_WORDS.has(modelId.toLowerCase()) : false;

  // `pinned` requires POSITIVE evidence — the claim route's recorded reason.
  // It is tempting to infer it from "concrete id and no resolvedTier", but a
  // task claimed before either field was written looks identical, so inferring
  // would label historical tier-routed tasks with a decision nobody made.
  // Unknown reason => not pinned, and the requested tier stays the label.
  const pinned = !!modelId && routingReason === 'explicit_override';
  const downshifted = routingReason === 'budget_downshift';

  const tier = pinned
    ? null
    : resolvedTier ?? idAsAlias ?? (idIsTierWord ? modelId!.toLowerCase() : null) ?? requestedTier;

  const { primary, all } = primaryModelFromUsage(inputs.modelUsage);
  const verdict = compareAssignedActual(modelId, primary);

  return {
    tierLabel: pinned ? 'Pinned' : tier ? titleCase(tier) : null,
    tier,
    requestedTier,
    modelId,
    modelLabel: modelId ? getModelDisplayName(modelId) : null,
    source: pinned ? null : source,
    pinned,
    downshifted,
    reasonLabel: REASON_LABELS[routingReason ?? ''] ?? null,
    actualModelId: primary,
    actualModelCount: all.length,
    divergedTo: verdict.verdict === 'diverged' ? getModelDisplayName(primary) : null,
    isEmpty: !modelId && !tier && !requestedTier,
  };
}

// ===========================================================================
// Aggregate copy (Health)
//
// The task-shaped helpers above answer "what did THIS task run on". The rest of
// this file phrases the fleet-wide answers. Both live here so there is one
// obvious home for model presentation in apps/web: four competing humanisers is
// what this work set out to remove, and two adjacent modules is how that starts
// again.
// ===========================================================================

/**
 * Copy for the Health page's model block.
 *
 * Every number there is qualified by something the reader cannot see: which
 * workers were comparable, whether the account can report per-model usage at
 * all, and how far back the capped scan actually reached. That qualification is
 * the feature, so it lives in a pure module with tests rather than as strings
 * inside JSX.
 *
 * No React, no DB — safe to import from a client component.
 */


/**
 * The divergence rate as a headline plus the sample behind it.
 *
 * The note always carries `n of m` and the exclusion count, because a bare
 * percentage cannot be distinguished from a percentage of nothing — the exact
 * failure `DerivedMetric` exists to prevent.
 */
export function divergenceSummary(
  metric: DerivedMetric<ModelDivergence>,
): { headline: string; note: string } {
  if (metric.kind === 'unavailable') {
    return { headline: '—', note: metric.detail ?? metric.reason };
  }
  const d = metric.value;
  const excluded = d.unattributed > 0
    ? `${d.unattributed} excluded (no model attribution)`
    : 'all comparable';
  return {
    headline: `${Math.round(d.rate * 100)}%`,
    note: `${d.diverged} of ${d.compared} workers · ${excluded}`,
  };
}

/**
 * Why the per-model rollup is empty.
 *
 * `modelUsage` is populated only on API-key auth; a seat/OAuth team gets an
 * empty rollup for every worker it ever ran, which is a property of the auth
 * mode and not an absence of work. Same wording the `get_usage_stats` MCP tool
 * uses (`packages/core/mcp-tools.ts`), so the two surfaces agree.
 */
export function byModelAbsence(totalInputTokens: number): string {
  if (totalInputTokens <= 0) return 'No tokens recorded in this window';
  return 'Unavailable — the SDK reports no per-model usage on seat-based (OAuth) auth';
}

/**
 * The scan cap, stated. Null when the scan covered the requested window, so the
 * caveat only appears when it is true.
 *
 * `sinceLabel` is the caller's rendering of `scan.completeSince` (the page
 * already has a `timeAgo`), keeping this module free of clock dependence.
 */
export function scanCaveat(scan: ScanBounds, sinceLabel: string): string | null {
  if (!scan.truncated) return null;
  return `capped at ${scan.limit.toLocaleString('en-US')} workers — complete only since ${sinceLabel}`;
}
