/**
 * "Can this PR merge now?": the facts the merge-readiness decision reads, and
 * the one line a review card shows for its answer. Pure and client-safe.
 *
 * The decision itself is the `buildd.merge_readiness` kind
 * (merge-readiness-decision.ts); this file holds only what core surfaces need
 * to render an answer: the closed fact set, the answer set, the ledger subject
 * format and the sentence.
 *
 * The rule answers first (`mergeableAsIsByRule`, `mergeReadinessOverride`):
 * the facts alone settle most cards. The decision model (the team's, Jev by
 * default) is asked one yes/no question and its answer is always recorded, but
 * shown only when its probability reaches `MODEL_SHOW_MIN_P`. A model returns a
 * probability, never prose, so every sentence here is composed from the facts.
 *
 * Advisory only. Nothing reads an answer to merge, change a review, or feed a
 * gate (`evaluateAutoMergeSafety` included). Gating on it needs a held-out eval
 * against outcome gold (merged / reverted) first.
 */
import { REVIEW_BLOCKER_KINDS, type ReviewBlockerKind } from './attention-line';

export const MERGE_READINESS_KIND = 'buildd.merge_readiness' as const;
export const MERGE_READINESS_SUBJECT_TYPE = 'pr_head' as const;

export const MERGE_READINESS_DECISIONS = ['merge_now', 'wait', 'needs_human', 'request_changes'] as const;
export type MergeReadinessDecision = (typeof MERGE_READINESS_DECISIONS)[number];

export const MERGE_CI_STATES = ['green', 'running', 'fixing', 'failing', 'conflict', 'unknown'] as const;
export type MergeCiState = (typeof MERGE_CI_STATES)[number];

export const MERGE_REVIEW_STATES = ['approved', 'escalated', 'changes_requested', 'in_flight', 'failed', 'none'] as const;
export type MergeReviewState = (typeof MERGE_REVIEW_STATES)[number];

export const MERGE_CONFIDENCE_BUCKETS = ['high', 'medium', 'low', 'none'] as const;
export type MergeConfidenceBucket = (typeof MERGE_CONFIDENCE_BUCKETS)[number];

export const MERGE_POLICY_TIERS = ['auto-threshold', 'agent-review', 'human', 'other'] as const;
export type MergePolicyTier = (typeof MERGE_POLICY_TIERS)[number];

/**
 * Why a person was asked. `policy`: the reviewer approved and the merge policy
 * (a path rule, a human tier) still wants a person, or policy is the only
 * stated reason. `reviewer`: the reviewer's own judgement. `none`: nobody
 * escalated.
 */
export const MERGE_ESCALATION_CAUSES = ['policy', 'reviewer', 'none'] as const;
export type MergeEscalationCause = (typeof MERGE_ESCALATION_CAUSES)[number];

export const MERGE_DIFF_SIZES = ['small', 'medium', 'large', 'xl', 'unknown'] as const;
export type MergeDiffSize = (typeof MERGE_DIFF_SIZES)[number];

/** Lines changed (added + removed) as a size bucket. XL starts at 1000; unreported counts are `unknown`. */
export function diffSizeBucket(linesAdded: number | null | undefined, linesRemoved: number | null | undefined): MergeDiffSize {
  const total = (linesAdded ?? 0) + (linesRemoved ?? 0);
  if (!Number.isFinite(total) || total <= 0) return 'unknown';
  return total < 100 ? 'small' : total < 400 ? 'medium' : total < 1000 ? 'large' : 'xl';
}

/**
 * Show the model's "safe to merge as-is?" only at or above this probability.
 * PROVISIONAL, from an offline backtest of past review cards: below it the
 * model separated nothing the facts did not already, so the card says nothing.
 */
export const MODEL_SHOW_MIN_P = 0.4;

