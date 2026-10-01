/**
 * A review task the reviewer dispatched: `category: 'review'` plus
 * `context.reviewerFor` naming the reviewed task (the same pair
 * handleReviewerOutcomeIfNeeded requires — the category alone is
 * caller-settable).
 *
 * The one predicate for that question. The claim route uses it to let these
 * skip the mission concurrency cap and pacing gate; the lease paths use it
 * because a review reads a PR and returns a verdict, it never edits, so it
 * holds no edit lease (conflict-aware orchestration §1). Its worker checks out
 * the PR branch, which makes the runner report the whole PR diff as touched;
 * leasing that would block every task overlapping the PR for the length of the
 * review.
 *
 * A reviewer *fix* attempt (`reviewerRetryPrNumber`) is not a review: it edits.
 */
export function isDispatchedReview(category: unknown, context: unknown): boolean {
  if (category !== 'review') return false;
  const reviewerFor = (context as Record<string, unknown> | null | undefined)?.reviewerFor;
  return typeof reviewerFor === 'string' && reviewerFor.length > 0;
}

/** Same function as `isDispatchedReview`, under the name the lease paths read by. */
export const isReadOnlyReview = isDispatchedReview;
