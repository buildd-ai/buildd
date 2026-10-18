/**
 * The escalation brief: what a person is asked to decide when a review-family
 * escalation parks a delivery in ESCALATED. Pure and serialisable, derived from
 * the kernel view alone, so the task page, Home, the PR comment and explain read
 * one cause and one action list instead of each saying "Waiting on you".
 *
 * Nothing here dispatches anything. A held budget stays held: every action is a
 * request a person makes through the same human-triggered command that exists
 * today (T23 HumanResolve, a forced ReviewRequested, FindingDisposed), and the
 * brief only says which are open to them, what each does and what it needs.
 */
import { OPEN_FINDING_STATUSES, type AttemptSnapshot, type FindingSnapshot, type KernelView } from './types';

/** The two causes a spent review budget can have. Other review escalations are `review_required` too: a person's read is what is missing. */
export type EscalationCause = 'fixes_exhausted' | 'review_required';

export const ESCALATION_CAUSE_LABEL: Record<EscalationCause, string> = {
  fixes_exhausted: 'Automated fixes exhausted',
  review_required: 'Review required',
};

export type EscalationActionId = 'review_findings' | 'request_fix' | 'force_re_review' | 'approve_override';

export interface EscalationAction {
  id: EscalationActionId;
  label: string;
  /** What choosing it does, in one sentence, including what it does not do. */
  impact: string;
  /** Who may choose it. The route re-checks; this is what the button says. */
  requires: string;
  available: boolean;
  /** Why it is not available, when it is not. */
  unavailableReason: string | null;
}

export interface BriefFinding {
  id: string;
  title: string;
  path: string | null;
  line: number | null;
  /** Addressed only: the push that touched it is not the current head, so the touch may be stale. */
  stale?: boolean;
}

export interface EscalationBrief {
  cause: EscalationCause;
  /** The cause label with the one number that explains it ("Automated fixes exhausted · 3 of 3 used"). */
  title: string;
  /** One plain sentence on what is held and why. */
  summary: string;
  findings: {
    open: BriefFinding[];
    addressedAwaitingVerification: BriefFinding[];
    resolved: BriefFinding[];
  };
  actions: EscalationAction[];
}

export interface EscalationBriefPermissions {
  /** Policy lets a person approve past remaining findings. Default: not permitted. */
  overridePermitted?: boolean;
  /** The viewer holds merge permission on the repo (T14's evidence for an approval). */
  hasMergePermission?: boolean;
}

const REVIEW_FAMILY_REASONS = new Set(['review_escalated', 'review_exhausted', 'review_unavailable']);

const brief = (f: FindingSnapshot, head: string | null): BriefFinding => ({
  id: f.id, title: f.title, path: f.path, line: f.line,
  ...(f.status === 'addressed' ? { stale: f.addressedBySha != null && head != null && f.addressedBySha !== head } : {}),
});

function fixesSpent(attempts: AttemptSnapshot[], defaultMax: number): { used: number; max: number; spent: boolean } {
  const rows = attempts.filter((a) => a.family === 'review_fix' && a.mode === 'agent' && a.status !== 'skipped');
  const max = rows.reduce((m, a) => Math.max(m, a.maxAttempts), 0) || defaultMax;
  return { used: rows.length, max, spent: rows.length >= max };
}

/** Null unless the delivery is ESCALATED for a review-family reason. */
export function deriveEscalationBrief(view: KernelView, perms: EscalationBriefPermissions = {}): EscalationBrief | null {
  const d = view.delivery;
  if (!d || d.state !== 'ESCALATED' || !d.stateReason || !REVIEW_FAMILY_REASONS.has(d.stateReason)) return null;
  const findings = view.findings ?? [];
  const required = findings.filter((f) => f.required);
  const open = required.filter((f) => f.status === 'open');
  const addressed = required.filter((f) => f.status === 'addressed');
  const resolved = required.filter((f) => !OPEN_FINDING_STATUSES.has(f.status));
  const fixes = fixesSpent(view.attempts, d.maxRounds);
  const cause: EscalationCause = d.stateReason === 'review_exhausted' && fixes.spent && open.length + addressed.length > 0
    ? 'fixes_exhausted' : 'review_required';

  const remaining = open.length + addressed.length;
  const title = cause === 'fixes_exhausted' ? `${ESCALATION_CAUSE_LABEL[cause]} · ${fixes.used} of ${fixes.max} used` : ESCALATION_CAUSE_LABEL[cause];
  const noun = (n: number) => `${n} ${n === 1 ? 'finding' : 'findings'}`;
  const summary = cause === 'fixes_exhausted'
    ? `The automatic fix budget is spent with ${noun(remaining)} still unresolved (${open.length} open, ${addressed.length} with a fix awaiting verification). Nothing runs again until you choose.`
    : addressed.length > 0 && open.length === 0
      ? `${noun(addressed.length)} have a fix that no review has verified yet. Nothing runs again until you choose.`
      : 'No automatic review can settle this PR. Nothing runs again until you choose.';

  const hasHead = d.currentHeadSha != null;
  const actions: EscalationAction[] = [
    {
      id: 'review_findings', label: 'Review findings',
      impact: 'Opens the findings and the review history. Changes nothing.',
      requires: 'Workspace member', available: true, unavailableReason: null,
    },
    {
      id: 'request_fix', label: 'Request another fix',
      impact: 'Dispatches one more fix attempt on the PR branch, recorded as a human extension of the budget. The automatic budget stays spent.',
      requires: 'Workspace member',
      available: open.length > 0,
      unavailableReason: open.length > 0 ? null : 'No open finding is left to fix; the remaining fixes need a review to verify them.',
    },
    {
      id: 'force_re_review', label: 'Request a forced re-review',
      impact: `Queues one review of the current head, even though the review budget is spent. It verifies or reopens the ${noun(addressed.length)} awaiting verification; it does not merge.`,
      requires: 'Workspace member',
      available: hasHead,
      unavailableReason: hasHead ? null : 'The PR has no recorded head to review.',
    },
    {
      id: 'approve_override', label: 'Approve and override',
      impact: 'Records your approval of the current head over the remaining findings, which stay listed as overridden. Merge then follows the workspace policy.',
      requires: 'Merge permission on the repo, and a policy that allows an override',
      available: perms.overridePermitted === true && perms.hasMergePermission === true && hasHead,
      unavailableReason: perms.overridePermitted !== true
        ? 'The merge policy does not allow approving past remaining findings.'
        : perms.hasMergePermission !== true ? 'You do not hold merge permission on this repo.' : hasHead ? null : 'The PR has no recorded head to approve.',
    },
  ];

  return {
    cause, title, summary,
    findings: {
      open: open.map((f) => brief(f, d.currentHeadSha)),
      addressedAwaitingVerification: addressed.map((f) => brief(f, d.currentHeadSha)),
      resolved: resolved.map((f) => brief(f, d.currentHeadSha)),
    },
    actions,
  };
}
