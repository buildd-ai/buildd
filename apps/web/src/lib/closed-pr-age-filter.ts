/**
 * Filter for aging out old closed-unmerged PRs from explain surfaces.
 *
 * A closed-unmerged PR on a task that is terminal (status='completed',
 * 'cancelled', etc.) and belongs to no open mission is aged out after N days
 * (default 14). It remains visible in history but is excluded from:
 * - explain's waiting/attention subjects
 * - pr_closed_unmerged gate conditions for non-mission tasks
 *
 * This is a read-side rule: no database write is needed. Readers filter by
 * calling shouldIncludeClosedPrInExplain() before adding a subject.
 */

export const CLOSED_PR_AGE_OUT_DAYS = 14;

/**
 * Whether a closed-unmerged PR should be included in explain surfaces based on age.
 *
 * Returns true (include) when:
 * - The task is part of an open mission, OR
 * - The closed PR is less than CLOSED_PR_AGE_OUT_DAYS old
 *
 * Returns false (exclude/age-out) when:
 * - The task is not part of an open mission AND
 * - The PR closed >= CLOSED_PR_AGE_OUT_DAYS ago
 */
export function shouldIncludeClosedPrInExplain(input: {
  /** Task's missionId, or null if not part of a mission. */
  taskMissionId: string | null;
  /** Mission status (if taskMissionId is set): 'completed', 'running', etc. */
  missionStatus?: string | null;
  /** When the worker's PR closed (ISO string or Date). */
  prClosedAt: string | Date | null | undefined;
  /** Current time for age calculation. */
  now?: Date;
}): boolean {
  const now = input.now ?? new Date();

  // If the task is part of an open mission, always include it (mission completion
  // still needs the closed PR explained, regardless of age).
  // Only exclude from explain if the mission is terminal (completed, cancelled, etc.)
  const isInOpenMission = input.taskMissionId && input.missionStatus && !['completed', 'cancelled'].includes(input.missionStatus);
  if (isInOpenMission) return true;

  // For terminal/no-mission tasks, exclude if the PR is old enough.
  if (!input.prClosedAt) return true; // No close time = uncertain; include it
  const closedAt = new Date(input.prClosedAt).getTime();
  if (!Number.isFinite(closedAt)) return true; // Invalid date = uncertain; include it

  const ageMs = now.getTime() - closedAt;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays < CLOSED_PR_AGE_OUT_DAYS;
}
