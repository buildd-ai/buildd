/**
 * Post-session quality loop — Stage B triage, the pure half (artifact
 * `post-session-quality-loop-spec` §6).
 *
 * The decision itself is the registered kind `postSessionTriageKind`
 * (`decision-kind-post-session-triage.ts`): its questions, hard-trigger
 * override, confidence threshold and fail-open fallback live there, and the
 * server half runs it through `runBuilddDecision`. This module keeps what
 * belongs to the loop rather than the decision:
 *  - the **hard-trigger rules** that read Stage A facts (that a trigger beats
 *    the model is the kind's policy; what counts as one is the loop's);
 *  - mapping Stage A facts to the kind's bounded **features** (counters and
 *    booleans: no ids, no PR number, no free text);
 *  - turning a decision response into the **triage record** stored on the run.
 *
 * Unknown is not zero: a source Stage A could not read is null, and a null
 * never fires a trigger.
 *
 * The DB-backed half is `apps/web/src/lib/post-session-triage.ts`.
 */

import type { DecisionResponse } from '@builddai/ai-kit/decide';
import {
  POST_SESSION_HARD_TRIGGERS,
  TRIAGE_UNAVAILABLE,
  triageFocusOf,
  type PostSessionHardTrigger,
  type PostSessionTriageDecision,
  type PostSessionTriageFeatures,
} from './decision-kind-post-session-triage';
import type { PostSessionTriageRecord, StageAFacts, TriageDecision } from './post-session-quality';

export { TRIAGE_UNAVAILABLE };

/** §6 hard triggers. Deliberately short and mechanical. */
export const HARD_TRIGGERS = POST_SESSION_HARD_TRIGGERS;
export type HardTrigger = PostSessionHardTrigger;

/** Request-changes verdicts on one PR that make a fix loop. */
export const REVIEW_LOOP_MIN_REQUEST_CHANGES = 2;
/** CI-fix tasks on one PR that make a fix loop. One or two is ordinary. */
export const CI_LOOP_MIN_FIX_ATTEMPTS = 3;
/** Error-trace slugs that point at the platform, not the agent. */
export const SEVERE_ERROR_PATTERNS: readonly string[] = ['oom_killed', 'bwrap_namespace_denied', 'sandbox_mount_gap'];
/** Occurrences of a severe slug within one session that count as recurring. */
export const SEVERE_ERROR_MIN_COUNT = 2;

// ── Hard triggers ───────────────────────────────────────────────────────────

/**
 * Which hard triggers the facts fire, in `HARD_TRIGGERS` order. Pure and
 * deterministic. "An explicit human correction tied to this work" is in the
 * spec's list but Stage A carries no fact for it yet, so it cannot fire here.
 */
export function evaluateHardTriggers(facts: StageAFacts): HardTrigger[] {
  const o = facts.outcome;
  const review = o.review;
  const fired = new Set<HardTrigger>();

  if (review?.escalated) fired.add('reviewer_escalated');

  if ((review && review.requestChangesCount >= REVIEW_LOOP_MIN_REQUEST_CHANGES)
    || (o.ciFixAttempts !== null && o.ciFixAttempts >= CI_LOOP_MIN_FIX_ATTEMPTS)) {
    fired.add('review_fix_loop');
  }

  if (o.outputGateRefused && (o.prCreated || o.dirtyWorktree)) fired.add('output_contract_after_work');

  if (o.merged && (
    o.prAbandoned
    || o.taskStatus === 'failed'
    || review?.latestVerdict === 'request-changes'
    || review?.latestVerdict === 'escalate'
  )) {
    fired.add('contradictory_pr_state');
  }

  if (facts.errors?.patterns.some(p => SEVERE_ERROR_PATTERNS.includes(p.pattern) && p.count >= SEVERE_ERROR_MIN_COUNT)) {
    fired.add('severe_error_recurring');
  }

  if (o.workerStatus === 'completed' && o.taskStatus === 'completed'
    && o.outputRequirement === 'pr_required' && !o.prCreated) {
    fired.add('success_without_evidence');
  }

  return HARD_TRIGGERS.filter(t => fired.has(t));
}

