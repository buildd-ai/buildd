/**
 * Reviewer gate — decides who owns the next move on an open PR under the
 * agent-review merge policy: the review agent, or the human.
 *
 * Fixes the inverse of a known bug (task facae217, which under-fired: a
 * reviewed-but-unmerged PR was missing from Waiting on You). This over-fires
 * the other way — a PR whose reviewer task hasn't even been claimed yet was
 * asking the human to merge it, wasting the reviewer's verdict once it
 * eventually ran against an already-merged PR. `resolveReviewerGate` is the
 * single predicate both directions must agree with: PENDING or RUNNING
 * reviewer work means the agent still owns this PR.
 *
 * A third owner joined those two under Option A′: a task PR based on a mission
 * integration branch is owned by neither the reviewer nor the human — buildd
 * merges it unattended. See `isMissionIntegrationTaskPr`.
 */

/**
 * Who owns the next move on this PR.
 *
 * `platform` is neither of the other two on purpose: no reviewer agent is
 * involved and no human is expected to act, because buildd itself will merge
 * the PR unattended once its rails pass. It exists for Option A′ task PRs,
 * whose base is a mission integration branch — see `resolveReviewerGate`.
 * Surfaces must render it as neither an in-flight review nor a human queue
 * item; the safest handling is to render nothing.
 */
export type ReviewerGateActor = 'human' | 'agent' | 'platform';

export type ReviewerTaskStatus =
  | 'pending'
  | 'assigned'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ReviewerGateReviewerTask {
  status: ReviewerTaskStatus;
  /** A worker in a LIVE_WORKER_STATUSES state is currently claimed on this task. */
  hasLiveWorker: boolean;
  createdAt: Date;
  context?: Record<string, unknown> | null;
  startAt?: Date | null;
}

export interface ReviewerStallFacts {
  seats: { inProgress: number; maxConcurrentTasks: number } | null;
  /** null means the lookup failed; [] means no recorded pauses. */
  budgetPauses: string[] | null;
}

export interface ReviewerGateInput {
  stallFacts?: ReviewerStallFacts;
  policyTier: 'auto-threshold' | 'agent-review' | 'human' | string;
  /** From an open reviewer_escalated mission note for this task, if any. */
  escalationReason: string | null;
  /** From an open reviewer_approved mission note (approve-only gate), if any. */
  approvalSummary: string | null;
  /** The most recent reviewer task for this PR, or null if none was ever created. */
  reviewerTask: ReviewerGateReviewerTask | null;
  /** When the PR opened — used to judge staleness when no reviewer task exists yet. */
  prOpenedAt: Date | null;
  now: Date;
  /** Minutes without a live reviewer before surfacing a stall. Default 30. */
  queuedThresholdMinutes?: number;
  /**
   * Option A′: is this a TASK PR whose base is its mission's integration
   * branch? Callers must compute it with `isMissionIntegrationBase` (the
   * authoritative predicate, which consults the mission's opt-in) and default
   * it to false — "we do not know where this PR is going" must never resolve to
   * "quarantined", because that is the direction that drops a review gate.
   *
   * False for the mission PR itself: its base is trunk, which is precisely why
   * the tier applies there.
   */
  isMissionIntegrationTaskPr?: boolean;
}

export interface ReviewerGateResult {
  actor: ReviewerGateActor;
  reason: string | null;
  /** Set when actor === 'agent' — which in-flight state to render. */
  agentState?: 'queued' | 'reviewing';
}

const DEFAULT_QUEUED_THRESHOLD_MINUTES = 30;

function minutesSince(from: Date, now: Date): number {
  return (now.getTime() - from.getTime()) / 60000;
}

