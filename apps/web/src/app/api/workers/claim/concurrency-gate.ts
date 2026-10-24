/**
 * Mission concurrency gate: the only per-work parallelism setting.
 * missions.maxConcurrentTasks bounds how many of a mission's tasks run at once.
 */

export type ConcurrencyBlock = {
  reason: 'mission_concurrency';
  cap: number;
  active: number;
};

/**
 * Returns null if the mission can accept a new concurrent task, or a
 * ConcurrencyBlock if it is already at its cap.
 *
 * @param cap   missions.maxConcurrentTasks (null means no limit)
 * @param active number of workers currently active on tasks in this mission
 */
export function checkMissionConcurrencyGate(
  cap: number | null,
  active: number,
): ConcurrencyBlock | null {
  if (cap === null) return null;
  if (active < cap) return null;
  return { reason: 'mission_concurrency', cap, active };
}
