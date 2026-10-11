/**
 * Merge readiness: the decision behind a review card's "Assess"
 * (`buildd.merge_readiness`). Can this PR merge as-is?
 *
 * - **Rules first.** A blocking state (a refresh or mission guard first, a
 *   draft, a conflict, CI running, being fixed or failing, a review in flight
 *   or asking for changes) is the kind's override and no model is asked. The
 *   "looks mergeable as-is" rule (`mergeableAsIsByRule`) is the answer in
 *   effect whenever it holds, but the model is still asked so its answer keeps
 *   being recorded.
 * - **One question to the model.** "Safe to merge as-is?" as a yes/no over a
 *   short prose state. The model is the team's decision model (Jev by default,
 *   or any chat model behind `resolveDecisionAccess`), never named here. In an
 *   offline backtest of past review cards a four-label question only repeated
 *   the reviewer's verdict, and no model beat the facts, so the binding runs in
 *   `shadow`: the model's probability is recorded on every ask
 *   (`decision_records.confidence`, with the model that answered), while the
 *   decision in effect is always the rule's fallback. The card shows the
 *   model's yes only at `MODEL_SHOW_MIN_P` or above, and the model may only
 *   say yes when the facts back it.
 * - **Advisory only.** Nothing here merges, changes a review or feeds a gate
 *   (`evaluateAutoMergeSafety` included). Making it a gate needs a held-out
 *   eval of the ledger rows against outcome gold (merged, reverted) first.
 * - **Facts, not content** (`MergeAdviceFacts`): enums and booleans the server
 *   derived when it built the card. Never a diff, a title or reviewer prose.
 */
import { noul } from '@builddai/ai-kit/decide';
import type { DecisionKindConfig, DecisionRequest, DecisionResponse, ModelVerdict, DecisionVerdict } from '@builddai/ai-kit/decide';
import { defineBuilddDecisionKind, type BuilddDecisionKindBinding } from '@buildd/core/decision-kinds';
import { runBuilddDecision, type BuilddDecisionScope } from '@buildd/core/decision-policy';
import {
  MERGEABLE_AS_IS_REASON,
  MERGE_READINESS_DECISIONS,
  MERGE_READINESS_KIND,
  MERGE_READINESS_SUBJECT_TYPE,
  NO_CALL_REASON,
  blockingRuleAnswer,
  mergeAdviceLine,
  mergeAdviceSubjectId,
  mergeableAsIsByRule,
  parseMergeAdviceFacts,
  type MergeAdviceFacts,
  type MergeAdviceView,
  type MergeReadinessDecision,
} from './merge-advice';
import {
  adviceViewFromRow,
  findStoredAnswer,
  mergeAdviceDigest,
  type MergeAdviceTokenPayload,
} from './merge-advice-server';

export const MERGE_READINESS_CAPABILITY = 'merge_readiness' as const;

/** The kind's override: only the blocking states. "Mergeable as-is" still asks the model (see the file header). */
export function mergeReadinessOverride(f: MergeAdviceFacts): DecisionVerdict<MergeReadinessDecision> | null {
  return blockingRuleAnswer(f);
}

/** The decision in effect when no model answer is applied, which in shadow is every ask: the rule, else a person. */
export function mergeReadinessFallback(f: MergeAdviceFacts | null, cause: string): DecisionVerdict<MergeReadinessDecision> {
  if (f && mergeableAsIsByRule(f)) return { decision: 'merge_now', reasonCode: MERGEABLE_AS_IS_REASON };
  return { decision: 'needs_human', reasonCode: cause === 'shadow' ? NO_CALL_REASON : `fallback_${cause}` };
}

const questions = {
  safe: noul(
    'A pull request is waiting on a person. The state says why a person was asked, its CI, its automated review and '
      + 'its size. Is it safe to merge exactly as it is, with no further change?',
    {
      true: 'Yes: nothing in the state needs more than a routine look before merging.',
      false: 'No, or unsure: something in the state needs a change or a person\'s judgement.',
    },
  ),
};

const CAUSE_TEXT: Record<MergeAdviceFacts['escalationCause'], string> = {
  policy: 'A person was asked only because the merge policy requires one for the files it touches.',
  reviewer: 'The automated reviewer asked for a person.',
  none: 'Nobody escalated it.',
};

/** The model's view of the facts, as a few short sentences. Prose read better than key=value in the backtest. */
export function mergeReadinessState(f: MergeAdviceFacts): string {
  const blockers = f.blockers.length ? ` The review raised: ${f.blockers.join(', ').replace(/_/g, ' ')}.` : '';
  return [
    CAUSE_TEXT[f.escalationCause],
    `CI is ${f.ci}.`,
    `The review is ${f.review.replace(/_/g, ' ')} with ${f.reviewConfidence} confidence, and it ${f.reviewCoversHead ? 'covers' : 'does not cover'} the current commit.${blockers}`,
    `The change is ${f.diffSize === 'unknown' ? 'of unknown size' : f.diffSize}.`,
    f.githubApprovalRequired ? 'GitHub still requires an approval.' : '',
  ].filter(Boolean).join(' ');
}

/**
 * Probability → verdict. The model may only say yes when the facts back it
 * (green CI, a review of this commit that is not asking for changes);
 * otherwise its yes is recorded as `needs_human`. The confidence is always the
 * raw probability, so the ledger keeps what the model said.
 */
export function interpretMergeReadiness(
  answers: { safe: { noul: number } },
  f: MergeAdviceFacts,
): ModelVerdict<MergeReadinessDecision> {
  const p = answers.safe.noul;
  const backed = f.ci === 'green' && f.reviewCoversHead && (f.review === 'approved' || f.review === 'escalated');
  if (!backed) return { decision: 'needs_human', confidence: p, reasonCode: 'model_vetoed_by_facts' };
  return { decision: 'merge_now', confidence: p, reasonCode: 'model_safe_as_is' };
}