function stallReason(input: ReviewerGateInput): string {
  const rt = input.reviewerTask;
  const facts = input.stallFacts;
  const age = Math.max(0, Math.floor(minutesSince(rt?.createdAt ?? input.prOpenedAt!, input.now)));
  const parts = [rt
    ? `${rt.status === 'pending' ? 'Pending' : `Reviewer ${rt.status}, no live worker`} · task age ${age}m`
    : `No reviewer task recorded · PR waiting ${age}m`];
  parts.push(facts?.seats
    ? `seats ${facts.seats.inProgress}/${facts.seats.maxConcurrentTasks}` : 'seats unknown');
  const floor = rt?.startAt && rt.startAt > input.now ? rt.startAt : null;
  const providerFloor = floor && rt?.context?.budgetExhausted === true;
  if (facts?.budgetPauses == null) parts.push('budget pause unknown');
  else if (facts.budgetPauses.length) parts.push(...facts.budgetPauses);
  else if (!providerFloor) parts.push('no recorded budget pause');
  if (floor) parts.push(`${providerFloor ? 'provider retry' : 'scheduled start'} floor until ${floor.toISOString()}`);
  const reason = rt?.context?.lastClaimAttemptReason;
  const stampedAt = rt?.context?.lastClaimAttemptAt;
  // A stamp is historical evidence, not a new pre-filter evaluation. Preserve
  // the exact reason and its observation time instead of asserting it still holds.
  parts.push(typeof reason === 'string' && reason.length > 0
    ? `claimable: last attempt no — ${reason} (${typeof stampedAt === 'string' ? stampedAt : 'time unknown'})`
    : 'claimable: not yet diagnosed');
  return parts.join(' · ');
}

export function resolveReviewerGate(input: ReviewerGateInput): ReviewerGateResult {
  const threshold = input.queuedThresholdMinutes ?? DEFAULT_QUEUED_THRESHOLD_MINUTES;

  // Tier is a hard human gate regardless of review state.
  if (input.policyTier === 'human') {
    return { actor: 'human', reason: 'Human Gate — manual merge required' };
  }

  // The agent already handed this back explicitly — trust its verdict over
  // any inferred task-status state.
  if (input.escalationReason != null) {
    return { actor: 'human', reason: input.escalationReason };
  }
  if (input.approvalSummary != null) {
    return { actor: 'human', reason: 'Reviewer approved — awaiting human merge' };
  }

  // Option A′: a task PR based on the mission's integration branch. It resolved
  // to `auto-threshold` so it could land unattended into a branch that is by
  // construction quarantined from trunk — the human gate for this work is the
  // ONE mission PR. Every human handoff below is derived from "no reviewer is
  // going to act on this", which is true here and yet means the opposite: the
  // platform will merge it. Without this branch, opting a mission in DEMOTES
  // its task PRs and then presents every one of them as a manual merge.
  //
  // Placed below the three checks above, and that order is the contract:
  //   - `policyTier === 'human'` comes from task.requiresReview (resolvePolicy
  //     rule 1 beats rule 2), an explicit per-task operator act A′ must not revoke;
  //   - an escalation or approval note is an agent handing the PR back by name,
  //     which the escalation inbox also honours ahead of any tier check.
  // Everything below is reviewer-task inference, and none of it should page a
  // human about a PR nobody is waiting on.
  if (input.isMissionIntegrationTaskPr) {
    return {
      actor: 'platform',
      reason: 'Merges into the mission integration branch — the mission PR is the review gate',
    };
  }

  const rt = input.reviewerTask;

  if (!rt) {
    if (input.policyTier === 'agent-review') {
      // Allow the configured grace period before surfacing the missing task.
      if (input.prOpenedAt && minutesSince(input.prOpenedAt, input.now) > threshold) {
        return {
          actor: 'human',
          reason: stallReason(input),
        };
      }
      return { actor: 'agent', agentState: 'queued', reason: 'review queued' };
    }
    // No reviewer task, and this policy tier will never create one.
    return { actor: 'human', reason: 'No reviewer will run for this PR — manual merge required' };
  }

  if (rt.status === 'failed' || rt.status === 'cancelled') {
    return { actor: 'human', reason: `Reviewer task ${rt.status} — needs human review` };
  }

  if (rt.hasLiveWorker) {
    return { actor: 'agent', agentState: 'reviewing', reason: 'agent reviewing' };
  }

  if (rt.status === 'pending' || rt.status === 'assigned' || rt.status === 'in_progress') {
    if (minutesSince(rt.createdAt, input.now) > threshold) {
      return {
        actor: 'human',
        reason: stallReason(input),
      };
    }
    return { actor: 'agent', agentState: 'queued', reason: 'review queued' };
  }

  // 'completed' reaching here (no escalation/approval note recorded) is
  // unexpected — nothing else is going to act on this PR, so hand it to a
  // human rather than silently stranding it.
  return {
    actor: 'human',
    reason: 'Review completed without a recorded verdict — needs human review',
  };
}