/** Bounded, structured facts only: never a diff, a title or reviewer prose. */
export interface MergeAdviceFacts {
  ci: MergeCiState;
  review: MergeReviewState;
  reviewConfidence: MergeConfidenceBucket;
  /** The latest review verdict was made against the PR's current head. */
  reviewCoversHead: boolean;
  /** Sorted, unique. */
  blockers: ReviewBlockerKind[];
  policyTier: MergePolicyTier;
  /** GitHub still needs a required approval (branch protection, code owners). */
  githubApprovalRequired: boolean;
  draft: boolean;
  /** A mission's branch refresh has to merge before this one. */
  refreshFirst: boolean;
  /** The mission merge guard refuses this PR until other work lands. */
  missionBlocked: boolean;
  escalationCause: MergeEscalationCause;
  diffSize: MergeDiffSize;
}

const oneOf = <T extends string>(set: readonly T[], v: unknown): v is T => (set as readonly unknown[]).includes(v);

/** Validate untrusted input into facts, or say why not. Canonicalises the blocker list so equal facts hash equally. */
export function parseMergeAdviceFacts(input: unknown): { ok: true; features: MergeAdviceFacts } | { ok: false; message: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'facts must be an object' };
  const f = input as Record<string, unknown>;
  if (!oneOf(MERGE_CI_STATES, f.ci)) return { ok: false, message: 'ci must be a known CI state' };
  if (!oneOf(MERGE_REVIEW_STATES, f.review)) return { ok: false, message: 'review must be a known review state' };
  if (!oneOf(MERGE_CONFIDENCE_BUCKETS, f.reviewConfidence)) return { ok: false, message: 'reviewConfidence must be a bucket' };
  if (!oneOf(MERGE_POLICY_TIERS, f.policyTier)) return { ok: false, message: 'policyTier must be a known tier' };
  if (!oneOf(MERGE_ESCALATION_CAUSES, f.escalationCause)) return { ok: false, message: 'escalationCause must be a known cause' };
  if (!oneOf(MERGE_DIFF_SIZES, f.diffSize)) return { ok: false, message: 'diffSize must be a size bucket' };
  if (!Array.isArray(f.blockers) || f.blockers.length > REVIEW_BLOCKER_KINDS.length || !f.blockers.every(b => oneOf(REVIEW_BLOCKER_KINDS, b))) {
    return { ok: false, message: 'blockers must be known blocker kinds' };
  }
  for (const k of ['reviewCoversHead', 'githubApprovalRequired', 'draft', 'refreshFirst', 'missionBlocked'] as const) {
    if (typeof f[k] !== 'boolean') return { ok: false, message: `${k} must be a boolean` };
  }
  const blockers = REVIEW_BLOCKER_KINDS.filter(k => (f.blockers as unknown[]).includes(k));
  return {
    ok: true,
    features: {
      ci: f.ci,
      review: f.review,
      reviewConfidence: f.reviewConfidence,
      reviewCoversHead: f.reviewCoversHead as boolean,
      blockers,
      policyTier: f.policyTier,
      githubApprovalRequired: f.githubApprovalRequired as boolean,
      draft: f.draft as boolean,
      refreshFirst: f.refreshFirst as boolean,
      missionBlocked: f.missionBlocked as boolean,
      escalationCause: f.escalationCause,
      diffSize: f.diffSize,
    },
  };
}

/**
 * The deterministic "looks mergeable as-is": a person was asked only because of
 * policy, CI is green, the review covers this commit, and the PR is neither a
 * draft nor XL (an unreported size does not count). In an offline backtest of
 * past review cards this shape merged unchanged about three times in four,
 * more often than any model answer we tried. Advisory: it names a likely
 * outcome; it never merges.
 */
export function mergeableAsIsByRule(f: MergeAdviceFacts): boolean {
  return f.escalationCause === 'policy'
    && f.ci === 'green'
    && f.reviewCoversHead
    && !f.draft
    && f.diffSize !== 'xl'
    && f.diffSize !== 'unknown'
    && !f.refreshFirst
    && !f.missionBlocked;
}

