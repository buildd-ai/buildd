/**
 * Merge readiness: the Jev decision behind a review card's "Ask Jev"
 * (`buildd.merge_readiness`). Can this PR merge now?
 *
 * - **Advisory only.** The answer is shown on the card and recorded in the
 *   decision ledger, nothing else. It never merges, never changes a review,
 *   never feeds `evaluateAutoMergeSafety` or any gate. Making it a gate needs a
 *   held-out eval of the ledger rows against outcome gold (merged, reverted)
 *   first; until then `mode: 'live'` only means the card may show it.
 * - **Rules veto, Jev only tightens.** Anything the facts already settle
 *   (a refresh or mission guard first, a draft, a conflict, CI running, being
 *   fixed or failing, a review in flight or asking for changes) is a rule
 *   answer and no model is asked. Jev judges only what is left, and a
 *   `merge_now` it gives without green CI and a review of this commit is
 *   turned into `needs_human`.
 * - **Facts, not content** (`MergeAdviceFacts`): enums and booleans the server
 *   derived when it built the card. Never a diff, a title or reviewer prose.
 * - **Fallback is `needs_human`**: today's behaviour, a person decides.
 */
import { choice } from '@builddai/ai-kit/decide';
import type { DecisionKindConfig, DecisionRequest, DecisionResponse, ModelVerdict, DecisionVerdict } from '@builddai/ai-kit/decide';
import { defineBuilddDecisionKind, type BuilddDecisionKindBinding } from '@buildd/core/decision-kinds';
import { runBuilddDecision, type BuilddDecisionScope } from '@buildd/core/decision-policy';
import {
  MERGE_READINESS_DECISIONS,
  MERGE_READINESS_KIND,
  MERGE_READINESS_SUBJECT_TYPE,
  mergeAdviceLine,
  mergeAdviceSubjectId,
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

/**
 * PROVISIONAL: a new kind with no held-out eval. A wrong `merge_now` invites a
 * bad merge; a wrong `needs_human` costs a look the person was going to take
 * anyway, so the bar is high. Recalibrate from the ledger before lowering it.
 */
export const MERGE_READINESS_MIN_CONFIDENCE = 0.85;

/** The deterministic answers. Each names the fact that settled it, for the card's sentence. */
export function mergeReadinessOverride(f: MergeAdviceFacts): DecisionVerdict<MergeReadinessDecision> | null {
  if (f.refreshFirst) return { decision: 'wait', reasonCode: 'rule_refresh_first' };
  if (f.missionBlocked) return { decision: 'wait', reasonCode: 'rule_mission_blocked' };
  if (f.draft) return { decision: 'wait', reasonCode: 'rule_draft' };
  if (f.ci === 'conflict') return { decision: 'wait', reasonCode: 'rule_conflict' };
  if (f.ci === 'running') return { decision: 'wait', reasonCode: 'rule_ci_running' };
  if (f.ci === 'fixing') return { decision: 'wait', reasonCode: 'rule_ci_fixing' };
  if (f.review === 'in_flight') return { decision: 'wait', reasonCode: 'rule_review_in_flight' };
  if (f.ci === 'failing') return { decision: 'needs_human', reasonCode: 'rule_ci_failing' };
  if (f.review === 'changes_requested') return { decision: 'request_changes', reasonCode: 'rule_changes_requested' };
  return null;
}

const questions = {
  ready: choice(
    {
      question: 'A pull request is waiting on a person. The state describes its CI, its automated review, the reasons the '
        + 'review gave for wanting a person, and the merge policy. Can a person merge it now with confidence?',
      rule: 'blockers are the kinds of concern the review raised. security, correctness, migration and scope are reasons '
        + 'for a person to look. A review that does not cover the current commit is weaker evidence. When unsure, say a person should decide.',
    },
    {
      merge_now: 'Merge now: CI is green, the review covers this commit, and nothing it raised needs more than a routine look.',
      needs_human: 'A person should decide: the review raised something that needs judgement, or the evidence is thin.',
      request_changes: 'Send it back: what the review raised needs a code change before it can merge.',
    },
  ),
};

/** Jev may only tighten: a merge_now the facts cannot back becomes needs_human. */
export function interpretMergeReadiness(
  answers: { ready: { choice: 'merge_now' | 'needs_human' | 'request_changes'; confidence: number } },
  f: MergeAdviceFacts,
): ModelVerdict<MergeReadinessDecision> {
  const { choice: pick, confidence } = answers.ready;
  const backed = f.ci === 'green' && f.reviewCoversHead && (f.review === 'approved' || f.review === 'escalated');
  if (pick === 'merge_now' && !backed) {
    return { decision: 'needs_human', confidence, reasonCode: 'model_merge_now_vetoed' };
  }
  return { decision: pick, confidence, reasonCode: `model_${pick}` };
}

export const MERGE_READINESS_CONFIG: DecisionKindConfig<
  typeof MERGE_READINESS_KIND, MergeAdviceFacts, MergeReadinessDecision, typeof questions
> = {
  kind: MERGE_READINESS_KIND,
  policyVersion: 'mready-2026-10-08.a',
  featureSchemaVersion: 'mready-features-v1',
  decisions: MERGE_READINESS_DECISIONS,
  parseFeatures: parseMergeAdviceFacts,
  override: mergeReadinessOverride,
  questions,
  state: f => ({
    pullRequest: {
      ci: f.ci,
      review: f.review,
      reviewConfidence: f.reviewConfidence,
      reviewCoversCurrentCommit: f.reviewCoversHead,
      blockers: f.blockers,
      mergePolicy: f.policyTier,
      githubApprovalStillRequired: f.githubApprovalRequired,
    },
  }),
  interpret: (a, f) => interpretMergeReadiness(a, f),
  minConfidence: MERGE_READINESS_MIN_CONFIDENCE,
  fallback: (_f, cause) => ({ decision: 'needs_human', reasonCode: `fallback_${cause}` }),
};

/** No escalation or challenger until the kind is measured. */
export const MERGE_READINESS_BINDING: BuilddDecisionKindBinding = {
  capability: MERGE_READINESS_CAPABILITY,
  mode: 'live',
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

/**
 * Answer "can this PR merge now?" for facts the server signed. Spends at most
 * once per (PR head, facts): a stored answer for the same subject and digest is
 * returned as-is, and so is a call already running for them.
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
    const off = response.source === 'fallback' ? unavailableReason(response.fallbackCause) : null;
    if (off) return { kind: 'unavailable', reason: off };
    const decision = response.decision as MergeReadinessDecision;
    return {
      kind: 'answer',
      reused: false,
      advice: {
        decision,
        source: response.source,
        line: mergeAdviceLine(decision, response.source, response.reasonCode, payload.facts),
        at: new Date(deps.now?.() ?? Date.now()).toISOString(),
        stale: null,
      },
    };
  })();
  inFlight.set(key, job);
  return job.finally(() => inFlight.delete(key));
}
