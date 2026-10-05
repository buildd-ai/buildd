/**
 * Post-session quality loop — Stage B triage, the pure half (artifact
 * `post-session-quality-loop-spec` §6).
 *
 * A collected run's Stage A facts go to the team's decision model, which
 * answers three fixed-label questions: `decision` (skip | analyse), `focus`
 * and a `reasonCode`. The `decision` answer's confidence is the record's
 * confidence. Alongside it, a short list of mechanical **hard triggers** reads
 * the same facts; any one forces `analyse` whatever the model said. The model
 * is for the ambiguous middle, never for vetoing an obvious incident.
 *
 * Rules this module keeps:
 *  - **Only bounded facts go out.** The state is Stage A outcome/behaviour/
 *    context enums and counters plus a few derived signals — no ids, no PR
 *    number, no free text (Stage A carries none to begin with).
 *  - **Fail open.** A timeout, missing key, disabled capability or malformed
 *    answer is recorded as `triage_unavailable`; the run is then skipped unless
 *    a hard trigger fires. Nothing waits on triage.
 *  - **Unknown is not zero.** A source Stage A could not read is null, and a
 *    null never fires a trigger.
 *  - **No provider logic.** The call goes through `decisionCall`, which uses
 *    whatever decision model the team has configured; this module only names
 *    the questions.
 *
 * The DB-backed half is `apps/web/src/lib/post-session-triage.ts`.
 */

import { createHash } from 'node:crypto';
import type { ChoiceQuestion, DecisionAnswers } from '@builddai/ai-kit/decide';
import {
  TRIAGE_DECISIONS,
  TRIAGE_FOCUSES,
  type PostSessionTriageRecord,
  type StageAFacts,
  type TriageDecision,
  type TriageFocus,
} from './post-session-quality';

/** The `inference-policy.ts` capability (and `ai_usage` kind) for this call. */
export const POST_SESSION_TRIAGE_CAPABILITY = 'post_session_triage' as const;

/** Bump when a question, a definition or the state shape changes. Pinned by a test. */
export const POST_SESSION_TRIAGE_PROMPT_VERSION = 'pst1';

/** Whole-call deadline. Background work, but a sweep handles many runs in sequence. */
export const POST_SESSION_TRIAGE_TIMEOUT_MS = 5_000;

// ── Vocabularies ────────────────────────────────────────────────────────────

/**
 * Why the model routed the run as it did. Small and stable: readouts group on
 * it. No catch-all label — "nothing fits" should show up as low confidence.
 */
export const TRIAGE_REASON_CODES = [
  'routine_success',
  'expected_failure',
  'unexplained_failure',
  'retry_loop',
  'review_friction',
  'ci_friction',
  'retrieval_gap',
  'runtime_error',
  'cost_outlier',
  'evidence_mismatch',
  'insufficient_evidence',
] as const;
export type TriageReasonCode = (typeof TRIAGE_REASON_CODES)[number];

/** The reasonCode recorded when the decision could not be obtained. Never a model label. */
export const TRIAGE_UNAVAILABLE = 'triage_unavailable' as const;

/** §6 hard triggers. Deliberately short and mechanical. */
export const HARD_TRIGGERS = [
  'reviewer_escalated',
  'review_fix_loop',
  'output_contract_after_work',
  'contradictory_pr_state',
  'severe_error_recurring',
  'success_without_evidence',
] as const;
export type HardTrigger = (typeof HARD_TRIGGERS)[number];

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

// ── Decision state ──────────────────────────────────────────────────────────

/** Small derived booleans/counters, so the model does not have to compute them. */
export interface TriageSignals {
  sessionFailed: boolean;
  retried: boolean | null;
  prShipped: boolean;
  merged: boolean;
  reviewRounds: number | null;
  requestChanges: number | null;
  ciFixAttempts: number | null;
  recallCalls: number | null;
  learnCalls: number | null;
  cbmCalls: number | null;
  errorTotal: number | null;
  transcriptPresent: boolean;
  unreadSources: number;
}

