/**
 * How many consecutive claim-loop deferrals count as "stuck", at two different
 * severities.
 *
 * Pure by design: the surfacing threshold is read by `mission-state-view.ts`,
 * which must stay importable without a database handle. The stranding sweep
 * (`stranded-tasks-sweep.ts`) reads the other one.
 *
 * Both numbers describe the same counter: `gate_events.detail
 * .consecutiveDeferrals`, bumped by `recordOrCoalesceDeferral` once per
 * (taskId, reason) per claim poll and reset when the task finally dispatches.
 */

/**
 * A task with no `startAt` at all (blocked by a gate that never sets one —
 * `workspace_cap`, `mission_paced`, `advisory_manifest`, …) is STRANDED once the
 * same reason has fired this many consecutive polls. Sized against a runner's
 * ~30s heartbeat poll so it lands in the same rough 2-hour ballpark as the
 * `startAt`-based path.
 */
export const STRAND_CONSECUTIVE_THRESHOLD = 200;

/**
 * The threshold at which a repeated deferral stops being contention and starts
 * being something the mission owner needs to see on the screen.
 *
 * Pinned to a twentieth of the stranding threshold rather than picked as a
 * round number, so it tracks the stranding definition instead of drifting away
 * from it: change the poll cadence or the strand window and this moves with
 * them. At a ~30s poll that is ~5 minutes of the SAME gate refusing the SAME
 * task.
 *
 * Why that point and not sooner or later:
 * - Sooner is noise. Every transient deferral reason — a concurrency seat
 *   freeing up, a path claim releasing, a duplicate-worker race, a provider
 *   blip — clears within a poll or two. A threshold of 2 or 3 would put a
 *   warning on the screen for work that was never actually stuck.
 * - Later is the bug this exists to fix. The stranding sweep only speaks at
 *   200, roughly two hours in, and it runs hourly, so the owner can watch a
 *   "1 agent active" spinner for most of an afternoon before anything says the
 *   agent has not been allowed to start. Surfacing at a twentieth of that puts
 *   the owner ~20x ahead of the platform's own give-up point.
 */
export const SURFACE_DEFERRAL_THRESHOLD = STRAND_CONSECUTIVE_THRESHOLD / 20;

/** True when a deferral counter has passed the surfacing threshold. */
export function isRepeatedlyDeferred(consecutiveDeferrals: number | null | undefined): boolean {
  return typeof consecutiveDeferrals === 'number' && consecutiveDeferrals >= SURFACE_DEFERRAL_THRESHOLD;
}
