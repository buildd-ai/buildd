/**
 * Mission pacing and concurrency gate helpers.
 *
 * Pacing shape: rate (max N task starts per hour). Each mission stores
 * lastTaskStartedAt; a new claim is blocked if the elapsed time since the
 * last start is less than 3600/maxPerHour seconds.  Defaults to 1/hr when
 * pacingMaxPerHour is null on a paced mission.
 */

export type MissionPacingInput = {
  pacingMode: 'eager' | 'paced';
  pacingMaxPerHour: number | null;
  lastTaskStartedAt: Date | null;
};

export type PacingBlock = {
  reason: 'pacing_rate';
  nextEligibleAt: Date;
  intervalSec: number;
  elapsedSec: number;
};

/**
 * Returns null if the mission may start a new task now, or a PacingBlock
 * describing when the next start is eligible.
 */
export function checkMissionPacingGate(
  mission: MissionPacingInput,
  now: Date,
): PacingBlock | null {
  if (mission.pacingMode !== 'paced') return null;
  if (!mission.lastTaskStartedAt) return null; // first task ever — always allowed

  const maxPerHour = mission.pacingMaxPerHour ?? 1;
  const intervalSec = 3600 / maxPerHour;
  const elapsedSec = (now.getTime() - mission.lastTaskStartedAt.getTime()) / 1000;

  if (elapsedSec >= intervalSec) return null;

  return {
    reason: 'pacing_rate',
    nextEligibleAt: new Date(mission.lastTaskStartedAt.getTime() + intervalSec * 1000),
    intervalSec,
    elapsedSec,
  };
}

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