export function deriveTriageSignals(facts: StageAFacts): TriageSignals {
  const o = facts.outcome;
  const tools = facts.behaviour.tools;
  return {
    sessionFailed: o.workerStatus !== 'completed',
    retried: o.retried,
    prShipped: o.prCreated,
    merged: o.merged,
    reviewRounds: o.review ? o.review.rounds : null,
    requestChanges: o.review ? o.review.requestChangesCount : null,
    ciFixAttempts: o.ciFixAttempts,
    recallCalls: tools.known ? tools.recall : null,
    learnCalls: tools.known ? tools.learn : null,
    cbmCalls: tools.known ? tools.cbm : null,
    errorTotal: facts.errors ? facts.errors.total : null,
    transcriptPresent: facts.trace.transcript === 'present',
    unreadSources: facts.unavailable.length,
  };
}

/** Top tools sent to the model; the full list stays on the run row. */
const STATE_TOP_TOOLS = 8;

/**
 * The record the model reads. Facts minus every identifier (task, worker,
 * workspace, mission, parent, PR number): they carry no signal for routing and
 * are row identifiers in production tables.
 */
export function buildTriageState(facts: StageAFacts): Record<string, unknown> {
  const { prNumber: _pr, ...outcome } = facts.outcome;
  const {
    taskId: _t, workerId: _w, workspaceId: _ws, missionId, parentTaskId, ...context
  } = facts.context;
  return {
    signals: deriveTriageSignals(facts),
    outcome,
    behaviour: {
      ...facts.behaviour,
      tools: { ...facts.behaviour.tools, top: facts.behaviour.tools.top.slice(0, STATE_TOP_TOOLS) },
    },
    context: { ...context, inMission: missionId !== null, isFollowUp: parentTaskId !== null },
    knowledge: facts.knowledge,
    trace: facts.trace,
    errors: facts.errors,
    unavailable: facts.unavailable,
  };
}

// ── Questions ───────────────────────────────────────────────────────────────

const RULE = 'Judge only from the facts. A null value means that source could not be read: it is unknown, not zero or absent. `signals` restates a few facts as counters.';

export const POST_SESSION_TRIAGE_QUESTIONS = {
  decision: {
    type: 'choice',
    instructions: {
      question: 'An AI coding agent just finished one working session on a task. A deeper read-only analysis of the session costs real money. Would that analysis likely teach something about the platform, its knowledge retrieval, orchestration or environment?',
      rule: RULE,
    },
    criteria: {
      skip: 'Routine: the session did what was asked (or ended for a plain, self-explaining reason such as cancellation or budget), with ordinary review and CI, ordinary tool use and no unexplained errors. Not for a session with repeated retries, review or CI loops, errors, or outcomes that disagree with each other.',
      analyse: 'Something unusual worth a closer look: an unexplained failure, repeated attempts, review or CI friction, errors from the environment, unusual cost for the outcome, knowledge tools unused on work that needed them, or outcome facts that contradict each other. Not for a clean session that merely ran long.',
    },
  } satisfies ChoiceQuestion<TriageDecision>,
  focus: {
    type: 'choice',
    instructions: {
      question: 'If this session were analysed, which area should the analysis look at first?',
      rule: RULE,
    },
    criteria: {
      general: 'No single area stands out, or the session looks routine.',
      retrieval: 'Knowledge lookup: recall/search calls absent, few, or unproductive where prior knowledge should have helped; code or docs corpora unavailable.',
      knowledge: 'The knowledge itself: the agent saved or relied on knowledge that may be wrong or stale, or saved none after hitting a non-obvious problem.',
      orchestration: 'Task routing and lifecycle: retries, superseded or abandoned PRs, output requirements refused, follow-up tasks, sessions that ended without completing.',
      review_merge: 'Reviewer and merge flow: request-changes or escalation, CI fix rounds, merge state that disagrees with the review.',
      runtime: 'The runner and environment: error traces, permission denials, sandbox or memory failures, timeouts.',
    } satisfies Record<TriageFocus, string>,
  } satisfies ChoiceQuestion<TriageFocus>,
  reasonCode: {
    type: 'choice',
    instructions: {
      question: 'Which one reason best explains the routing decision for this session?',
      rule: RULE,
    },
    criteria: {
      routine_success: 'Completed and shipped as required with ordinary review, CI and tool use.',
      expected_failure: 'Ended without success for a reason that explains itself: cancelled, superseded, out of budget or provider limits. Not for an unexplained error.',
      unexplained_failure: 'Failed or aborted and the facts do not say why.',
      retry_loop: 'The task needed more than one attempt.',
      review_friction: 'Reviewer asked for changes more than once, escalated, or review rounds failed.',
      ci_friction: 'CI failed or needed fix rounds.',
      retrieval_gap: 'Knowledge tools were unused or corpora unavailable on work that needed prior context.',
      runtime_error: 'Error traces or permission denials point at the environment.',
      cost_outlier: 'Turns, tokens or cost are far out of line with what was delivered.',
      evidence_mismatch: 'Outcome facts disagree: success claimed without a PR, merged despite rejection, and similar.',
      insufficient_evidence: 'Too many sources are unknown to judge the session.',
    } satisfies Record<TriageReasonCode, string>,
  } satisfies ChoiceQuestion<TriageReasonCode>,
};

