/**
 * Living Spec r7 AC-46: when the kernel refuses a person's decision on an escalation (a
 * bounded fix, a forced review, an approval past remaining findings), the person is told why
 * in plain words, and what they can do next, instead of a reason code. Pure: the doors pass
 * the reducer's reason through here and put the sentence in front of the code.
 *
 * Every reason a decision door can meet has its own sentence; an unknown one still reads as
 * a sentence that names nothing internal.
 */

export type DecisionAction = 'request_fix' | 'force_re_review' | 'approve_override';

const ACTION_WORDS: Record<DecisionAction, string> = {
  request_fix: 'Another fix was not requested',
  force_re_review: 'A forced re-review was not requested',
  approve_override: 'The approval was not recorded',
};

const REASONS: Record<string, string> = {
  // Who may decide.
  human_required: 'only a person signed in to buildd can make this decision, not an agent or an automation.',
  force_requires_human: 'only a person can force another review once the review budget is spent; an agent or an automation cannot.',
  no_merge_permission: 'approving past remaining findings needs merge permission on the repository, which your account does not have.',
  override_not_permitted: 'this workspace\'s merge policy does not allow approving past remaining findings.',
  // Which head.
  decision_head_stale: 'the pull request has a newer commit than the one you decided on. Reload to see the current commit and decide again.',
  round_head_not_current: 'the pull request has a newer commit than the one you decided on. Reload to see the current commit and decide again.',
  review_on_older_commit: 'the approval names an older commit than the one the pull request is on now. Reload and approve the current commit.',
  no_review_at_head: 'no review has read the current commit yet, so there is nothing for a fix to answer. Ask for a review of it first.',
  no_head: 'the pull request has no recorded commit yet.',
  // When.
  version_moved: 'the pull request changed since this page was loaded. Reload to see where it stands now.',
  state_moved: 'the pull request is no longer waiting on this decision; it moved on since this page was loaded. Reload to see where it stands now.',
  state_not_allowed: 'the pull request is not in a state that takes this decision right now. Reload to see where it stands.',
  review_in_flight: 'a review of the current commit is already running.',
  head_already_reviewed: 'the current commit already has a review. Force a re-review to ask for another one.',
  review_budget_spent: 'the review budget for this pull request is spent, so only a person forcing a re-review can start another one.',
  escalation_needs_human: 'this pull request is waiting on a person for a reason another review cannot answer.',
  // What the request was missing.
  expected_version_required: 'the request did not say which version of the pull request it was made on. Reload and try again.',
  decision_id_required: 'the request did not name the decision. Reload and try again.',
  commit_id_required: 'the approval did not name the commit it approves. Reload and try again.',
  reason_required: 'this decision needs a reason.',
  // The kernel could not decide.
  live_read_failed: 'GitHub could not be read just now, so nothing was changed. Try again in a moment.',
  legacy_owns: 'this pull request is not run by the delivery kernel, so this decision does not apply to it.',
  no_delivery: 'buildd has no delivery record for this pull request.',
  pr_not_bound: 'the task has no pull request yet.',
};

/** The sentence for one refusal reason, without the action in front. */
export function decisionRefusalReason(reason: string | null | undefined): string {
  return (reason && REASONS[reason]) || 'buildd could not apply it to the pull request as it stands now. Reload to see where it stands.';
}

/** "A forced re-review was not requested: the pull request has a newer commit than the one you decided on. ..." */
export function explainDecisionRefusal(action: DecisionAction, reason: string | null | undefined): string {
  return `${ACTION_WORDS[action]}: ${decisionRefusalReason(reason)}`;
}

/** The reasons that mean the person's screen is behind the pull request (a reload answers them). */
export const STALE_DECISION_REASONS: ReadonlySet<string> = new Set([
  'decision_head_stale', 'round_head_not_current', 'review_on_older_commit', 'version_moved', 'state_moved',
]);
