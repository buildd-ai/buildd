/**
 * Re-review planning — shared by every surface that can ask for a fresh
 * verdict on a PR (`POST /api/prs/[prNumber]/re-review`, the MCP
 * `request_pr_review` force path): decide whether a re-review means starting
 * a reviewer from zero, sending it just the delta since a prior terminal
 * verdict, or refusing because one is already in flight.
 *
 * Kept separate from `reviewer.ts` (which only knows how to dispatch, not
 * when to) and from `pr-review-request.ts` (whose `findReviewTaskForPr` this
 * calls) so both callers share one definition of "what should re-review do
 * right now" instead of re-deriving it from raw task rows.
 */

import { findReviewTaskForPr } from './pr-review-request';
import { resolvePriorVerdict, type PriorVerdict } from './reviewer';

const LIVE_REVIEW_STATUSES = new Set(['pending', 'assigned', 'in_progress']);

export type ReReviewPlan =
  /** A reviewer is already working this PR — do not stack a second one. */
  | { kind: 'in_flight'; reviewTaskId: string }
  /**
   * A terminal verdict exists at a different SHA than the current head —
   * dispatch a DELTA review against it.
   */
  | { kind: 'delta'; priorVerdict: PriorVerdict }
  /**
   * No prior verdict to re-review against (none was ever recorded, or the
   * prior review is at the same head as now) — dispatch a normal full review.
   */
  | { kind: 'full' };

/**
 * Decide what a re-review request for this PR should actually do.
 *
 * `currentHeadSha` same as the prior verdict's SHA still resolves to `full`
 * rather than `delta` — a review against an empty diff is not what "delta"
 * means, and the caller (the dashboard route today) is expected to not have
 * offered re-review at all in that case. This function does not enforce
 * that; it just does not manufacture a delta out of nothing.
 */
export async function resolveReReviewPlan(params: {
  workspaceId: string;
  prNumber: number;
  currentHeadSha: string;
}): Promise<ReReviewPlan> {
  const reviewTask = await findReviewTaskForPr(params.workspaceId, params.prNumber);
  if (!reviewTask) return { kind: 'full' };

  if (LIVE_REVIEW_STATUSES.has(reviewTask.status)) {
    return { kind: 'in_flight', reviewTaskId: reviewTask.id };
  }

  const priorVerdict = resolvePriorVerdict(reviewTask);
  if (priorVerdict && priorVerdict.headSha !== params.currentHeadSha) {
    return { kind: 'delta', priorVerdict };
  }

  return { kind: 'full' };
}
