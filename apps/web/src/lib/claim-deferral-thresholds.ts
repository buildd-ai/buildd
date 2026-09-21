/**
 * How long a claim-loop deferral streak must run before it counts as "stuck",
 * at two different severities.
 *
 * Pure by design: the surfacing threshold is read by `mission-state-view.ts`,
 * which must stay importable without a database handle. The stranding sweep
 * (`stranded-tasks-sweep.ts`) reads the other one.
 *
 * Both read the same counter: `gate_events.detail.consecutiveDeferrals`,
 * bumped by `recordOrCoalesceDeferral` once per (taskId, reason) per claim
 * poll, and the same `detail.firstDeferredAt` timestamp, set on the first
 * deferral in a streak and explicitly guaranteed to survive coalescing.
 *
 * PREVIOUSLY this was keyed on `consecutiveDeferrals` alone, under an assumed
 * ~30s runner poll (200 polls ≈ 100 min to strand, 10 ≈ 5 min to surface).
 * The measured p50 claim cadence is over five minutes — more than 10x the
 * assumption — so 200 consecutive polls at the real cadence is the better
 * part of a day away, and the longest deferral streak observed in the audit
 * window never came close to tripping it: the signal was structurally
 * incapable of firing before a human noticed the same thing by hand.
 * `firstDeferredAt` is a wall-clock timestamp, so elapsed time from it is
 * cadence-proof — whatever the poll interval drifts to next, real time still
 * ticks the same. Poll count is kept only as a noise floor (see
 * `MIN_CONSECUTIVE_DEFERRALS`): it stops a single old, isolated deferral
 * event from reading as "stuck" purely because a lot of wall-clock time has
 * passed since it happened.
 */

/** A claim-loop refusal streak this old is worth putting on a mission's screen. */
export const SURFACE_DEFERRAL_MS = 30 * 60 * 1000;

/**
 * A claim-loop refusal streak this old is stranded: nothing re-arms it
 * automatically, and it needs a human or `explain` to look.
 *
 * Sized 4x the surfacing threshold so the owner is warned well before the
 * sweep gives up on the task, mirroring the old 20x-poll relationship without
 * re-deriving it from a cadence that will drift again.
 */
export const STRAND_MS = SURFACE_DEFERRAL_MS * 4;

/**
 * A streak this short is contention, not a stall — a concurrency seat
 * freeing up, a path claim releasing, a duplicate-worker race, a provider
 * blip. Those clear within a poll or two, so a bare elapsed-time check would
 * misreport a task deferred exactly once, a long time ago, as stuck forever.
 * Requiring at least this many consecutive refusals on top of the
 * elapsed-time floor rules that out without reintroducing a poll-count-only
 * threshold.
 */
export const MIN_CONSECUTIVE_DEFERRALS = 2;

function elapsedPastThreshold(
  consecutiveDeferrals: number | null | undefined,
  firstDeferredAt: string | null | undefined,
  thresholdMs: number,
  now: number,
): boolean {
  if (typeof consecutiveDeferrals !== 'number' || consecutiveDeferrals < MIN_CONSECUTIVE_DEFERRALS) return false;
  if (!firstDeferredAt) return false;
  const since = new Date(firstDeferredAt).getTime();
  if (Number.isNaN(since)) return false;
  return now - since >= thresholdMs;
}

/** True when a deferral streak has run long enough to surface on a mission's screen. */
export function isRepeatedlyDeferred(
  consecutiveDeferrals: number | null | undefined,
  firstDeferredAt?: string | null,
  now: number = Date.now(),
): boolean {
  return elapsedPastThreshold(consecutiveDeferrals, firstDeferredAt, SURFACE_DEFERRAL_MS, now);
}

/** True when a deferral streak has run long enough to count as stranded. */
export function isStranded(
  consecutiveDeferrals: number | null | undefined,
  firstDeferredAt?: string | null,
  now: number = Date.now(),
): boolean {
  return elapsedPastThreshold(consecutiveDeferrals, firstDeferredAt, STRAND_MS, now);
}
