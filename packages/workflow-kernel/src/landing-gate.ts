/**
 * The landing gate (docs/specs/workflow-kernel-library.md §4,
 * workflow-state-kernel.md §13.13 rules 6 and 7): the one question every
 * merge door asks, answered from the delivery's own state at the head that
 * would merge. Pure: the `merge_call` effect asks it again against a fresh
 * read when it runs, and the `buildd/landing` commit status publishes its
 * answer onto the head, so GitHub can enforce what the kernel decided.
 *
 * Until the findings model lands (S5), an "open required verdict" is the
 * newest decided review round asking for changes (or escalating): a later
 * round that approves closes it, nothing else does. A person's recorded
 * approval or override passes it (rule 6); the policy-merge rule passes an
 * escalation, never a request for changes.
 */
import { headCoverage, openVerdict } from './reducer';
import type { DeliverySnapshot, KernelView, RoundSnapshot } from './types';

/** The commit status context the kernel publishes on every kernel-owned PR head. */
export const LANDING_STATUS_CONTEXT = 'buildd/landing';

/** GitHub caps a status description at 140 characters. */
const MAX_DESCRIPTION = 140;

const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : 'unknown');

export type GateBlocker =
  | 'no_delivery' | 'no_pr' | 'head_unknown' | 'head_moved' | 'not_approved' | 'review_missing' | 'open_verdict';

export type ReviewGate =
  | { ok: true; coverage: ReturnType<typeof headCoverage>; overridden: boolean }
  | { ok: false; blocker: GateBlocker; reason: string; round?: RoundSnapshot };

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
  const states = o.states ?? ['APPROVED', 'LANDING'];
  if (!states.includes(d.state)) return { ok: false, blocker: 'not_approved', reason: notApprovedReason(d) };
  const override = o.verdictOverride === true;
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
  state: 'success' | 'failure';
  description: string;
  /** The head the status belongs on. */
  sha: string;
}

/**
 * The `buildd/landing` status for the delivery's current head: `success` only
 * when the kernel would land that head (approved or landing, covered, no open
 * verdict), `failure` with the blocker otherwise. Null when there is nothing
 * to publish on (no PR or head, or the delivery is over: a merged or closed
 * PR's head keeps the last status it was given).
 */
export function landingStatusOf(view: KernelView, o: { detail?: string | null } = {}): LandingStatus | null {
  const d = view.delivery;
  if (!d || d.prNumber == null || !d.repoFullName || !d.currentHeadSha) return null;
  if (d.state === 'MERGED' || d.state === 'CLOSED_UNMERGED' || d.state === 'SUPERSEDED' || d.state === 'ABANDONED' || d.state === 'FAILED') return null;
  const g = reviewGate(view);
  const at = short(d.currentHeadSha);
  if (g.ok) {
    const by = g.coverage === 'human' ? 'a person' : g.coverage === 'composition' ? 'composition' : g.coverage === 'policy' ? 'merge policy' : 'review';
    return { state: 'success', sha: d.currentHeadSha, description: clip(`buildd would land ${at}: approved by ${by}`) };
  }
  // The detail the transition named (a lasting rail's refusal), while the delivery still waits on a person for it.
  const why = o.detail && d.state === 'ESCALATED' ? o.detail : g.reason;
  return { state: 'failure', sha: d.currentHeadSha, description: clip(`buildd will not land ${at}: ${why}`) };
}

/** What the status says when the kernel could not decide it (the effect ran out of retries). Never success. */
export function landingStatusUnknown(sha: string): LandingStatus {
  return { state: 'failure', sha, description: clip(`buildd could not confirm ${short(sha)} can land; ask for a review again or retry the merge`) };
}

function clip(s: string): string {
  return s.length <= MAX_DESCRIPTION ? s : `${s.slice(0, MAX_DESCRIPTION - 1)}…`;
}
