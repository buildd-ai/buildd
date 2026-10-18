/**
 * The landing gate (docs/specs/workflow-kernel-library.md §4,
 * workflow-state-kernel.md §13.13 rules 6 and 7): the one question every
 * merge door asks, answered from the delivery's own state at the head that
 * would merge. Pure: the `merge_call` effect asks it again against a fresh
 * read when it runs, and the `Buildd / Review approval` commit status publishes its
 * answer onto the head, so GitHub can enforce what the kernel decided.
 *
 * What stands against a head (§5, rule 2): an open required finding (raised
 * by a request for changes, closed only by a round that verifies it, a
 * person's waiver or a deferral), and the newest decided round when it asked
 * for changes or escalated. A person's recorded approval or override passes
 * both (rule 6); the policy-merge rule passes an escalation, never a finding
 * or a request for changes.
 */
import { describeFinding, openRequiredFindings } from './findings';
import { headCoverage, openVerdict } from './reducer';
import type { DeliverySnapshot, FindingSnapshot, KernelView, RoundSnapshot } from './types';

/** The commit status context the kernel publishes on every kernel-owned PR head: the one a trunk rule requires. */
export const LANDING_STATUS_CONTEXT = 'Buildd / Review approval';

/**
 * The name it was published under before the rename. Still written with the same answer, so a
 * rule or tool that already reads it keeps working until nothing does; never read as CI.
 */
export const LEGACY_LANDING_STATUS_CONTEXT = 'buildd/landing';

/** Every context carrying the kernel's verdict, the legacy name first so the current one is the last write. */
export const LANDING_STATUS_CONTEXTS: readonly string[] = [LEGACY_LANDING_STATUS_CONTEXT, LANDING_STATUS_CONTEXT];

/** GitHub caps a status description at 140 characters. */
const MAX_DESCRIPTION = 140;

const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : 'unknown');

/** A head as a status description names it: its first 7 characters. */
export const shortHeadSha = short;

export type GateBlocker =
  | 'no_delivery' | 'no_pr' | 'head_unknown' | 'head_moved' | 'not_approved' | 'review_missing' | 'open_verdict' | 'open_finding';

export type ReviewGate =
  | { ok: true; coverage: ReturnType<typeof headCoverage>; overridden: boolean }
  | { ok: false; blocker: GateBlocker; reason: string; round?: RoundSnapshot; findings?: FindingSnapshot[] };

/** "finding src/a.ts:3: rename the flag", plus how many more, for a status line or a refusal. */
export function openFindingsReason(open: FindingSnapshot[]): string {
  if (open.length === 0) return 'no open finding';
  const more = open.length > 1 ? ` (and ${open.length - 1} more)` : '';
  return `open finding ${describeFinding(open[0]!)}${more}`;
}

export interface ReviewGateOptions {
  /** The head that would merge; default the delivery's current head. */
  headSha?: string | null;
  /** The states the gate admits: `LANDING` for the merge effect, `APPROVED`/`LANDING` for the status. */
  states?: ReadonlyArray<DeliverySnapshot['state']>;
  /** A person's recorded verdict override on the landing (T15 `bypass`): passes a missing review and an open verdict. */
  verdictOverride?: boolean;
}

/** The review half of the landing gate: is this head covered, with no verdict standing against it? */
export function reviewGate(view: KernelView, o: ReviewGateOptions = {}): ReviewGate {
  const d = view.delivery;
  if (!d) return { ok: false, blocker: 'no_delivery', reason: 'no delivery owns this PR' };
  if (d.prNumber == null || !d.repoFullName) return { ok: false, blocker: 'no_pr', reason: 'the delivery has no PR' };
  const head = o.headSha === undefined ? d.currentHeadSha : o.headSha;
  if (!head || !d.currentHeadSha) return { ok: false, blocker: 'head_unknown', reason: 'the PR head is not known yet' };
  if (head !== d.currentHeadSha) return { ok: false, blocker: 'head_moved', reason: `the head moved to ${short(d.currentHeadSha)}` };
  const override = o.verdictOverride === true;
  // AC-13: an open required finding is named whatever state the delivery is in; only a person passes it.
  const findings = openRequiredFindings(view);
  if (findings.length && !override && headCoverage(d, head) !== 'human') {
    return { ok: false, blocker: 'open_finding', reason: openFindingsReason(findings), findings };
  }
  const states = o.states ?? ['APPROVED', 'LANDING'];
  if (!states.includes(d.state)) return { ok: false, blocker: 'not_approved', reason: notApprovedReason(d) };
  const coverage = headCoverage(d, head);
  if (coverage === 'none' && !override) return { ok: false, blocker: 'review_missing', reason: `no review covers ${short(head)}` };
  const open = openVerdict(view);
  // A person's own approval or override is the recorded decision past a verdict (rule 6); the
  // policy-merge rule lifts an escalation only, never a request for changes.
  const passes = override || d.approvalBasis === 'human'
    || (d.approvalBasis === 'policy_rule' && (open?.effectiveVerdict ?? open?.verdict) === 'escalate');
  if (open && !passes) {
    const v = (open.effectiveVerdict ?? open.verdict) === 'escalate' ? 'escalated' : 'asked for changes';
    return { ok: false, blocker: 'open_verdict', reason: `review round ${open.round} ${v} at ${short(open.headSha)}`, round: open };
  }
  return { ok: true, coverage, overridden: override };
}