/** A reviewer confidence as a bucket: the model compares labels, code does the arithmetic. */
export function confidenceBucket(confidence: number | null | undefined): MergeConfidenceBucket {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return 'none';
  return confidence >= 0.8 ? 'high' : confidence >= 0.5 ? 'medium' : 'low';
}

/** CI as the decision sees it, from the persisted lifecycle and the card's CI gate. A conflict outranks CI. */
export function mergeCiState(input: {
  prLifecycleStatus?: string | null;
  ciGateKind?: 'fixing' | 'running' | 'blocked' | null;
  mergeConflict?: boolean | null;
}): MergeCiState {
  if (input.mergeConflict || input.prLifecycleStatus === 'conflict') return 'conflict';
  if (input.ciGateKind === 'fixing') return 'fixing';
  if (input.ciGateKind === 'blocked' || input.prLifecycleStatus === 'ci_failed') return 'failing';
  if (input.ciGateKind === 'running' || input.prLifecycleStatus === 'ci_running' || input.prLifecycleStatus === 'pr_open') return 'running';
  if (input.prLifecycleStatus === 'ci_green') return 'green';
  return 'unknown';
}

export function mergePolicyTier(tier: string | null | undefined): MergePolicyTier {
  return oneOf(MERGE_POLICY_TIERS, tier) ? tier : 'other';
}

/** The ledger subject: one per (workspace, PR, head). A push is a new subject, so an older answer reads as stale. */
export function mergeAdviceSubjectId(workspaceId: string, prNumber: number, headSha: string): string {
  return `${workspaceId}#${prNumber}@${headSha}`;
}

