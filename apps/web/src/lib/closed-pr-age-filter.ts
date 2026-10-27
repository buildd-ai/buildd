/**
 * Ages a closed-unmerged PR out of explain's attention surfaces.
 *
 * A closed PR on a task with no open mission to answer for it sits forever
 * as `pr_closed_unmerged` unless a person or the auto-supersession scan
 * (pr-supersession-detect.ts) resolves it. Most of the backlog this was
 * written against (task 9e379e31) was exactly that: retries whose PR closed
 * because a later attempt merged, now caught by `rescanOnMerge`'s
 * task-lineage nomination, plus dead standalone experiments nobody will ever
 * resolve.
 *
 * This is a read-side rule, not a write: nothing is recorded, nothing is
 * abandoned. A task whose mission is still open always counts, whatever its
 * age — mission completion still needs the PR answered. Everything else
 * (no mission, or a mission that is itself terminal) stops counting once the
 * PR has been closed for CLOSED_PR_AGE_OUT_DAYS. History (the task's own
 * explain, get_pr, the PR scope view) is unaffected — only the "needs
 * attention" / waiting signal is suppressed.
 */

export const CLOSED_PR_AGE_OUT_DAYS = 14;

/** Mission statuses (MISSION_STATUSES in @buildd/shared) that no longer need anything answered for them. */
const MISSION_TERMINAL_STATUSES = new Set(['completed', 'archived']);

/**
 * Whether a closed-unmerged PR should stop counting toward explain's waiting
 * surfaces. True = age out (exclude). False = still counts.
 */
export function closedPrAgedOutOfExplain(input: {
  /** The task's mission, or null when it has none. */
  missionId: string | null;
  /** That mission's status, when it has one. */
  missionStatus?: string | null;
  /** When the PR closed. Absent/unparseable = never age out (nothing proves it's old). */
  closedAt: string | Date | null | undefined;
  now?: Date;
}): boolean {
  const missionOpen = !!input.missionId && !!input.missionStatus && !MISSION_TERMINAL_STATUSES.has(input.missionStatus);
  if (missionOpen) return false;

  if (!input.closedAt) return false;
  const closedAtMs = new Date(input.closedAt).getTime();
  if (!Number.isFinite(closedAtMs)) return false;

  const nowMs = (input.now ?? new Date()).getTime();
  const ageDays = (nowMs - closedAtMs) / (1000 * 60 * 60 * 24);
  return ageDays >= CLOSED_PR_AGE_OUT_DAYS;
}
