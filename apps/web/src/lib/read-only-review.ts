/**
 * A review task the reviewer dispatched: `category: 'review'` plus
 * `context.reviewerFor` naming the reviewed task. It reads a PR and returns a
 * verdict; it never edits, so it holds no edit lease (conflict-aware
 * orchestration §1). Its worker checks out the PR branch, which makes the
 * runner report the whole PR diff as touched; leasing that would block every
 * task overlapping the PR for the length of the review.
 *
 * Same predicate as the claim route's `isDispatchedReview`. A reviewer *fix*
 * attempt (`reviewerRetryPrNumber`) is not a review: it edits.
 */
export function isReadOnlyReview(category: unknown, context: unknown): boolean {
  if (category !== 'review') return false;
  const reviewerFor = (context as Record<string, unknown> | null | undefined)?.reviewerFor;
  return typeof reviewerFor === 'string' && reviewerFor.length > 0;
}
