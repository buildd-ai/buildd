/**
 * Task-creation-time echo of what the claim-time router (`model-router.ts`)
 * will do with a task, plus the conservative heuristic that fills `kind`/
 * `complexity` when the caller left them blank.
 *
 * Most tasks are filed with neither field, so they silently land on
 * engineering/normal -> standard (Sonnet) with nothing telling the filer that
 * happened or how to ask for more. This module answers "what will this get
 * and why" at creation time, using the same baseline matrix the claim route
 * reads — with budget pressure and spike detection ignored, since neither is
 * known yet at creation time and both only ever downshift, never upshift.
 *
 * No DB dependency — safe to call from the API route during request handling.
 */

import {
  resolveEffectiveModel,
  type TaskKind,
  type TaskComplexity,
  type Tier as RouterTier,
} from './model-router';
import { TIER_DEFAULTS, type Tier } from './model-tier-defaults';
import { getModelDisplayName } from './model-display';

const ROUTER_TIER_TO_REGISTRY_TIER: Record<RouterTier, Tier> = {
  haiku: 'budget',
  sonnet: 'standard',
  opus: 'premium',
};

// A manifest this wide is treated as touching "a lot of the codebase" rather
// than a single focused change — conservative on purpose, so a two- or
// three-file task never gets bumped.
const PATH_BREADTH_THRESHOLD = 6;

// A description this long usually means the filer already did the analysis
// and is describing a multi-step change, not a one-liner.
const DESCRIPTION_LENGTH_THRESHOLD = 2000;

// Files whose change alone is enough to call a task non-trivial regardless of
// how small the manifest otherwise is: schema migrations, the claim route
// (the router's own dispatch point), and anything under an auth surface.
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|\/)schema\.ts$/,
  /\/claim\/route\.ts$/,
  /(^|[/-])auth([/-]|\.[a-z]+$)/i,
];

// Title prefixes the platform already uses to mark orchestration/bookkeeping
// rows (see the `taskClass` derivation in apps/web/src/app/api/tasks/route.ts)
// — the same shape of task reads as `coordination` for routing purposes.
const COORDINATION_TITLE_PREFIXES = [
  'Mission:',
  'Aggregate results:',
  'Evaluate mission completion:',
  'Close mission',
];

export interface RoutingInferenceInput {
  kind?: TaskKind | null;
  complexity?: TaskComplexity | null;
  title?: string | null;
  description?: string | null;
  pathManifest?: readonly string[] | null;
  /** Advisory manifests (e.g. the `**` mission wildcard) carry no file signal. */
  pathManifestIsConcrete?: boolean;
  emitsPlan?: boolean;
}

export interface RoutingInferenceResult {
  /** Resolved kind: explicit value, inferred value, or the router's own default. */
  kind: TaskKind;
  /** Resolved complexity: explicit value, inferred value, or the router's own default. */
  complexity: TaskComplexity;
  /** True when a rule set `kind` (only possible when the caller left it blank). */
  kindInferred: boolean;
  /** True when a rule set `complexity` (only possible when the caller left it blank). */
  complexityInferred: boolean;
  /** Why `kind` was inferred, null when not inferred. */
  kindReason: string | null;
  /** Why `complexity` was inferred, null when not inferred. */
  complexityReason: string | null;
}

function inferKind(
  title: string | null | undefined,
  emitsPlan: boolean | undefined,
): { kind: TaskKind; reason: string } | null {
  if (emitsPlan) {
    return { kind: 'coordination', reason: 'emitsPlan is a planning/breakdown task' };
  }
  const t = (title ?? '').trim();
  const prefix = COORDINATION_TITLE_PREFIXES.find(p => t.startsWith(p));
  if (prefix) {
    return { kind: 'coordination', reason: `title starts with "${prefix}"` };
  }
  return null;
}

function inferComplexity(
  pathManifest: readonly string[] | null | undefined,
  pathManifestIsConcrete: boolean,
  description: string | null | undefined,
): { complexity: TaskComplexity; reason: string } | null {
  const manifest = pathManifestIsConcrete ? (pathManifest ?? []) : [];

  if (manifest.length >= PATH_BREADTH_THRESHOLD) {
    return { complexity: 'complex', reason: `pathManifest touches ${manifest.length} files` };
  }

  const sensitive = manifest.find(p => SENSITIVE_PATH_PATTERNS.some(re => re.test(p)));
  if (sensitive) {
    return { complexity: 'complex', reason: `pathManifest touches a sensitive path (${sensitive})` };
  }

  const descLength = (description ?? '').length;
  if (descLength >= DESCRIPTION_LENGTH_THRESHOLD) {
    return { complexity: 'complex', reason: `description is ${descLength} characters` };
  }

  return null;
}

