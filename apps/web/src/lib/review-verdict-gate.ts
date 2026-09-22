/**
 * The review-verdict gate — one rule, enforced at every door that can merge.
 *
 * ## Why this exists
 *
 * Before this gate, whether a reviewer's `request-changes` actually held the
 * door depended entirely on which door was used and on what tier the PR
 * resolved to:
 *
 *   - `PUT /api/github/pr` (merge_pr) consulted the verdict ONLY under
 *     `agent-review`. Under `auto-threshold` it consulted nothing.
 *   - The CI-green webhook did the same: an `agent-review` PR waited for an
 *     approve, an `auto-threshold` PR merged the moment checks went green.
 *   - `POST /api/prs/[prNumber]/merge` — the dashboard merge button — consulted
 *     the verdict at NO tier, and its one `override` affordance existed only
 *     for `escalate` cards.
 *
 * And `auto-threshold` is not the rare case it sounds like. `resolvePolicy`
 * rule 2 drops the tier to `auto-threshold` for every task PR based on a
 * mission integration branch (Option A′) — while `requestIntegrationBranchReview`
 * in `api/github/pr/route.ts` deliberately dispatches a reviewer for exactly
 * those PRs. So the review was requested and then structurally ignored: the
 * finding landed only if the retry happened to push before CI went green.
 *
 * This module is the one place that answers "does the current review state
 * block this merge", and every door asks it. It follows the precedent set by
 * `guardMissionPrMerge` (mission-pr.ts), which is called from all three merge
 * routes rather than reimplemented per call site.
 *
 * ## The stale-verdict rule (why a push no longer clears the gate on its own)
 *
 * A reviewer is dispatched on `pull_request: opened`, AND (as of the fix this
 * paragraph documents) re-dispatched on `synchronize` whenever the PR carries
 * a terminal `changes_requested`/`escalated` verdict — see
 * `maybeReDispatchReviewer` in the webhook route. Before that fix, nothing
 * re-dispatched on `synchronize` at all: a request-changes retry pushed its
 * fix, the stored verdict stayed `changes_requested` forever, and this gate
 * used to treat ANY head-SHA mismatch as "a push must have superseded it" and
 * pass — which is also exactly how the incident this gate exists to prevent
 * happened in the first place (a merge on the very commit the reviewer had
 * just rejected got waved through because some earlier push, unrelated to the
 * fix, had already moved the head once).
 *
 * Now that re-dispatch is automatic, a verdict at a stale SHA is not evidence
 * a fix was reviewed — it is evidence a fresh review is either already
 * running (in which case `readPrReviewStatus` reports the NEW round, not this
 * stale one — reviewer tasks are read newest-first, so the fresh round simply
 * replaces the stale verdict as far as this gate is concerned) or has not
 * been dispatched yet (a redelivery gap, a policy that no longer routes the
 * PR to a reviewer, a dispatch failure). Passing in that second case is
 * exactly the bug: a push would clear the gate with nothing having reviewed
 * it. So a block no longer has a SHA-mismatch escape hatch — it blocks until
 * a fresh review reaches a terminal state, full stop. The one exception is
 * `approved` (see `stale_approval` below), which starts from PASS instead of
 * BLOCK, so the same "does the recorded verdict still describe this commit"
 * question runs in the opposite direction.
 *
 * ## `stale_approval` — an approve is a claim about a commit too
 *
 * `approved` used to be a pure pass, unconditionally, verdict-SHA never
 * examined — an approval on commit A kept authorizing a merge of commit B
 * forever, with nothing recording that the approval no longer describes what
 * would actually land. That silently stale approval is closed the same way
 * as the changes_requested case, just from the other direction: an approve
 * still passes when its SHA matches (or is unrecorded — legacy data with no
 * SHA to compare cannot prove staleness, so it defers to the ordinary pass),
 * but blocks as `stale_approval` when a later push is provably a different
 * commit. This does not re-dispatch a reviewer on its own — re-dispatching an
 * agent on every push after every approval would fire far more often than the
 * request-changes case (approvals are the common terminal state, and most
 * approved PRs merge before another push ever lands) — it is the "explicit
 * recorded decision" half of closing the gap: the gate stops silently
 * trusting a superseded approval, and a human or a fresh `re-review` request
 * clears it from there.
 *
 * ## Fail closed on an unknown commit — except for `stale_approval`
 *
 * For every OTHER block kind, if either SHA is unknown, staleness cannot be
 * proven and refusing (fail closed) is safer: merging past an unread verdict
 * is unrecoverable, parking the PR for a human is not — same doctrine as
 * `evaluateAutoMergeSafety`'s CI read. `stale_approval` inverts this
 * deliberately: it starts from PASS (an approval is normally a clean pass),
 * so an unknown SHA there means "cannot prove this approval is stale," which
 * defers to the pass rather than manufacturing a block older data can never
 * clear.
 */

import { readPrReviewStatus } from '@/lib/pr-review-request';
import type { PrReviewStatus, PrReviewState } from '@/lib/pr-review-status';

/** Which review condition is holding the door. */
export type ReviewGateBlockKind = 'changes_requested' | 'escalated' | 'in_flight' | 'stale_approval';

export interface ReviewVerdictGateResult {
  blocks: boolean;
  kind?: ReviewGateBlockKind;
  /** Caller-facing refusal. Always names the blocking verdict. */
  reason?: string;
  /** What would clear it. Never omitted on a block — a refusal with no exit is a dead end. */
  clearedBy?: string;
  state?: PrReviewState;
  reviewTaskId?: string | null;
  /** The commit the blocking round was made against. */
  reviewHeadSha?: string | null;
}

const PASS: ReviewVerdictGateResult = { blocks: false };

