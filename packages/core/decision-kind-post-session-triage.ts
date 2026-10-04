/**
 * `buildd.post_session_triage`: should a finished agent session get a deeper,
 * read-only analysis? A first-party decision kind on the shared substrate
 * (`decision-kinds.ts`, `decision-policy.ts`), for the post-session quality
 * loop to import. It owns the decision contract only; collecting the facts,
 * evaluating hard triggers and running the analyser stay in that feature.
 *
 * Semantics this kind owns, and the scout kind does not share:
 *
 * - **Output**: `skip | analyse`, plus a focus carried in the reason code
 *   (`focus_<focus>`, read back with `triageFocusOf`).
 * - **Override**: any hard trigger the feature evaluated forces `analyse`. The
 *   trigger *rules* are the feature's; that a trigger beats the model is this
 *   kind's policy, so it is code here, in every rollout mode.
 * - **Fallback fails open**: nothing could be decided ⇒ `skip`, with
 *   `triage_unavailable` when no model answered. Triage is background work;
 *   a missed analysis costs less than a stampede of them.
 * - **Outcome**: `actionable` / `not_actionable` from the analyser (source
 *   `post_session_analysis`). `analyse` was right on `actionable`, `skip` on
 *   `not_actionable`.
 *
 * Features are bounded counters and booleans only: no ids, no text.
 */

import { choice } from '@builddai/ai-kit/decide';
import type { DecisionKindConfig, DecisionResponse, FeatureParse } from '@builddai/ai-kit/decide';
import { defineBuilddDecisionKind, type BuilddDecisionKindBinding } from './decision-kinds';
import type { DecisionObjective } from './decision-readout';

export const POST_SESSION_TRIAGE_KIND = 'buildd.post_session_triage' as const;

export const POST_SESSION_TRIAGE_DECISIONS = ['skip', 'analyse'] as const;
export type PostSessionTriageDecision = (typeof POST_SESSION_TRIAGE_DECISIONS)[number];

export const POST_SESSION_TRIAGE_FOCUSES = ['general', 'retrieval', 'knowledge', 'orchestration', 'review_merge', 'runtime'] as const;
export type PostSessionTriageFocus = (typeof POST_SESSION_TRIAGE_FOCUSES)[number];

/** Hard triggers the feature may report. A closed set: an unknown one refuses the features. */
export const POST_SESSION_HARD_TRIGGERS = [
  'reviewer_escalated',
  'review_fix_loop',
  'output_contract_after_work',
  'contradictory_pr_state',
  'severe_error_recurring',
  'success_without_evidence',
] as const;
export type PostSessionHardTrigger = (typeof POST_SESSION_HARD_TRIGGERS)[number];

/** Reason code when no model answered. Never a model label. */
export const TRIAGE_UNAVAILABLE = 'triage_unavailable' as const;

/** Outcome labels the analyser attaches later. */
export const POST_SESSION_OUTCOME_SOURCE = 'post_session_analysis' as const;
export const POST_SESSION_OUTCOME_LABELS = ['actionable', 'not_actionable'] as const;

const MAX_COUNT = 1_000;

export interface PostSessionTriageFeatures {
  sessionFailed: boolean;
  /** Null: the source could not be read. Unknown is not zero. */
  retried: boolean | null;
  prShipped: boolean;
  merged: boolean;
  reviewRounds: number | null;
  requestChanges: number | null;
  ciFixAttempts: number | null;
  errorTotal: number | null;
  transcriptPresent: boolean;
  /** Fact sources the collector could not read. */
  unreadSources: number;
  /** Fired by the feature's own rules, in its order. Any one forces `analyse`. */
  hardTriggers: readonly PostSessionHardTrigger[];
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

export function parsePostSessionTriageFeatures(input: unknown): FeatureParse<PostSessionTriageFeatures> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'features must be an object' };
  const f = input as Record<string, unknown>;
  for (const k of ['sessionFailed', 'prShipped', 'merged', 'transcriptPresent'] as const) {
    if (!isBool(f[k])) return { ok: false, message: `${k} must be a boolean` };
  }
  if (f.retried !== null && !isBool(f.retried)) return { ok: false, message: 'retried must be a boolean or null' };
  for (const k of ['reviewRounds', 'requestChanges', 'ciFixAttempts', 'errorTotal'] as const) {
    if (f[k] !== null && !isCount(f[k])) return { ok: false, message: `${k} must be a non-negative integer or null` };
  }
  if (!isCount(f.unreadSources)) return { ok: false, message: 'unreadSources must be a non-negative integer' };
  const triggers = f.hardTriggers;
  if (!Array.isArray(triggers) || triggers.some(t => !(POST_SESSION_HARD_TRIGGERS as readonly unknown[]).includes(t))) {
    return { ok: false, message: 'hardTriggers must list known triggers' };
  }
  const clamp = (v: unknown) => (v === null ? null : Math.min(v as number, MAX_COUNT));
  return {
    ok: true,
    features: {
      sessionFailed: f.sessionFailed as boolean,
      retried: f.retried as boolean | null,
      prShipped: f.prShipped as boolean,
      merged: f.merged as boolean,
      reviewRounds: clamp(f.reviewRounds),
      requestChanges: clamp(f.requestChanges),
      ciFixAttempts: clamp(f.ciFixAttempts),
      errorTotal: clamp(f.errorTotal),
      transcriptPresent: f.transcriptPresent as boolean,
      unreadSources: Math.min(f.unreadSources as number, MAX_COUNT),
      // Canonical order, deduped: the feature digest must not depend on caller ordering.
      hardTriggers: POST_SESSION_HARD_TRIGGERS.filter(t => (triggers as unknown[]).includes(t)),
    },
  };
}