/**
 * The approval a standing verdict or a new head leaves behind: the newest decided `approve` round
 * (before `beforeRound`, when given) whose head is not the one now in question. A status or a
 * review that names it tells a reader the earlier approval is no longer what lands, and where it
 * was made, rather than leaving "approved" and "changes requested" to be reconciled from comments.
 */
export function priorApprovalOf(view: Pick<KernelView, 'rounds'>, head: string | null | undefined, beforeRound?: number): RoundSnapshot | null {
  return view.rounds
    .filter((r) => r.status === 'decided' && (r.effectiveVerdict ?? r.verdict) === 'approve' && (beforeRound == null || r.round < beforeRound))
    .sort((a, b) => b.round - a.round)
    .find((r) => r.headSha !== head) ?? null;
}

function notApprovedReason(d: DeliverySnapshot): string {
  switch (d.state) {
    case 'WORKING': case 'AWAITING_PUSH': return 'work on the PR is still running';
    case 'AWAITING_REVIEW': return `review of ${short(d.currentHeadSha)} is pending`;
    case 'CHANGES_REQUESTED': case 'FIXING': return 'a review asked for changes';
    case 'REPAIRING': return `the PR is being repaired (${d.stateReason ?? 'repair'})`;
    case 'BLOCKED_ON_TRUNK': return 'the base branch is red';
    case 'ESCALATED': return `a person has to decide (${d.stateReason ?? 'escalated'})`;
    default: return `the delivery is ${d.state.toLowerCase()}`;
  }
}

export interface LandingStatus {
  /** `pending` while review is still running (not a failure, but it still blocks a required check). */
  state: 'success' | 'failure' | 'pending';
  description: string;
  /** The head the status belongs on. */
  sha: string;
}

/**
 * The plain terms a status description leads with (spec R-43): what a person
 * reading GitHub's check list sees, never the kernel's own vocabulary.
 */
export const REVIEW_STATUS_TERMS = {
  /** An open PR no delivery owns and no review was asked for (open-pr-status.ts). */
  notRequested: 'Review not requested',
  inProgress: 'Review in progress',
  changesRequested: 'Changes requested',
  finding: 'Unresolved review finding',
  ready: 'Ready to merge',
  blocked: 'Merge blocked',
  repairing: 'Branch update in progress',
} as const;

const T = REVIEW_STATUS_TERMS;

/** A stored reason code (`landing_needs_human`) in words: underscores to spaces, the kernel's "landing" as "merge". */
function plainCode(code: string | null | undefined, fallback: string): string {
  return (code ?? fallback).replace(/landing/gi, 'merge').replace(/_/g, ' ');
}

/**
 * The `Buildd / Review approval` status for the delivery's current head: `success` only
 * when the kernel would merge that head (approved or merging, covered, no open
 * verdict), `pending` while review of it has not finished (work running, review
 * awaited), `failure` with the blocker otherwise (an open finding, a verdict
 * against it, a person's decision). Null when there is nothing
 * to publish on (no PR or head, or the delivery is over: a merged or closed
 * PR's head keeps the last status it was given).
 *
 * Each description leads with one of `REVIEW_STATUS_TERMS` (R-43): "Review in
 * progress", "Changes requested", "Unresolved review finding: <finding>"
 * (AC-13), "Ready to merge" or "Merge blocked: <reason>".
 */