// ── Features ────────────────────────────────────────────────────────────────

/** The kind's features for one run: small derived booleans and counters. */
export function buildTriageFeatures(facts: StageAFacts, hardTriggers: readonly HardTrigger[] = evaluateHardTriggers(facts)): PostSessionTriageFeatures {
  const o = facts.outcome;
  return {
    sessionFailed: o.workerStatus !== 'completed',
    retried: o.retried,
    prShipped: o.prCreated,
    merged: o.merged,
    reviewRounds: o.review ? o.review.rounds : null,
    requestChanges: o.review ? o.review.requestChangesCount : null,
    ciFixAttempts: o.ciFixAttempts,
    errorTotal: facts.errors ? facts.errors.total : null,
    transcriptPresent: facts.trace.transcript === 'present',
    unreadSources: facts.unavailable.length,
    hardTriggers,
  };
}

// ── Reading the answer ──────────────────────────────────────────────────────

type Provenance = NonNullable<PostSessionTriageRecord['provenance']>;

/** The record for a decision that could not be obtained. Fail open. */
export function unavailableTriage(error: string, extra: Provenance = {}): PostSessionTriageRecord {
  return {
    status: 'unavailable',
    decision: null,
    focus: null,
    reasonCode: TRIAGE_UNAVAILABLE,
    confidence: null,
    provenance: { error: error.slice(0, 64), ...extra },
  };
}

/**
 * The triage record for a kind response.
 *  - `model`: the applied answer, its focus and confidence (`ok`).
 *  - `rule`: a hard trigger decided; no model was asked (`rule`).
 *  - `fallback`: nothing was applied (`unavailable`). A model that answered
 *    below the threshold is `unavailable` too: its answer was not used, and
 *    the cause is in the provenance.
 */
export function triageRecordFromResponse(response: DecisionResponse<string, PostSessionTriageDecision>): PostSessionTriageRecord {
  const provenance: Provenance = {
    policyVersion: response.policyVersion,
    model: response.model,
    latencyMs: response.latencyMs,
    attempts: response.attempts.length,
    source: response.source,
    mode: response.mode,
    fallbackCause: response.fallbackCause,
  };
  if (response.source === 'model') {
    return { status: 'ok', decision: response.decision, focus: triageFocusOf(response), reasonCode: response.reasonCode, confidence: response.confidence, provenance };
  }
  if (response.source === 'rule') {
    return { status: 'rule', decision: response.decision, focus: null, reasonCode: response.reasonCode, confidence: null, provenance };
  }
  return { status: 'unavailable', decision: null, focus: null, reasonCode: response.reasonCode, confidence: null, provenance };
}

// ── Final routing ───────────────────────────────────────────────────────────

/** Which rule produced the final decision. */
export type TriageRule = 'hard_trigger' | 'triage' | 'fail_open_skip';

export interface TriageOutcome {
  triage: PostSessionTriageRecord;
  hardTriggered: boolean;
  hardTriggerReasons: HardTrigger[];
  finalDecision: TriageDecision;
  rule: TriageRule;
}

/**
 * The response already folds the policy in: hard trigger, then the model at or
 * above the kind's threshold, then fail-open skip. This only names the rule.
 */
export function resolveTriageOutcome(triage: PostSessionTriageRecord, finalDecision: TriageDecision, hardTriggers: HardTrigger[]): TriageOutcome {
  const rule: TriageRule = triage.status === 'ok' ? 'triage' : finalDecision === 'analyse' ? 'hard_trigger' : 'fail_open_skip';
  return {
    triage: { ...triage, provenance: { ...triage.provenance, rule } },
    hardTriggered: hardTriggers.length > 0,
    hardTriggerReasons: [...hardTriggers],
    finalDecision,
    rule,
  };
}
