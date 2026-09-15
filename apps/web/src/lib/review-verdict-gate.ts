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
 * ## The stale-verdict rule (why this cannot be "block while changes_requested")
 *
 * A reviewer is dispatched on `pull_request: opened` and nothing re-dispatches
 * one on `synchronize`. So after a request-changes, the retry task pushes its
 * fix and the stored verdict STAYS `changes_requested` forever. A gate keyed on
 * the verdict alone would deadlock every PR that was ever reviewed badly once.
 *
 * A verdict is a statement about the commit it read. So the gate compares the
 * review round's `headSha` against the commit actually being merged:
 *
 *   - same commit  → the finding is about this code. Block.
 *   - different    → a push has superseded it. Pass.
 *
 * That is also exactly the shape of the incident this gate closes: the merge
 * landed on the same head SHA the reviewer had just rejected, with no push in
 * between.
 *
 * ## Fail closed on an unknown commit
 *
 * If either SHA is unknown, staleness cannot be proven, and a blocking state is
 * treated as blocking. Same doctrine as `evaluateAutoMergeSafety`'s CI read:
 * refusing parks the PR for a human, which is recoverable — merging past an
 * unread verdict is not.
 */

import { readPrReviewStatus } from '@/lib/pr-review-request';
import type { PrReviewStatus, PrReviewState } from '@/lib/pr-review-status';

/** Which review condition is holding the door. */
export type ReviewGateBlockKind = 'changes_requested' | 'escalated' | 'in_flight';

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

  const kind = blockKindFor(status.state);
  if (!kind) return PASS;

  // Superseded by a push: the round describes code that is no longer what
  // merges. Both SHAs must be known to make that claim — see "fail closed".
  const reviewSha = normalizeSha(status.reviewHeadSha);
  const headSha = normalizeSha(currentHeadSha);
  if (reviewSha && headSha && reviewSha !== headSha) return PASS;

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

function blockKindFor(state: PrReviewState): ReviewGateBlockKind | null {
  switch (state) {
    case 'changes_requested':
      return 'changes_requested';
    case 'escalated':
      return 'escalated';
    case 'queued':
    case 'reviewing':
      return 'in_flight';
    // `approved` and `not_requested` are the ordinary pass cases.
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
};

const CLEARED_BY: Record<ReviewGateBlockKind, string> = {
  changes_requested:
    'Push the fix — a new commit supersedes the verdict — or re-review the PR and merge on an approve. A human can merge past it with an explicit override, which is recorded as a bypass.',
  escalated:
    'Act on the escalation, or merge past it with an explicit human override, which is recorded as a bypass.',
  in_flight: 'Wait for the verdict, then merge on an approve. A human can merge past it with an explicit override, which is recorded as a bypass.',
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
