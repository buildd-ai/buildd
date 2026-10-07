/**
 * Quality Scout probe selection — `selectScoutProbes(set, decide, options)`.
 *
 * Picks at most `budget` mutually independent probes from a candidate set
 * (`./candidates.ts`), in two stages:
 *
 * 1. **Deterministic must-run.** A deliberately short table of severe rules
 *    (`MUST_RUN_RULES`), capped at `maxMustRun`. Only a candidate grounded in
 *    the current change qualifies: history alone is never proof.
 * 2. **The shared decision kind** `buildd.scout_probe_selection`, asked once
 *    per remaining candidate with bounded structured metadata only (the kind's
 *    features: no titles, paths or invariants). Which model answers, and what
 *    happens when none can, is the kind's policy; this module never names one.
 *    A decider that throws or answers outside the kind's decision set gets the
 *    kind's own deterministic fallback, so a failure stays bounded.
 *
 * Independence: a candidate that shares an anchor and family with, or largely overlaps the
 * paths of, an already-selected probe of the same kind, or would run the same
 * command / request / capture as one, is a near-duplicate; a probe family is
 * capped at `maxPerFamily`. Neither costs a decision.
 *
 * Every candidate ends up exactly once in `selected` or `skipped`, with a reason.
 */

import type { DecisionRequest, DecisionSource } from '@builddai/ai-kit/decide';
import {
  SCOUT_PROBE_DECISIONS,
  SCOUT_PROBE_SELECTION_CONFIG,
  scoutProbeSelectionKind,
  type ScoutProbeDecision,
  type ScoutProbeFeatures,
} from '../decision-kind-scout-probe-selection';
import { runBuilddDecision, type BuilddDecisionDeps, type BuilddDecisionScope } from '../decision-policy';
import { scoutCapabilityFixesExecution } from './adapters/kinds';
import type { ScoutCandidateSet, ScoutProbeCandidate, ScoutProbeFamily } from './candidates';

export const DEFAULT_SCOUT_BUDGET = 4;
export const MAX_SCOUT_BUDGET = 10;
export const DEFAULT_MAX_MUST_RUN = 2;
export const DEFAULT_MAX_PER_FAMILY = 2;
/** Decisions asked per budget slot, before the rest are left unconsidered. */
const DECISIONS_PER_SLOT = 3;
/** Path overlap (Jaccard) at which two same-kind candidates are one hypothesis. */
const NEAR_DUPLICATE_OVERLAP = 0.5;

export interface ScoutMustRunRule {
  id: string;
  matches(c: ScoutProbeCandidate): boolean;
}

/** Kept short on purpose: anything not here competes on the decision kind. */
export const MUST_RUN_RULES: readonly ScoutMustRunRule[] = [
  { id: 'critical_on_changed_path', matches: (c) => c.severity === 'critical' && c.touchesChangedPaths },
  {
    id: 'prior_severe_finding_touched',
    matches: (c) =>
      c.touchesChangedPaths && (c.severity === 'critical' || c.severity === 'high') && c.sourceSignals.some((s) => s.type === 'prior-finding'),
  },
  {
    id: 'critical_path_touched',
    matches: (c) =>
      c.touchesChangedPaths && (c.severity === 'critical' || c.severity === 'high') && c.sourceSignals.some((s) => s.type === 'critical-path'),
  },
];

export interface ScoutProbeDecisionResult {
  decision: ScoutProbeDecision;
  reasonCode: string;
  source: DecisionSource;
}

/** Asks the kind. The default (`createScoutProbeDecider`) runs it through the team's decision policy. */
export type ScoutProbeDecider = (request: DecisionRequest<ScoutProbeFeatures>) => Promise<ScoutProbeDecisionResult>;

