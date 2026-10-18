/**
 * Merge holds (docs/specs/workflow-kernel-library.md §4): GitHub will not merge
 * a head yet because a required check has not passed (it is expected, or still
 * running). Nothing is wrong with the PR, so this is never a person's: the
 * `merge_call` effect parks itself (the delivery stays LANDING, the approval
 * stands, no attempt is spent) and calls again with backoff, or as soon as a
 * check on that head reports (`wakeHeldMergesOn`). Only a hold that outlives
 * `MERGE_HOLD_MAX_MS`, or one on the review check the kernel itself will not
 * turn green, escalates, naming the check.
 *
 * The same row also waits, before it calls GitHub at all, for the head's own
 * `Buildd / Review approval` success to be published and read back, so a merge
 * never races ahead of the status a required-check rule reads.
 */
import type { Store } from './ports';

/** The outcome prefix of a held merge call; the wake finds held rows by it. */
export const MERGE_HELD_OUTCOME = 'held';

/** A hold lasting this long (from the landing request) is a person's, named. */
export const MERGE_HOLD_MAX_MS = 2 * 60 * 60_000;
/** The first wait, and the shortest. */
export const MERGE_HOLD_MIN_DELAY_MS = 30_000;
/** The longest wait between two calls; a check reporting wakes it sooner. */
export const MERGE_HOLD_MAX_DELAY_MS = 10 * 60_000;

/** The wait before the next call, doubling with how long the merge has been held. */
export function mergeHoldDelayMs(heldForMs: number): number {
  return Math.min(MERGE_HOLD_MAX_DELAY_MS, Math.max(MERGE_HOLD_MIN_DELAY_MS, Math.floor(heldForMs)));
}

/** A held row's outcome, naming what it waits on. */
export function heldOutcome(check: string | null, why = 'required_check'): string {
  return `${MERGE_HELD_OUTCOME}:${why}:${check ?? 'unnamed'}`;
}

/** A check on `headSha` reported: make the delivery's held merge due now. Returns how many rows woke. */
export function wakeHeldMergesOn(store: Store, deliveryId: string, headSha: string): Promise<number> {
  return store.wakeHeldMerges(deliveryId, headSha);
}