const questions = {
  decision: choice(
    'A coding agent session just ended. From these counts and outcomes, does it deserve a closer read-only look at what went wrong or could improve?',
    {
      analyse: 'Something in the outcome or behaviour looks unexplained, repeated or costly',
      skip: 'A routine session; the outcome explains itself',
    },
  ),
  focus: choice('If it were analysed, where would the problem most likely be?', {
    general: null,
    retrieval: 'The agent missed knowledge it should have found',
    knowledge: 'The knowledge it found was stale or wrong',
    orchestration: 'Task routing, retries or dependencies',
    review_merge: 'Review, CI or merge friction',
    runtime: 'Sandbox, tooling or environment errors',
  }),
};

/** The kind's rules, questions and fallback. Pure; bind it with `defineBuilddDecisionKind`. */
export const POST_SESSION_TRIAGE_CONFIG: DecisionKindConfig<
  typeof POST_SESSION_TRIAGE_KIND, PostSessionTriageFeatures, PostSessionTriageDecision, typeof questions
> = {
  kind: POST_SESSION_TRIAGE_KIND,
  policyVersion: 'pst-2026-10-03.a',
  featureSchemaVersion: 'pst-features-v1',
  decisions: POST_SESSION_TRIAGE_DECISIONS,
  parseFeatures: parsePostSessionTriageFeatures,
  override: f =>
    f.hardTriggers.length > 0 ? { decision: 'analyse', reasonCode: `hard_trigger_${f.hardTriggers[0]}` } : null,
  questions,
  // The model never sees the trigger list: when it is non-empty no model is asked.
  state: ({ hardTriggers: _t, ...signals }) => signals,
  interpret: a => ({
    decision: a.decision.choice,
    confidence: a.decision.confidence,
    reasonCode: `focus_${a.focus.choice}`,
  }),
  // Not yet measured on a held-out set; the feature raises it after its first readout.
  minConfidence: 0.75,
  fallback: (_f, cause) => ({
    decision: 'skip',
    reasonCode: cause === 'low_confidence' || cause === 'shadow' || cause === 'unmeasured_model' ? `fallback_${cause}` : TRIAGE_UNAVAILABLE,
  }),
};

/** Correct when the analyser's label agrees with the routing. */
export const postSessionTriageObjective: DecisionObjective = {
  source: POST_SESSION_OUTCOME_SOURCE,
  score: (o, answer) =>
    o.label === 'actionable' ? answer === 'analyse'
    : o.label === 'not_actionable' ? answer === 'skip'
    : null,
};

/**
 * Live once its capability is on: the post-session loop is out of band and
 * its fallback is a safe `skip`. No escalation or challenger until measured.
 */
export const POST_SESSION_TRIAGE_BINDING: BuilddDecisionKindBinding = {
  capability: 'post_session_triage',
  mode: 'live',
  readout: { objective: postSessionTriageObjective },
};

export const postSessionTriageKind = defineBuilddDecisionKind(POST_SESSION_TRIAGE_CONFIG, POST_SESSION_TRIAGE_BINDING);

/** The focus a response carries, or null (rules and fallbacks carry none). */
export function triageFocusOf(response: Pick<DecisionResponse, 'reasonCode'>): PostSessionTriageFocus | null {
  const m = /^focus_(.+)$/.exec(response.reasonCode);
  return m && (POST_SESSION_TRIAGE_FOCUSES as readonly string[]).includes(m[1]) ? m[1] as PostSessionTriageFocus : null;
}