export interface ScoutSelectionOptions {
  /** Max probes selected. Default `DEFAULT_SCOUT_BUDGET`, clamped to [1, `MAX_SCOUT_BUDGET`]. */
  budget?: number;
  /** Max must-run picks. Default `DEFAULT_MAX_MUST_RUN`, never above the budget. */
  maxMustRun?: number;
  maxPerFamily?: number;
  /** Max decisions asked. Default three per budget slot. */
  maxDecisions?: number;
}

export interface ScoutSelectedProbe {
  candidate: ScoutProbeCandidate;
  via: 'must_run' | 'decision';
  /** The must-run rule id, or the decision's reason code. */
  reasonCode: string;
  /** Null for a must-run pick: no decision was asked. */
  decisionSource: DecisionSource | null;
}

export type ScoutSkipReason = 'unsupported' | 'near_duplicate' | 'family_cap' | 'deferred' | 'over_budget' | 'not_considered';

export interface ScoutSkippedProbe {
  candidate: ScoutProbeCandidate;
  reason: ScoutSkipReason;
  reasonCode?: string;
  detail?: string;
  duplicateOf?: string;
}

export interface ScoutProbeSelection {
  budget: number;
  selected: ScoutSelectedProbe[];
  skipped: ScoutSkippedProbe[];
  decisionsAsked: number;
  /** Decisions that threw or answered outside the kind's set; the kind's fallback was used. */
  decisionFailures: number;
}

const clampInt = (v: number | undefined, fallback: number, lo: number, hi: number) =>
  Math.min(Math.max(Math.floor(Number.isFinite(v) ? (v as number) : fallback), lo), hi);

function overlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const inter = b.filter((p) => sa.has(p)).length;
  return inter / (sa.size + new Set(b).size - inter);
}

function duplicateOf(c: ScoutProbeCandidate, selected: readonly ScoutSelectedProbe[]): string | null {
  for (const { candidate: s } of selected) {
    // A shared anchor is one hypothesis only within a family: a changed area
    // holding UI and non-UI files is both a surface and a contract question.
    if (s.anchor === c.anchor && s.family === c.family) return s.id;
    // A command, request or capture runs the same whatever hypothesis picked it:
    // one execution is one check (and one finding), so it spends one slot.
    if (c.executor && s.executor === c.executor && scoutCapabilityFixesExecution(c.executor)) return s.id;
    if (s.probeKind === c.probeKind && overlap(s.paths, c.paths) >= NEAR_DUPLICATE_OVERLAP) return s.id;
  }
  return null;
}

/** The kind's features for a candidate: bounded metadata, nothing free-text. */
export function scoutProbeFeatures(c: ScoutProbeCandidate, changedFiles: number, budgetRemaining: number): ScoutProbeFeatures {
  return {
    probeKind: c.probeKind,
    supported: c.supported,
    mustRun: false,
    touchesChangedPaths: c.touchesChangedPaths,
    priorFailures: Math.max(0, Math.floor(c.priorFailures)),
    changedFiles: Math.max(0, Math.floor(changedFiles)),
    budgetRemaining: Math.max(0, budgetRemaining),
  };
}

async function decideOne(decide: ScoutProbeDecider, request: DecisionRequest<ScoutProbeFeatures>): Promise<{ result: ScoutProbeDecisionResult; failed: boolean }> {
  try {
    const r = await decide(request);
    if (r && (SCOUT_PROBE_DECISIONS as readonly string[]).includes(r.decision)) return { result: r, failed: false };
  } catch {
    // Falls through to the kind's fallback.
  }
  const fb = SCOUT_PROBE_SELECTION_CONFIG.fallback(request.features, 'provider_failure');
  return { result: { ...fb, source: 'fallback' }, failed: true };
}