export function landingStatusOf(view: KernelView, o: { detail?: string | null } = {}): LandingStatus | null {
  const d = view.delivery;
  if (!d || d.prNumber == null || !d.repoFullName || !d.currentHeadSha) return null;
  if (d.state === 'MERGED' || d.state === 'CLOSED_UNMERGED' || d.state === 'SUPERSEDED' || d.state === 'ABANDONED' || d.state === 'FAILED') return null;
  const g = reviewGate(view);
  const at = short(d.currentHeadSha);
  const status = (state: LandingStatus['state'], term: string, text: string): LandingStatus => ({ state, sha: d.currentHeadSha!, description: clip(`${term}: ${text}`) });
  if (g.ok) {
    const by = g.coverage === 'human' ? 'a person' : g.coverage === 'composition' ? 'composition' : g.coverage === 'policy' ? 'merge policy' : 'review';
    return status('success', T.ready, `${at} approved by ${by}`);
  }
  const gateFailure = (r: ReviewGate): LandingStatus | null => {
    if (r.ok) return null;
    if (r.blocker === 'open_finding' && r.findings?.length) {
      const more = r.findings.length > 1 ? ` (and ${r.findings.length - 1} more)` : '';
      return status('failure', T.finding, `${describeFinding(r.findings[0]!)}${more}`);
    }
    if (r.blocker === 'open_verdict' && r.round && (r.round.effectiveVerdict ?? r.round.verdict) !== 'escalate') {
      const prior = priorApprovalOf(view, null, r.round.round);
      return status('failure', T.changesRequested, prior ? `${r.reason}; supersedes the approval of ${short(prior.headSha)}` : r.reason);
    }
    return null;
  };
  // Review not finished is not a refusal: GitHub shows it as pending, never as a red CI.
  const stale = priorApprovalOf(view, d.currentHeadSha);
  const staleNote = stale ? `; the approval of ${short(stale.headSha)} does not cover it` : '';
  if (g.blocker === 'review_missing') return status('pending', T.inProgress, `no review covers ${at} yet${staleNote}`);
  if (g.blocker === 'not_approved') {
    if (d.state === 'AWAITING_REVIEW') return status('pending', T.inProgress, `${at} is waiting for its review${staleNote}`);
    if (d.state === 'WORKING' || d.state === 'AWAITING_PUSH') return status('pending', T.inProgress, 'work on the PR is still running');
    const standing = openVerdict(view);
    const withdrawn = standing ? priorApprovalOf(view, null, standing.round) : null;
    const withdrawnNote = withdrawn ? `; supersedes the approval of ${short(withdrawn.headSha)}` : '';
    if (d.state === 'CHANGES_REQUESTED') return status('failure', T.changesRequested, `waiting for a fix to ${at}${withdrawnNote}`);
    if (d.state === 'FIXING') return status('failure', T.changesRequested, `a fix for ${at} is in progress${withdrawnNote}`);
    // A repair (behind, conflict, CI) is landing eligibility, not a verdict on the review: while the
    // review of this head stands clean the check is pending, never a red that reads as a rejection.
    if (d.state === 'REPAIRING') {
      const review = reviewGate(view, { states: ['REPAIRING'] });
      if (review.ok) return status('pending', T.repairing, `review approved ${at}; the PR is being repaired (${plainCode(d.stateReason, 'repair')})`);
      if (review.blocker === 'review_missing') return status('pending', T.inProgress, `no review covers ${at} yet`);
      const failedReview = gateFailure(review);
      if (failedReview) return failedReview;
    }
  }
  const failed = gateFailure(g);
  if (failed) return failed;
  // The detail the transition named (a lasting rail's refusal), while the delivery still waits on a person for it.
  if (o.detail && d.state === 'ESCALATED') return status('failure', T.blocked, o.detail);
  if (g.blocker === 'not_approved' && d.state === 'ESCALATED') return status('failure', T.blocked, `a person has to decide (${plainCode(d.stateReason, 'escalated')})`);
  if (g.blocker === 'not_approved' && d.state === 'REPAIRING') return status('failure', T.blocked, `the PR is being repaired (${plainCode(d.stateReason, 'repair')})`);
  return status('failure', T.blocked, g.reason);
}

/** What the status says when the kernel could not decide it (the effect ran out of retries). Never success. */
export function landingStatusUnknown(sha: string): LandingStatus {
  return { state: 'failure', sha, description: clip(`${T.blocked}: buildd could not confirm ${short(sha)} is ready to merge; ask for a review again or retry the merge`) };
}

/** A description clipped to GitHub's 140 characters. */
export function clip(s: string): string {
  return s.length <= MAX_DESCRIPTION ? s : `${s.slice(0, MAX_DESCRIPTION - 1)}…`;
}