export type PostSessionTriageQuestions = typeof POST_SESSION_TRIAGE_QUESTIONS;

/** Hash of the prompt, pinned by a test to POST_SESSION_TRIAGE_PROMPT_VERSION. */
export function postSessionTriagePromptHash(): string {
  return createHash('sha256').update(JSON.stringify(POST_SESSION_TRIAGE_QUESTIONS)).digest('hex').slice(0, 12);
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
    provenance: { promptVersion: POST_SESSION_TRIAGE_PROMPT_VERSION, error: error.slice(0, 64), ...extra },
  };
}

function inSet<T extends string>(set: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (set as readonly string[]).includes(v);
}

/**
 * Validate the three answers. Anything off-vocabulary or a non-finite
 * confidence is malformed and recorded as unavailable — the transport already
 * validates, this is the last line before a value is persisted.
 */
export function readTriageAnswers(
  answers: Partial<DecisionAnswers<PostSessionTriageQuestions>> | null | undefined,
  meta: { model: string | null; latencyMs: number; attempts: number },
): PostSessionTriageRecord {
  const extra: Provenance = { model: meta.model, latencyMs: meta.latencyMs, attempts: meta.attempts };
  const d = answers?.decision;
  const f = answers?.focus;
  const r = answers?.reasonCode;
  const confidence = d?.confidence;
  if (!inSet(TRIAGE_DECISIONS, d?.choice) || !inSet(TRIAGE_FOCUSES, f?.choice) || !inSet(TRIAGE_REASON_CODES, r?.choice)
    || typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return unavailableTriage('malformed', extra);
  }
  return {
    status: 'ok',
    decision: d!.choice,
    focus: f!.choice,
    reasonCode: r!.choice,
    confidence,
    provenance: {
      promptVersion: POST_SESSION_TRIAGE_PROMPT_VERSION,
      ...extra,
      focusConfidence: typeof f!.confidence === 'number' ? f!.confidence : null,
      reasonConfidence: typeof r!.confidence === 'number' ? r!.confidence : null,
    },
  };
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

/** Hard triggers first, then the model, then fail-open skip. Pure. */
export function resolveTriageOutcome(triage: PostSessionTriageRecord, hardTriggers: HardTrigger[]): TriageOutcome {
  const hardTriggered = hardTriggers.length > 0;
  let finalDecision: TriageDecision;
  let rule: TriageRule;
  if (hardTriggered) {
    finalDecision = 'analyse';
    rule = 'hard_trigger';
  } else if (triage.status === 'ok' && triage.decision) {
    finalDecision = triage.decision;
    rule = 'triage';
  } else {
    finalDecision = 'skip';
    rule = 'fail_open_skip';
  }
  return {
    triage: { ...triage, provenance: { ...triage.provenance, rule } },
    hardTriggered,
    hardTriggerReasons: [...hardTriggers],
    finalDecision,
    rule,
  };
}
