/**
 * @ui-copy
 *
 * What a mission's start gate (`missions.isHeld`) means to a person, and the
 * one set of words every surface uses for it. `isHeld` stays the internal
 * claim gate; "held" is never shown. A held mission is one of two things:
 *
 * - Not started: the gate was never released (`armedAt` null).
 * - Paused: it was released once and someone held it again (`armedAt` set).
 *
 * Neither means approval is needed: the gate is lifted by starting (or
 * resuming) the mission, and a single task may still be started on its own.
 */

export type MissionStartState = 'not_started' | 'paused';

export interface MissionStartFacts {
  isHeld: boolean;
  /** `missions.armedAt`: when the start gate was first released. */
  armedAt: Date | string | null;
}

/** Null when the gate is open: the mission's tasks are available to runners. */
export function missionStartState(m: MissionStartFacts): MissionStartState | null {
  if (!m.isHeld) return null;
  return m.armedAt ? 'paused' : 'not_started';
}

export interface MissionStartCopy {
  /** The state's name on a chip, pill or list status. */
  label: string;
  /** The mission header's one line: what it waits on, and what lifts it. */
  waitingLine: string;
  /** The mission's primary action, and its pending form. */
  action: string;
  actionPending: string;
  /** A task in this mission, refused at Start: title and the line under it. */
  taskTitle: string;
  taskReason: string;
  /** A Start that lifts the gate for this one task. */
  taskAction: string;
  /** "Starts when …". */
  releasesWhen: string;
}

export const MISSION_START_COPY: Readonly<Record<MissionStartState, MissionStartCopy>> = {
  not_started: {
    label: 'Not started',
    waitingLine: 'Not started. Its tasks are available once you start it.',
    action: 'Start mission',
    actionPending: 'Starting…',
    taskTitle: 'Mission not started',
    taskReason: 'Start the mission to make its tasks available, or start this task on its own.',
    taskAction: 'Start task',
    releasesWhen: 'the mission starts',
  },
  paused: {
    label: 'Paused',
    waitingLine: 'Paused. Its tasks are available again once you resume it.',
    action: 'Resume mission',
    actionPending: 'Resuming…',
    taskTitle: 'Mission paused',
    taskReason: 'Resume the mission to make its tasks available, or start this task on its own.',
    taskAction: 'Start task',
    releasesWhen: 'the mission resumes',
  },
};

/** The copy for a held mission's start state. */
export function missionStartCopy(m: MissionStartFacts): MissionStartCopy | null {
  const state = missionStartState(m);
  return state ? MISSION_START_COPY[state] : null;
}

/**
 * The `armedAt` a write must set when it changes the start gate, or undefined
 * to leave it. Releasing stamps the first release; holding a mission whose
 * gate is open (so it has run) stamps its creation when nothing recorded the
 * release, so it reads Paused rather than Not started.
 */
export function armedAtForStartGate(
  existing: { isHeld: boolean; armedAt: Date | null; createdAt: Date } | null,
  nextIsHeld: boolean,
  now: Date,
): Date | undefined {
  if (existing?.armedAt) return undefined;
  if (!nextIsHeld) return existing && !existing.isHeld ? existing.createdAt : now;
  return existing && !existing.isHeld ? existing.createdAt : undefined;
}