export function parseMergeAdviceSubjectId(id: string): { workspaceId: string; prNumber: number; headSha: string } | null {
  const m = /^([^#@]+)#(\d+)@([^@]+)$/.exec(id);
  if (!m) return null;
  return { workspaceId: m[1]!, prNumber: Number(m[2]), headSha: m[3]! };
}

/** Where an answer came from: a deterministic rule over the facts, the decision model, or the kind's safe fallback. */
export type MergeAdviceSource = 'rule' | 'model' | 'fallback';

/** A rule answer: the decision and the code naming the fact that settled it. */
export interface MergeRuleAnswer {
  decision: MergeReadinessDecision;
  reasonCode: string;
}

/**
 * What the facts settle with no model at all. The kind's override (no model
 * is asked) is every branch except `rule_mergeable_as_is`: that one still asks
 * the model, so its answer keeps being recorded.
 */
export function blockingRuleAnswer(f: MergeAdviceFacts): MergeRuleAnswer | null {
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

export const MERGEABLE_AS_IS_REASON = 'rule_mergeable_as_is';
/** The fallback's code when no rule fires: a person decides, and the card says nothing. */
export const NO_CALL_REASON = 'no_call';

/** The rule's answer, first: a blocking state, else "looks mergeable as-is", else nothing. */
export function ruleAnswer(f: MergeAdviceFacts): MergeRuleAnswer | null {
  return blockingRuleAnswer(f)
    ?? (mergeableAsIsByRule(f) ? { decision: 'merge_now', reasonCode: MERGEABLE_AS_IS_REASON } : null);
}

/** The sentence for a rule answer. Null for a code no rule sets. */
export function ruleLine(reasonCode: string, facts: Pick<MergeAdviceFacts, 'githubApprovalRequired'>): string | null {
  switch (reasonCode) {
    case MERGEABLE_AS_IS_REASON:
      return facts.githubApprovalRequired
        ? 'From the PR state: looks mergeable as-is. Approve it on GitHub.'
        : 'From the PR state: looks mergeable as-is.';
    case 'rule_refresh_first': return 'Wait: the branch refresh has to merge first.';
    case 'rule_mission_blocked': return 'Wait: the mission\'s other work has to land first.';
    case 'rule_draft': return 'Wait: the PR is still a draft.';
    case 'rule_conflict': return 'Wait: the branch has a merge conflict to resolve.';
    case 'rule_ci_running': return 'Wait: CI is still running.';
    case 'rule_ci_fixing': return 'Wait: an agent is fixing CI.';
    case 'rule_review_in_flight': return 'Wait: a review is still running on this commit.';
    case 'rule_ci_failing': return 'Needs you: CI is failing and no fix is running.';
    case 'rule_changes_requested': return 'Send it back: the reviewer asked for changes.';
    default: return null;
  }
}

/**
 * The one line for an answer, or null when there is nothing worth saying. A
 * rule answer wins. Otherwise the model's yes/no shows only at
 * `MODEL_SHOW_MIN_P` or above; below it the card says nothing.
 */
export function mergeAdviceLine(input: {
  reasonCode: string;
  /** The model's probability that the PR is safe to merge as-is; null when no model answered. */
  probability: number | null;
  facts: Pick<MergeAdviceFacts, 'githubApprovalRequired'>;
}): string | null {
  const rule = ruleLine(input.reasonCode, input.facts);
  if (rule) return rule;
  if (input.probability != null && input.probability >= MODEL_SHOW_MIN_P) {
    return input.facts.githubApprovalRequired
      ? 'Model: looks safe to merge as-is. Approve it on GitHub.'
      : 'Model: looks safe to merge as-is.';
  }
  return null;
}

/** What a review card shows for an answer. */
export interface MergeAdviceView {
  decision: MergeReadinessDecision;
  source: MergeAdviceSource;
  reasonCode: string;
  /** Null: assessed, nothing worth saying. */
  line: string | null;
  /**
   * False for the rule answer Home derives before anyone asks: nothing was
   * recorded, so the card still offers "Assess" (which asks the model and
   * records both answers) unless a blocking rule settled it.
   */
  recorded: boolean;
  /** The model that answered, for the tooltip; null for a rule answer with no model asked. */
  model: string | null;
  /** ISO time of the answer. */
  at: string;
  /** null = it describes this PR as it is now. */
  stale: null | 'new_commits' | 'facts_changed';
}

/** The rule answer Home shows before anyone asks: free, from the facts alone. */
export function ruleAdviceView(facts: MergeAdviceFacts, at: string): MergeAdviceView | null {
  const rule = ruleAnswer(facts);
  if (!rule) return null;
  return {
    decision: rule.decision, source: 'rule', reasonCode: rule.reasonCode, line: ruleLine(rule.reasonCode, facts),
    recorded: false, model: null, at, stale: null,
  };
}

/** Does the card offer "Assess"? Yes unless a fresh answer exists, or a blocking rule already settled it. */
export function canAssess(advice: MergeAdviceView | null): boolean {
  if (!advice || advice.stale) return true;
  return !advice.recorded && advice.reasonCode === MERGEABLE_AS_IS_REASON;
}

/** The card's whole merge-advice state: a stored answer, the token to ask for one, or why it cannot. */
export interface MergeAdviceSlot {
  prNumber: number;
  workspaceId: string;
  advice: MergeAdviceView | null;
  /** Signed facts for the ask route; null when this server cannot sign. */
  token: string | null;
  unavailable: string | null;
}

/** Split a ledger `reason` (`source:reasonCode; ...`, decision-policy.ts) into its source and reason code. */
export function parseLedgerReason(reason: string | null | undefined): { source: MergeAdviceSource; reasonCode: string } | null {
  const m = /^(rule|model|fallback):([^;]+)/.exec(reason ?? '');
  return m ? { source: m[1] as MergeAdviceSource, reasonCode: m[2]!.trim() } : null;
}

/** "3m ago". */
export function adviceAge(at: string, now: number = Date.now()): string {
  const mins = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