/**
 * The pure rule. Split from the DB read so every door's test can drive it
 * directly, and so the two inputs it depends on are visible in one signature.
 *
 * `currentHeadSha` is the commit that would actually be merged — the PR's head,
 * not the worker's last recorded commit, which can lag a push.
 */
export function evaluateReviewVerdictGate(
  status: Pick<PrReviewStatus, 'state' | 'merged' | 'reviewTaskId' | 'reviewHeadSha' | 'feedback' | 'summary' | 'escalationReason'>,
  currentHeadSha: string | null | undefined,
): ReviewVerdictGateResult {
  // Already merged — there is no merge left to gate, and re-reporting a stale
  // verdict here would turn every idempotent re-merge into a refusal.
  if (status.merged) return PASS;

  const reviewSha = normalizeSha(status.reviewHeadSha);
  const headSha = normalizeSha(currentHeadSha);
  const provablyDifferent = !!(reviewSha && headSha && reviewSha !== headSha);

  let kind: ReviewGateBlockKind | null;
  if (status.state === 'approved') {
    // Starts from PASS, unlike every other kind below — an approval is
    // normally a clean pass, and only blocks when staleness is PROVABLE. See
    // the module doc's "stale_approval" section for why this runs in the
    // opposite direction from the other kinds.
    if (!provablyDifferent) return PASS;
    kind = 'stale_approval';
  } else {
    kind = blockKindFor(status.state);
    if (!kind) return PASS;
    // No SHA-mismatch escape here (see the module doc's "stale-verdict rule"):
    // a re-review is dispatched automatically now, so a lingering mismatch
    // means one hasn't landed yet, not that a push already resolved it.
  }

  const shaLabel = headSha ? ` at ${headSha.slice(0, 7)}` : '';
  const detail = firstLine(
    kind === 'escalated'
      ? status.escalationReason ?? status.summary
      : status.feedback ?? status.summary,
  );

  return {
    blocks: true,
    kind,
    state: status.state,
    reviewTaskId: status.reviewTaskId ?? null,
    reviewHeadSha: status.reviewHeadSha ?? null,
    reason: `${REASON[kind]}${shaLabel}${detail ? ` — ${detail}` : ''}`,
    clearedBy: CLEARED_BY[kind],
  };
}

/** Read the PR's review state and apply the rule. */
export async function guardReviewVerdict(params: {
  workspaceId: string;
  prNumber: number;
  /** The commit being merged. Null is treated as unknown — see "fail closed". */
  headSha: string | null | undefined;
  deps?: {
    read?: (p: { workspaceId: string; prNumber: number }) => Promise<PrReviewStatus>;
  };
}): Promise<ReviewVerdictGateResult> {
  const read = params.deps?.read ?? readPrReviewStatus;
  let status: PrReviewStatus;
  try {
    status = await read({ workspaceId: params.workspaceId, prNumber: params.prNumber });
  } catch (err) {
    // Fail closed, same doctrine as the SHA comparison above and as
    // `evaluateAutoMergeSafety`'s CI read: this is the only read that can tell
    // whether a finding is outstanding, so merging without it is merging with
    // no review gate at all. Every caller has already made several DB reads by
    // the time it gets here, so a failure at this point is pathological rather
    // than a routine blip — and parking the PR is recoverable.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[review-gate] could not read review status for PR #${params.prNumber}:`, message);
    return {
      blocks: true,
      kind: 'in_flight',
      reason: `could not read this PR's review status — refusing the merge: ${message}`,
      clearedBy: 'Retry, or merge with an explicit human override, which is recorded as a bypass.',
    };
  }
  return evaluateReviewVerdictGate(status, params.headSha);
}

// `approved` is handled directly in evaluateReviewVerdictGate (it starts from
// PASS, the opposite default from everything here) — it never reaches this
// function.
function blockKindFor(state: PrReviewState): ReviewGateBlockKind | null {
  switch (state) {
    case 'changes_requested':
      return 'changes_requested';
    case 'escalated':
      return 'escalated';
    case 'queued':
    case 'reviewing':
      return 'in_flight';
    // `not_requested` is the ordinary pass case.
    //
    // `review_failed` is deliberately NOT a block: it means the reviewer never
    // produced a verdict, so there is no finding to protect, and it already has
    // its own escalation (escalateReviewContractFailure). Blocking on it would
    // strand every PR whose reviewer session died, with no push able to clear
    // it — nothing re-reviews an existing head SHA.
    default:
      return null;
  }
}

const REASON: Record<ReviewGateBlockKind, string> = {
  changes_requested: 'the reviewer requested changes on this PR and no later review has cleared that verdict',
  escalated: 'the reviewer escalated this PR to a human',
  in_flight: 'a review round is still in flight on this PR',
  stale_approval: 'the reviewer\'s approval was made against an earlier commit — a later push has since moved the head',
};

const CLEARED_BY: Record<ReviewGateBlockKind, string> = {
  changes_requested:
    'Push a fix — an agent-review PR is re-reviewed automatically — or request a re-review, then merge on an approve. A human can merge past it with an explicit override, which is recorded as a bypass.',
  escalated:
    'Act on the escalation, or merge past it with an explicit human override, which is recorded as a bypass.',
  in_flight: 'Wait for the verdict, then merge on an approve. A human can merge past it with an explicit override, which is recorded as a bypass.',
  stale_approval:
    'Request a re-review of the new commit, or merge past it with an explicit human override, which is recorded as a bypass.',
};

/** A 40-hex commit id, lowercased, or null for anything that is not one. */
function normalizeSha(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
}

/** Keep a refusal to one line — the full feedback lives on the review itself. */
function firstLine(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const line = text.split('\n').map((s) => s.trim()).find((s) => s.length > 0);
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}
