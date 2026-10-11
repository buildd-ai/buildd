/**
 * `buildd.failure_incident_triage`: what is an ambiguous Failure Pattern
 * Sentinel incident? A first-party decision kind on the shared substrate
 * (`decision-kinds.ts`, `decision-policy.ts`). It owns the decision contract
 * only; detecting the incident, alerting and filing a fix task stay in
 * `apps/web/src/lib/failure-incident-actions.ts`.
 *
 * - **Output**: `known_noise | monitor | systemic_bug | page_now`, with a
 *   stable cause in the reason code (`cause_<cause>`).
 * - **Override**: a `critical` deterministic floor is `page_now` by rule, in
 *   every rollout mode. No model is asked about an incident the rules already
 *   call critical.
 * - **The model can only raise.** The floor is the rule engine's severity; the
 *   caller maps the decision to a severity and keeps the max. A `known_noise`
 *   answer on a `high` incident still pages as `high` — it only withholds the
 *   auto-filed fix task.
 * - **Fallback is the floor**: nothing decided ⇒ the decision that maps back to
 *   the floor severity, reason `fallback_<cause>`. Never a model label.
 *
 * Features are bounded counters, booleans and closed enums only: no ids, no
 * error text. The model never sees a log line.
 */

import { choice } from '@builddai/ai-kit/decide';
import type { DecisionKindConfig, FeatureParse } from '@builddai/ai-kit/decide';
import { defineBuilddDecisionKind, type BuilddDecisionKindBinding } from './decision-kinds';

export const FAILURE_INCIDENT_TRIAGE_KIND = 'buildd.failure_incident_triage' as const;

export const FAILURE_INCIDENT_TRIAGE_DECISIONS = ['known_noise', 'monitor', 'systemic_bug', 'page_now'] as const;
export type FailureIncidentTriageDecision = (typeof FAILURE_INCIDENT_TRIAGE_DECISIONS)[number];

export const FAILURE_INCIDENT_TRIAGE_CAUSES = [
  'platform_defect',
  'transient_infra',
  'budget_or_quota',
  'agent_behaviour',
  'configuration',
  'unclear',
] as const;
export type FailureIncidentTriageCause = (typeof FAILURE_INCIDENT_TRIAGE_CAUSES)[number];

/** Mirrors `FailureIncidentRule` in @buildd/shared. A closed set: an unknown rule refuses the features. */
export const FAILURE_INCIDENT_TRIAGE_RULES = [
  'retry_fork',
  'lineage_multi_pr',
  'repeated_failure',
  'stranded_gate',
  'path_overlap_stall',
  'provider_attribution_mismatch',
  'failure_rate_spike',
  'output_unmet_boundary',
] as const;

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
type Severity = (typeof SEVERITIES)[number];

/** The decision that maps back to each floor severity — the fallback. */
export const DECISION_FOR_SEVERITY: Record<Severity, FailureIncidentTriageDecision> = {
  low: 'known_noise',
  medium: 'monitor',
  high: 'systemic_bug',
  critical: 'page_now',
};

const MAX_COUNT = 100_000;

export interface FailureIncidentTriageFeatures {
  rule: (typeof FAILURE_INCIDENT_TRIAGE_RULES)[number];
  /** The rule engine's severity: the minimum. */
  floorSeverity: Severity;
  occurrenceCount: number;
  /** Breadth: distinct tasks / PRs / workers the rule counted. */
  distinctTasks: number;
  /** Times it came back after being resolved. */
  recurrenceCount: number;
  /** First to last seen. */
  spanMinutes: number;
  /** The deterministic budget / transient-infrastructure matcher fired. */
  transientOrBudget: boolean;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function parseFailureIncidentTriageFeatures(input: unknown): FeatureParse<FailureIncidentTriageFeatures> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'features must be an object' };
  const f = input as Record<string, unknown>;
  if (!(FAILURE_INCIDENT_TRIAGE_RULES as readonly unknown[]).includes(f.rule)) return { ok: false, message: 'rule must be a known incident rule' };
  if (!(SEVERITIES as readonly unknown[]).includes(f.floorSeverity)) return { ok: false, message: 'floorSeverity must be low|medium|high|critical' };
  for (const k of ['occurrenceCount', 'distinctTasks', 'recurrenceCount', 'spanMinutes'] as const) {
    if (!isCount(f[k])) return { ok: false, message: `${k} must be a non-negative number` };
  }
  if (typeof f.transientOrBudget !== 'boolean') return { ok: false, message: 'transientOrBudget must be a boolean' };
  const clamp = (v: unknown) => Math.min(Math.round(v as number), MAX_COUNT);
  return {
    ok: true,
    features: {
      rule: f.rule as FailureIncidentTriageFeatures['rule'],
      floorSeverity: f.floorSeverity as Severity,
      occurrenceCount: clamp(f.occurrenceCount),
      distinctTasks: clamp(f.distinctTasks),
      recurrenceCount: clamp(f.recurrenceCount),
      spanMinutes: clamp(f.spanMinutes),
      transientOrBudget: f.transientOrBudget,
    },
  };
}

const questions = {
  decision: choice(
    'A deterministic detector flagged a repeated failure pattern across an AI coding-agent platform. From these counts, what is it?',
    {
      known_noise: 'Expected background noise; record it and move on',
      monitor: 'Worth watching, not yet a defect; record it for the digest',
      systemic_bug: 'A platform defect that needs a fix task',
      page_now: 'Actively breaking work right now; a person should be paged',
    },
  ),
  cause: choice('What most likely causes it?', {
    platform_defect: 'A bug in the platform itself',
    transient_infra: 'A provider or network blip that clears on its own',
    budget_or_quota: 'Spend, rate or quota limits',
    agent_behaviour: 'Agents doing the work badly',
    configuration: 'Workspace or role setup',
    unclear: null,
  }),
};

export const FAILURE_INCIDENT_TRIAGE_CONFIG: DecisionKindConfig<
  typeof FAILURE_INCIDENT_TRIAGE_KIND, FailureIncidentTriageFeatures, FailureIncidentTriageDecision, typeof questions
> = {
  kind: FAILURE_INCIDENT_TRIAGE_KIND,
  policyVersion: 'fit-2026-10-04.a',
  featureSchemaVersion: 'fit-features-v1',
  decisions: FAILURE_INCIDENT_TRIAGE_DECISIONS,
  parseFeatures: parseFailureIncidentTriageFeatures,
  override: f =>
    f.floorSeverity === 'critical' ? { decision: 'page_now', reasonCode: `critical_floor_${f.rule}` } : null,
  questions,
  state: f => ({ ...f }),
  interpret: a => ({
    decision: a.decision.choice,
    confidence: a.decision.confidence,
    reasonCode: `cause_${a.cause.choice}`,
  }),
  // Not yet measured on a held-out set. Below it the floor stands.
  minConfidence: 0.7,
  // Unparseable features carry no floor; `monitor` keeps them on the digest without paging.
  fallback: (f, cause) => ({ decision: f ? DECISION_FOR_SEVERITY[f.floorSeverity] : 'monitor', reasonCode: `fallback_${cause}` }),
};

/** Live once its capability is on: the model can only raise severity, so a wrong answer costs a page, not a missed one. */
export const FAILURE_INCIDENT_TRIAGE_BINDING: BuilddDecisionKindBinding = {
  capability: 'failure_incident_triage',
  mode: 'live',
};

export const failureIncidentTriageKind = defineBuilddDecisionKind(FAILURE_INCIDENT_TRIAGE_CONFIG, FAILURE_INCIDENT_TRIAGE_BINDING);