export async function selectScoutProbes(
  set: ScoutCandidateSet,
  decide: ScoutProbeDecider,
  options: ScoutSelectionOptions = {},
): Promise<ScoutProbeSelection> {
  const budget = clampInt(options.budget, DEFAULT_SCOUT_BUDGET, 1, MAX_SCOUT_BUDGET);
  const maxMustRun = clampInt(options.maxMustRun, DEFAULT_MAX_MUST_RUN, 0, budget);
  const maxPerFamily = clampInt(options.maxPerFamily, DEFAULT_MAX_PER_FAMILY, 1, budget);
  const maxDecisions = clampInt(options.maxDecisions, budget * DECISIONS_PER_SLOT, 0, budget * DECISIONS_PER_SLOT * 4);

  const selected: ScoutSelectedProbe[] = [];
  const skipped: ScoutSkippedProbe[] = [];
  const done = new Set<string>();
  const perFamily = new Map<ScoutProbeFamily, number>();
  const skip = (s: ScoutSkippedProbe) => {
    skipped.push(s);
    done.add(s.candidate.id);
  };
  const pick = (p: ScoutSelectedProbe) => {
    selected.push(p);
    done.add(p.candidate.id);
    perFamily.set(p.candidate.family, (perFamily.get(p.candidate.family) ?? 0) + 1);
  };
  /** Unsupported, duplicate or family-capped: skipped without spending a decision. */
  const gate = (c: ScoutProbeCandidate): boolean => {
    if (!c.supported) {
      skip({ candidate: c, reason: 'unsupported', ...(c.unsupportedReason ? { detail: c.unsupportedReason } : {}) });
      return false;
    }
    const dup = duplicateOf(c, selected);
    if (dup) {
      skip({ candidate: c, reason: 'near_duplicate', duplicateOf: dup });
      return false;
    }
    if ((perFamily.get(c.family) ?? 0) >= maxPerFamily) {
      skip({ candidate: c, reason: 'family_cap', detail: `${c.family} already has ${maxPerFamily} probe(s) selected.` });
      return false;
    }
    return true;
  };

  // Stage 1: deterministic must-run.
  let mustRun = 0;
  for (const c of set.candidates) {
    if (mustRun >= maxMustRun || selected.length >= budget) break;
    const rule = MUST_RUN_RULES.find((r) => r.matches(c));
    if (!rule || !gate(c)) continue;
    pick({ candidate: c, via: 'must_run', reasonCode: rule.id, decisionSource: null });
    mustRun++;
  }

  // Stage 2: the decision kind, in candidate order.
  let decisionsAsked = 0;
  let decisionFailures = 0;
  for (const c of set.candidates) {
    if (done.has(c.id)) continue;
    if (selected.length >= budget) {
      skip({ candidate: c, reason: 'over_budget' });
      continue;
    }
    if (!gate(c)) continue;
    if (decisionsAsked >= maxDecisions) {
      skip({ candidate: c, reason: 'not_considered', detail: `Decision limit of ${maxDecisions} reached.` });
      continue;
    }
    decisionsAsked++;
    const { result, failed } = await decideOne(decide, {
      features: scoutProbeFeatures(c, set.changedFiles, budget - selected.length),
      featureSchemaVersion: SCOUT_PROBE_SELECTION_CONFIG.featureSchemaVersion,
      subjectRef: { type: 'scout_candidate', id: c.id },
    });
    if (failed) decisionFailures++;
    if (result.decision === 'run') {
      pick({ candidate: c, via: 'decision', reasonCode: result.reasonCode, decisionSource: result.source });
    } else {
      skip({ candidate: c, reason: result.decision === 'unsupported' ? 'unsupported' : 'deferred', reasonCode: result.reasonCode });
    }
  }

  return { budget, selected, skipped, decisionsAsked, decisionFailures };
}

/** The default decider: the shared kind, run under the team's decision policy and recorded in its ledger. */
export function createScoutProbeDecider(scope: BuilddDecisionScope, deps: BuilddDecisionDeps = {}): ScoutProbeDecider {
  return async (request) => {
    const r = await runBuilddDecision(scoutProbeSelectionKind, request, scope, deps);
    return { decision: r.decision, reasonCode: r.reasonCode, source: r.source };
  };
}
