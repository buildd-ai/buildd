/**
 * The dispatched-review predicate lives in core (lib/read-only-task.ts): the
 * claim gates read it, and core never imports this module.
 */
import { isDispatchedReview } from '@/lib/read-only-task';

export { isDispatchedReview };

/** Same function as `isDispatchedReview`, under the name the lease paths read by. */
export const isReadOnlyReview = isDispatchedReview;