/**
 * Fill blank `kind`/`complexity` with a cheap deterministic heuristic. Never
 * overrides a caller-supplied value — explicit input always wins.
 */
export function inferRouting(input: RoutingInferenceInput): RoutingInferenceResult {
  const hasKind = input.kind !== undefined && input.kind !== null;
  const hasComplexity = input.complexity !== undefined && input.complexity !== null;

  let kind: TaskKind = hasKind ? (input.kind as TaskKind) : 'engineering';
  let complexity: TaskComplexity = hasComplexity ? (input.complexity as TaskComplexity) : 'normal';
  let kindInferred = false;
  let complexityInferred = false;
  let kindReason: string | null = null;
  let complexityReason: string | null = null;

  if (!hasKind) {
    const rule = inferKind(input.title, input.emitsPlan);
    if (rule) {
      kind = rule.kind;
      kindInferred = true;
      kindReason = rule.reason;
    }
  }

  if (!hasComplexity) {
    const rule = inferComplexity(
      input.pathManifest,
      input.pathManifestIsConcrete ?? true,
      input.description,
    );
    if (rule) {
      complexity = rule.complexity;
      complexityInferred = true;
      complexityReason = rule.reason;
    }
  }

  return { kind, complexity, kindInferred, complexityInferred, kindReason, complexityReason };
}

export interface RoutingPreviewInput extends RoutingInferenceInput {
  /** `tasks.tier` — a hard override that skips the kind x complexity matrix. */
  tier?: Tier | null;
  /** `context.model` — an explicit model id, wins over everything. */
  model?: string | null;
}

export interface RoutingPreview {
  /** Null only when an explicit model pin bypassed tier resolution entirely. */
  tier: Tier | null;
  /** Concrete model id this would resolve to right now (code-level defaults). */
  model: string;
  reason: string;
  inferred: boolean;
}

/**
 * Preview what the claim-time router would do with this task RIGHT NOW —
 * budget pressure and spike detection ignored, since a preview computed at
 * creation time cannot know either, and both gates only ever downshift.
 */
export function computeRoutingPreview(input: RoutingPreviewInput): RoutingPreview {
  if (input.model && input.model.trim() && input.model.trim().toLowerCase() !== 'inherit') {
    const model = input.model.trim();
    return {
      tier: null,
      model,
      reason: `model:"${model}" pinned — bypasses tier and kind/complexity routing`,
      inferred: false,
    };
  }

  if (input.tier) {
    const entry = TIER_DEFAULTS[input.tier];
    return {
      tier: input.tier,
      model: entry.model,
      reason: `tier:"${input.tier}" pinned — bypasses kind/complexity routing → ${getModelDisplayName(entry.model)}`,
      inferred: false,
    };
  }

  const hasKind = input.kind !== undefined && input.kind !== null;
  const hasComplexity = input.complexity !== undefined && input.complexity !== null;
  const inference = inferRouting(input);
  const inferred = inference.kindInferred || inference.complexityInferred;

  const decision = resolveEffectiveModel({
    kind: inference.kind,
    complexity: inference.complexity,
    dailyBudgetPct: 0,
    recentClaimCount: 0,
    priority: 0,
  });
  // Budget/spike gates are the only paths that can return 'paused', and both
  // are fed zeroes above, so this is always a plain haiku/sonnet/opus alias.
  const tier = ROUTER_TIER_TO_REGISTRY_TIER[decision.model as RouterTier];
  const modelLabel = getModelDisplayName(TIER_DEFAULTS[tier].model);

  const missing = [!hasKind && 'kind', !hasComplexity && 'complexity'].filter(Boolean).join('/');

  let reason: string;
  if (!missing) {
    reason = `kind:"${inference.kind}" complexity:"${inference.complexity}" → ${tier} (${modelLabel})`;
  } else if (inferred) {
    const reasons = [inference.kindReason, inference.complexityReason].filter(Boolean).join('; ');
    reason = `no ${missing} given — inferred ${inference.kind}/${inference.complexity} (${reasons}) → ${tier} (${modelLabel})`;
  } else {
    const bump = tier === 'premium'
      ? ''
      : ` Pass complexity:"complex" or tier:"premium" for a higher tier.`;
    reason = `no ${missing} given — defaulted to ${inference.kind}/${inference.complexity} → ${tier} (${modelLabel}).${bump}`;
  }

  return { tier, model: TIER_DEFAULTS[tier].model, reason, inferred };
}
