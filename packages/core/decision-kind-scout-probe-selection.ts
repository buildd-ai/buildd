/**
 * `buildd.scout_probe_selection`: should the quality scout run this candidate
 * probe against the work it is checking? A first-party decision kind on the
 * shared substrate (`decision-kinds.ts`, `decision-policy.ts`), asked once per
 * candidate, for the scout feature to import. Building the candidate list,
 * capping the run and executing probes stay in that feature.
 *
 * Semantics this kind owns, and the triage kind does not share:
 *
 * - **Output**: `run | defer | unsupported`. `unsupported` is never a model
 *   answer: only the rule says it, so a probe the workspace cannot execute is
 *   reported as such instead of silently skipped.
 * - **Overrides**, in order: no executor ⇒ `unsupported`; a must-run probe
 *   (its invariant is declared for a changed path) ⇒ `run`; no budget left ⇒
 *   `defer`.
 * - **Fallback leans toward coverage**: when no model decision is applied, a
 *   probe that touches changed paths runs and any other is deferred. Unparseable
 *   features defer.
 * - **Escalation** on low confidence is part of the policy; the binding ships
 *   no richer model, so until one is bound the readout shows `no_route`.
 * - **Outcome**: `defect_found` / `no_defect` once a probe ran or was replayed
 *   (source `scout_probe_result`). `run` was right on `defect_found`, `defer`
 *   on `no_defect`.
 *
 * Features are a closed probe vocabulary plus bounded counters: no paths, no text.
 */

import { choice } from '@builddai/ai-kit/decide';
import type { DecisionKindConfig, FeatureParse } from '@builddai/ai-kit/decide';
import { defineBuilddDecisionKind, type BuilddDecisionKindBinding } from './decision-kinds';
import type { DecisionObjective } from './decision-readout';

export const SCOUT_PROBE_SELECTION_KIND = 'buildd.scout_probe_selection' as const;

export const SCOUT_PROBE_DECISIONS = ['run', 'defer', 'unsupported'] as const;
export type ScoutProbeDecision = (typeof SCOUT_PROBE_DECISIONS)[number];

export const SCOUT_PROBE_KINDS = ['route_smoke', 'api_contract', 'visual', 'spec_invariant', 'regression', 'security_boundary'] as const;
export type ScoutProbeKind = (typeof SCOUT_PROBE_KINDS)[number];

export const SCOUT_OUTCOME_SOURCE = 'scout_probe_result' as const;
export const SCOUT_OUTCOME_LABELS = ['defect_found', 'no_defect'] as const;

const MAX_CHANGED_FILES = 10_000;
const MAX_PRIOR_FAILURES = 50;
const MAX_BUDGET = 20;

export interface ScoutProbeFeatures {
  probeKind: ScoutProbeKind;
  /** The workspace has an executor for this probe kind. */
  supported: boolean;
  /** A must-run rule matched (the feature's rule; this kind only obeys it). */
  mustRun: boolean;
  touchesChangedPaths: boolean;
  /** Times this probe failed on this workspace recently. */
  priorFailures: number;
  changedFiles: number;
  /** Probe slots left in this scout run. */
  budgetRemaining: number;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export function parseScoutProbeFeatures(input: unknown): FeatureParse<ScoutProbeFeatures> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'features must be an object' };
  const f = input as Record<string, unknown>;
  if (!(SCOUT_PROBE_KINDS as readonly unknown[]).includes(f.probeKind)) return { ok: false, message: 'probeKind must be a known probe kind' };
  for (const k of ['supported', 'mustRun', 'touchesChangedPaths'] as const) {
    if (typeof f[k] !== 'boolean') return { ok: false, message: `${k} must be a boolean` };
  }
  for (const k of ['priorFailures', 'changedFiles', 'budgetRemaining'] as const) {
    if (!isCount(f[k])) return { ok: false, message: `${k} must be a non-negative integer` };
  }
  return {
    ok: true,
    features: {
      probeKind: f.probeKind as ScoutProbeKind,
      supported: f.supported as boolean,
      mustRun: f.mustRun as boolean,
      touchesChangedPaths: f.touchesChangedPaths as boolean,
      priorFailures: Math.min(f.priorFailures as number, MAX_PRIOR_FAILURES),
      changedFiles: Math.min(f.changedFiles as number, MAX_CHANGED_FILES),
      budgetRemaining: Math.min(f.budgetRemaining as number, MAX_BUDGET),
    },
  };
}

const questions = {
  probe: choice(
    'A quality scout is checking finished work and has limited probe slots. Is this probe likely to find a real defect in this change?',
    {
      run: 'The probe exercises what changed, or has failed here before',
      defer: 'Unlikely to find anything a cheaper probe would not',
    },
  ),
};

/** The kind's rules, questions and fallback. Pure; bind it with `defineBuilddDecisionKind`. */
export const SCOUT_PROBE_SELECTION_CONFIG: DecisionKindConfig<
  typeof SCOUT_PROBE_SELECTION_KIND, ScoutProbeFeatures, ScoutProbeDecision, typeof questions
> = {
  kind: SCOUT_PROBE_SELECTION_KIND,
  policyVersion: 'spsel-2026-10-03.a',
  featureSchemaVersion: 'spsel-features-v1',
  decisions: SCOUT_PROBE_DECISIONS,
  parseFeatures: parseScoutProbeFeatures,
  override: f =>
    !f.supported ? { decision: 'unsupported', reasonCode: 'executor_unsupported' }
    : f.mustRun ? { decision: 'run', reasonCode: 'must_run' }
    : f.budgetRemaining === 0 ? { decision: 'defer', reasonCode: 'budget_exhausted' }
    : null,
  questions,
  state: ({ supported: _s, mustRun: _m, ...rest }) => rest,
  interpret: a => ({ decision: a.probe.choice, confidence: a.probe.confidence, reasonCode: `model_${a.probe.choice}` }),
  // Not yet measured on a held-out set.
  minConfidence: 0.8,
  escalation: { minConfidence: 0.7, on: ['low_confidence'] },
  fallback: (f, cause) =>
    f?.touchesChangedPaths
      ? { decision: 'run', reasonCode: `heuristic_run_${cause}` }
      : { decision: 'defer', reasonCode: `heuristic_defer_${cause}` },
};

/** Correct when the probe's result agrees with the selection. `unsupported` is never scored. */
export const scoutProbeSelectionObjective: DecisionObjective = {
  source: SCOUT_OUTCOME_SOURCE,
  score: (o, answer) => {
    if (answer === 'unsupported') return null;
    return o.label === 'defect_found' ? answer === 'run'
      : o.label === 'no_defect' ? answer === 'defer'
      : null;
  },
};

/** Shadow: Scout is advisory in v1, so the model's pick is recorded and the fallback runs. */
export const SCOUT_PROBE_SELECTION_BINDING: BuilddDecisionKindBinding = {
  capability: 'scout_probe_selection',
  mode: 'shadow',
  readout: { objective: scoutProbeSelectionObjective },
};

export const scoutProbeSelectionKind = defineBuilddDecisionKind(SCOUT_PROBE_SELECTION_CONFIG, SCOUT_PROBE_SELECTION_BINDING);