export const MERGE_READINESS_CONFIG: DecisionKindConfig<
  typeof MERGE_READINESS_KIND, MergeAdviceFacts, MergeReadinessDecision, typeof questions
> = {
  kind: MERGE_READINESS_KIND,
  policyVersion: 'mready-2026-10-09.a',
  featureSchemaVersion: 'mready-features-v2',
  decisions: MERGE_READINESS_DECISIONS,
  parseFeatures: parseMergeAdviceFacts,
  override: mergeReadinessOverride,
  questions,
  state: mergeReadinessState,
  interpret: (a, f) => interpretMergeReadiness(a, f),
  // Shadow: nothing is applied from the model, so the threshold only keeps
  // every answer `decided` in the record. What the card shows is gated by
  // `MODEL_SHOW_MIN_P`, not by this.
  minConfidence: 0,
  fallback: (f, cause) => mergeReadinessFallback(f, cause),
};

/** Shadow until measured: ask and record, apply the rule. No escalation or challenger. */
export const MERGE_READINESS_BINDING: BuilddDecisionKindBinding = {
  capability: MERGE_READINESS_CAPABILITY,
  mode: 'shadow',
};

export const mergeReadinessKind = defineBuilddDecisionKind(MERGE_READINESS_CONFIG, MERGE_READINESS_BINDING);

// ── The on-demand ask ───────────────────────────────────────────────────────

export type MergeReadinessAskResult =
  | { kind: 'answer'; advice: MergeAdviceView; reused: boolean }
  | { kind: 'unavailable'; reason: string };

export interface MergeReadinessAskDeps {
  findStored?: typeof findStoredAnswer;
  run?: (request: DecisionRequest<MergeAdviceFacts>, scope: BuilddDecisionScope) => Promise<DecisionResponse<string, MergeReadinessDecision>>;
  now?: () => number;
}

/** Concurrent taps on one (subject, facts) share one call. Per server instance. */
const inFlight = new Map<string, Promise<MergeReadinessAskResult>>();

function unavailableReason(cause: string | null): string | null {
  if (cause === 'disabled') return 'Merge readiness is off for this team. Turn it on in Settings → AI.';
  if (cause === 'no_provider') return 'This team has no decision-model key.';
  return null;
}

/** The card's view of a fresh response: the rule's code, and the model's probability when one answered. */
export function adviceViewFromResponse(
  response: DecisionResponse<string, MergeReadinessDecision>,
  facts: MergeAdviceFacts,
  at: string,
): MergeAdviceView {
  const answered = [...response.attempts].reverse().find(a => a.decision !== null) ?? null;
  const probability = answered?.decision === 'merge_now' ? answered.confidence : null;
  return {
    decision: response.decision,
    source: response.source,
    reasonCode: response.reasonCode,
    line: mergeAdviceLine({ reasonCode: response.reasonCode, probability, facts }),
    recorded: true,
    model: answered?.modelVersion ?? answered?.model ?? null,
    at,
    stale: null,
  };
}

/**
 * Answer "can this PR merge as-is?" for facts the server signed. Spends at
 * most once per (PR head, facts): a stored answer for the same subject and
 * digest is returned as-is, and so is a call already running for them.
 */
export function askMergeReadiness(
  input: {
    payload: Pick<MergeAdviceTokenPayload, 'workspaceId' | 'prNumber' | 'headSha' | 'taskId' | 'facts'>;
    teamId: string;
    userId: string;
  },
  deps: MergeReadinessAskDeps = {},
): Promise<MergeReadinessAskResult> {
  const { payload } = input;
  const subjectId = mergeAdviceSubjectId(payload.workspaceId, payload.prNumber, payload.headSha);
  const digest = mergeAdviceDigest(payload.facts);
  const key = `${subjectId}|${digest}`;
  const running = inFlight.get(key);
  if (running) return running;
  const current = { headSha: payload.headSha, facts: payload.facts };
  const job = (async (): Promise<MergeReadinessAskResult> => {
    const stored = await (deps.findStored ?? findStoredAnswer)(payload.workspaceId, subjectId, digest).catch(() => null);
    const storedView = stored ? adviceViewFromRow(stored, current) : null;
    if (storedView) return { kind: 'answer', advice: storedView, reused: true };

    const scope: BuilddDecisionScope = { teamId: input.teamId, workspaceId: payload.workspaceId, taskId: payload.taskId, userId: input.userId };
    const request: DecisionRequest<MergeAdviceFacts> = {
      features: payload.facts,
      subjectRef: { type: MERGE_READINESS_SUBJECT_TYPE, id: subjectId },
    };
    const run = deps.run ?? ((r: DecisionRequest<MergeAdviceFacts>, s: BuilddDecisionScope) => runBuilddDecision(mergeReadinessKind, r, s));
    const response = await run(request, scope);
    // No model to ask: the rule still answers when it holds; otherwise say why.
    const off = response.source === 'fallback' && response.reasonCode !== MERGEABLE_AS_IS_REASON
      ? unavailableReason(response.fallbackCause)
      : null;
    if (off) return { kind: 'unavailable', reason: off };
    const at = new Date(deps.now?.() ?? Date.now()).toISOString();
    return { kind: 'answer', reused: false, advice: adviceViewFromResponse(response, payload.facts, at) };
  })();
  inFlight.set(key, job);
  return job.finally(() => inFlight.delete(key));
}
