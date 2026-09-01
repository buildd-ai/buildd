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
 */

export type ReviewerGateActor = 'human' | 'agent';

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
}

export interface ReviewerGateInput {
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
  /** Minutes a reviewer may sit unclaimed before "not started" counts as "not coming". Default 30. */
  queuedThresholdMinutes?: number;
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

  const rt = input.reviewerTask;

  if (!rt) {
    if (input.policyTier === 'agent-review') {
      // A reviewer task should exist under this policy but doesn't yet — most
      // likely a dispatch race right after the PR opened. Give it the same
      // grace period as an unclaimed reviewer task before concluding nobody
      // is coming.
      if (input.prOpenedAt && minutesSince(input.prOpenedAt, input.now) > threshold) {
        return {
          actor: 'human',
          reason: `No reviewer has started after ${threshold}m — check for a stuck dispatch`,
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
        reason: `Reviewer has not started in over ${threshold}m — likely seat contention or backoff`,
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
