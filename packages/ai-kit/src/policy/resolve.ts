/**
 * The resolver: (policy, surface + tier [+ app, workspace]) → one route.
 * Pure and synchronous; the same function runs in the kit (local policy), in
 * the standalone policy service and in tests.
 *
 * Precedence, first match wins (the same order buildd's tier registry uses:
 * workspace+surface → workspace → team+surface → team → code default):
 *
 *   1. override for the caller's app/workspace + surface + tier
 *      (most specific first: workspace > app, then surface-scoped > both-surface)
 *   2. surfaces[surface][tier]
 *   3. tiers[tier]
 *   4. the bundled fallback policy
 *
 * An experiment covering the request then applies on top: pinned and split
 * replace the route, shadow only names a challenger on the decision.
 */

import { shortHash } from '../decide/index';
import { DEFAULT_MODEL_POLICY } from './defaults';
import type {
  DecisionSource, ExperimentArm, KitTier, ModelPolicy, PolicyDecision, PolicyExperiment,
  PolicyRequest, PolicyRoute, PolicyScope,
} from './types';

export interface ResolveOptions {
  /** Consulted for a tier the policy leaves unset. Must set every tier. Default `DEFAULT_MODEL_POLICY`. */
  fallback?: ModelPolicy & { tiers: Record<KitTier, PolicyRoute> };
  /**
   * What an experiment allocates on: the same unit always lands in the same
   * arm. Default the request's workspaceId, then app, then a random draw.
   */
  unit?: string;
  /** For tests. Default `Math.random`. */
  random?: () => number;
}

function scopeMatches(scope: PolicyScope | undefined, req: PolicyRequest): boolean {
  if (!scope) return true;
  if (scope.app !== undefined && scope.app !== req.app) return false;
  if (scope.workspaceId !== undefined && scope.workspaceId !== req.workspaceId) return false;
  return true;
}

/** The route the policy maps the request to, before experiments. */
export function pickRoute(
  policy: ModelPolicy | null,
  req: PolicyRequest,
  fallback: ModelPolicy & { tiers: Record<KitTier, PolicyRoute> } = DEFAULT_MODEL_POLICY,
): { route: PolicyRoute; source: Exclude<DecisionSource, 'experiment' | 'cached' | 'fallback'> } {
  if (policy) {
    let best: { route: PolicyRoute; score: number } | null = null;
    for (const o of policy.overrides ?? []) {
      if (o.tier !== req.tier || !scopeMatches(o.match, req)) continue;
      if (o.surface !== undefined && o.surface !== req.surface) continue;
      const score = (o.match.workspaceId !== undefined ? 4 : 0) + (o.match.app !== undefined ? 2 : 0) + (o.surface !== undefined ? 1 : 0);
      // Ties keep the first listed.
      if (!best || score > best.score) best = { route: o.route, score };
    }
    if (best) return { route: best.route, source: 'override' };
    const bySurface = policy.surfaces?.[req.surface]?.[req.tier];
    if (bySurface) return { route: bySurface, source: 'surface' };
    const base = policy.tiers[req.tier];
    if (base) return { route: base, source: 'tier' };
  }
  return { route: fallback.tiers[req.tier], source: 'bundled' };
}

/** The first experiment covering the request, if any. */
export function findExperiment(policy: ModelPolicy | null, req: PolicyRequest): PolicyExperiment | null {
  for (const e of policy?.experiments ?? []) {
    if (e.tier !== req.tier) continue;
    if (e.surface !== undefined && e.surface !== req.surface) continue;
    if (!scopeMatches(e.match, req)) continue;
    return e;
  }
  return null;
}

/**
 * A number in [0, 1) fixed by (experiment, unit). The kit's decision hash
 * (FNV-1a), finished with murmur3's fmix32: FNV's high bits barely move
 * between near-identical units (`u1`, `u2`, …), which skews a weighted split.
 */
export function allocationPoint(experimentKey: string, unit: string): number {
  let h = parseInt(shortHash(`${experimentKey}:${unit}`).slice(4, 12), 16);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x1_0000_0000;
}

/** The arm at `point` along the arms' cumulative weights. */
export function pickArm(arms: readonly ExperimentArm[], point: number): ExperimentArm {
  const total = arms.reduce((s, a) => s + (a.weight ?? 1), 0);
  let at = point * total;
  for (const a of arms) {
    at -= a.weight ?? 1;
    if (at < 0) return a;
  }
  return arms[arms.length - 1];
}

/**
 * Resolve a request against a policy. `planId` is null: only a policy
 * service issues plan ids (the caller sets one if it has one).
 */
export function resolveModelPolicy(policy: ModelPolicy | null, req: PolicyRequest, opts: ResolveOptions = {}): PolicyDecision {
  const fallback = opts.fallback ?? DEFAULT_MODEL_POLICY;
  const picked = pickRoute(policy, req, fallback);
  let route = picked.route;
  let source: DecisionSource = picked.source;
  let experiment: PolicyDecision['experiment'];

  const e = findExperiment(policy, req);
  if (e) {
    if (e.mode === 'shadow') {
      const arm = e.arms[0];
      experiment = { key: e.key, mode: e.mode, arm: 'control', shadow: { arm: arm.name, ...arm.route } };
    } else {
      let arm: ExperimentArm;
      if (e.mode === 'pinned') arm = e.arms[0];
      else {
        const unit = opts.unit ?? req.workspaceId ?? req.app;
        const point = unit !== undefined ? allocationPoint(e.key, unit) : (opts.random ?? Math.random)();
        // split and adaptive allocate the same way; adaptive differs only in
        // who moves the weights (the service, from the declared signal).
        arm = pickArm(e.arms, point);
      }
      route = arm.route;
      source = 'experiment';
      experiment = { key: e.key, mode: e.mode, arm: arm.name };
    }
  }

  const decision: PolicyDecision = {
    provider: route.provider,
    model: route.model,
    effort: route.effort ?? null,
    policyVersion: policy?.version ?? fallback.version,
    planId: null,
    surface: req.surface,
    tier: req.tier,
    source,
  };
  if (experiment) decision.experiment = experiment;
  return decision;
}
