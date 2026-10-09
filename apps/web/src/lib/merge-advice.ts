/**
 * "Can this PR merge now?": the facts the merge-readiness decision reads, and
 * the one line a review card shows for its answer. Pure and client-safe.
 *
 * The decision itself is the `buildd.merge_readiness` kind
 * (merge-readiness-decision.ts); this file holds only what core surfaces need
 * to render a stored answer: the closed fact set, the answer set, the ledger
 * subject format and the sentence. Jev returns a label and a confidence, never
 * prose, so every sentence here is composed from the label and the facts.
 *
 * Advisory only. Nothing reads an answer to merge, change a review, or feed a
 * gate (`evaluateAutoMergeSafety` included). Gating on it needs a held-out eval
 * against outcome gold (merged / reverted) first.
 */
import { REVIEW_BLOCKER_KINDS, blockerLabel, type ReviewBlockerKind } from './attention-line';

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
    },
  };
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

/** Where an answer came from: a deterministic rule over the facts, Jev, or the kind's safe fallback. */
export type MergeAdviceSource = 'rule' | 'model' | 'fallback';

/** The one line for an answer. Rule answers name the rule that fired (`reasonCode`). */
export function mergeAdviceLine(
  decision: MergeReadinessDecision,
  source: MergeAdviceSource,
  reasonCode: string,
  facts: Pick<MergeAdviceFacts, 'blockers' | 'githubApprovalRequired'>,
): string {
  if (source === 'fallback') return 'Jev could not call this one. Decide from the review.';
  if (source === 'rule') {
    switch (reasonCode) {
      case 'rule_refresh_first': return 'Wait: the branch refresh has to merge first.';
      case 'rule_mission_blocked': return 'Wait: the mission\'s other work has to land first.';
      case 'rule_draft': return 'Wait: the PR is still a draft.';
      case 'rule_conflict': return 'Wait: the branch has a merge conflict to resolve.';
      case 'rule_ci_running': return 'Wait: CI is still running.';
      case 'rule_ci_fixing': return 'Wait: an agent is fixing CI.';
      case 'rule_review_in_flight': return 'Wait: a review is still running on this commit.';
      case 'rule_ci_failing': return 'Needs you: CI is failing and no fix is running.';
      case 'rule_changes_requested': return 'Send it back: the reviewer asked for changes.';
    }
  }
  const labels = facts.blockers.filter(b => b !== 'other').map(blockerLabel);
  switch (decision) {
    case 'merge_now':
      return facts.githubApprovalRequired
        ? 'Looks safe to merge: CI is green and the review covers this commit. Approve it on GitHub.'
        : 'Looks safe to merge: CI is green and the review covers this commit.';
    case 'request_changes':
      return 'Send it back: what the reviewer flagged looks like it needs changes.';
    case 'wait':
      return 'Wait: something on this PR is still settling.';
    case 'needs_human':
      return labels.length
        ? `Needs your judgement: ${labels.join(', ')}.`
        : 'Needs your judgement on what the reviewer flagged.';
  }
}

/** What a review card shows for a stored answer. */
export interface MergeAdviceView {
  decision: MergeReadinessDecision;
  source: MergeAdviceSource;
  line: string;
  /** ISO time of the ledger row. */
  at: string;
  /** null = it describes this PR as it is now. */
  stale: null | 'new_commits' | 'facts_changed';
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
