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
 *
 * `deriveStoredVerdictFallback` closes a fourth gap: `escalationReason` and
 * `approvalSummary` below are normally sourced from a mission note
 * (`reviewer_escalated` / `reviewer_approved`), but `handleReviewerOutcomeIfNeeded`
 * only ever writes those notes `if (missionId)` — a mission-less PR never gets
 * one, no matter how the reviewer verdict came out. Without a note, a
 * `completed` reviewer task with a real terminal verdict was indistinguishable
 * from one that never produced a verdict at all, and fell into the "no
 * recorded verdict" fail-safe below even when `get_pr_review` (which reads the
 * verdict straight off the task row via `derivePrReviewStatus`) reported a
 * clean terminal approve. The fallback reads that same row and applies the
 * same rule the real merge doors use (`evaluateReviewVerdictGate`) so the gate
 * can never show a different answer than the one that actually decided
 * whether to merge — including a stale approval a later push has superseded.
 */

import { derivePrReviewStatus } from './pr-review-status';
import { evaluateReviewVerdictGate } from './review-verdict-gate';

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
  /**
   * The PR's persisted lifecycle (`workers.prLifecycleStatus`). Only read under
   * `auto-threshold` with no reviewer task, where it decides whether auto-merge
   * is still pending (the platform's move) or has already been held (the
   * human's). `undefined` means the caller does not know, and keeps the
   * fail-visible answer: human.
   */
  prLifecycleStatus?: string | null;
}

export interface ReviewerGateResult {
  actor: ReviewerGateActor;
  reason: string | null;
  /** Set when actor === 'agent' — which in-flight state to render. */
  agentState?: 'queued' | 'reviewing';
  /**
   * Set when actor === 'platform' and the platform will merge this PR by
   * itself once CI is green (plain `auto-threshold`). Unlike Option A′, the
   * PR lands on trunk, so it stays visible as in-flight work instead of
   * disappearing.
   */
  platformState?: 'auto_merge';
}

/**
 * Lifecycles under which an `auto-threshold` PR is still on its way to an
 * unattended merge: no CI verdict yet, or CI running. `ci_failed` and
 * `conflict` are left to the CI and conflict gates, and `ci_green` on a PR
 * that is still open means a merge rail refused it.
 */
const AUTO_MERGE_PENDING_LIFECYCLES: ReadonlySet<string | null> = new Set([null, 'pr_open', 'ci_running']);

/**
 * Should this PR get a card in Home's action queue? Human-owned PRs do (they
 * need you), and so do plain auto-merge PRs (shown in flight, never counted).
 * Agent-owned PRs have their own in-flight rail, and Option A′ task PRs render
 * nowhere.
 */
export function gateReachesActionQueue(gate: ReviewerGateResult | undefined): boolean {
  return gate?.actor === 'human' || gate?.platformState === 'auto_merge';
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
    if (input.policyTier === 'auto-threshold' && input.prLifecycleStatus !== undefined) {
      // No reviewer is expected: the check_suite webhook merges this PR by
      // itself once CI is green (tryAutoMergeWorkerPr). Until then it is in
      // flight, and it is nobody's merge request.
      if (AUTO_MERGE_PENDING_LIFECYCLES.has(input.prLifecycleStatus)) {
        return { actor: 'platform', platformState: 'auto_merge', reason: 'Auto-merges when CI passes' };
      }
      if (input.prLifecycleStatus === 'ci_green') {
        return { actor: 'human', reason: 'CI passed but auto-merge did not land it — a merge rail held it' };
      }
      if (input.prLifecycleStatus === 'ci_failed') {
        return { actor: 'human', reason: 'CI failing — auto-merge waits for green' };
      }
      if (input.prLifecycleStatus === 'conflict') {
        return { actor: 'human', reason: 'Branch has conflicts — auto-merge cannot land it' };
      }
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

export interface StoredVerdictFallbackInput {
  /** Already-resolved evidence from a mission note, if any. The fallback only
   * engages when BOTH are absent — a note, where one exists, is the richer,
   * preferred source (it carries the reviewer's dispatchable recommendation
   * text, which the stored verdict alone does not). */
  escalationReason: string | null;
  approvalSummary: string | null;
  /** The reviewer task's own row — same shape `derivePrReviewStatus` reads. */
  reviewerTask: { status: ReviewerTaskStatus; result: unknown; context?: unknown } | null;
  /** The PR's CURRENT head — what would actually be merged. */
  currentHeadSha: string | null;
}

/**
 * Fall back to the reviewer task's own stored verdict when no mission note
 * recorded one — see the module doc. A no-op (returns the input evidence
 * unchanged) unless both `escalationReason` and `approvalSummary` are null AND
 * the reviewer task is terminal (`completed`); a live/pending reviewer task
 * must keep resolving through `resolveReviewerGate`'s agent-owns-it branches,
 * untouched. Returns both null (never fabricates a note) when the reviewer
 * task genuinely produced no verdict — `derivePrReviewStatus` reports that as
 * `review_failed`, which is the one case with nothing to fall back to.
 */
export function deriveStoredVerdictFallback(
  input: StoredVerdictFallbackInput,
): { escalationReason: string | null; approvalSummary: string | null } {
  if (input.escalationReason != null || input.approvalSummary != null) {
    return { escalationReason: input.escalationReason, approvalSummary: input.approvalSummary };
  }
  const rt = input.reviewerTask;
  if (!rt || rt.status !== 'completed') return { escalationReason: null, approvalSummary: null };

  const status = derivePrReviewStatus({
    reviewTask: { id: '', status: rt.status, result: rt.result, context: rt.context },
    worker: null,
  });
  if (status.state === 'review_failed') return { escalationReason: null, approvalSummary: null };

  const verdictGate = evaluateReviewVerdictGate(status, input.currentHeadSha);
  if (verdictGate.blocks) {
    return { escalationReason: verdictGate.reason ?? null, approvalSummary: null };
  }
  if (status.state === 'approved') {
    return { escalationReason: null, approvalSummary: status.summary ?? 'Reviewer approved — awaiting human merge' };
  }
  return { escalationReason: null, approvalSummary: null };
}
