import { describe, expect, it } from 'bun:test';
import { MISSION_START_COPY, armedAtForStartGate, missionStartCopy, missionStartState } from './mission-start-state';

const T0 = new Date('2026-10-01T00:00:00Z');
const NOW = new Date('2026-10-17T00:00:00Z');

describe('missionStartState', () => {
  it('an open gate has no start state', () => {
    expect(missionStartState({ isHeld: false, armedAt: null })).toBeNull();
    expect(missionStartState({ isHeld: false, armedAt: T0 })).toBeNull();
  });

  it('held and never released reads Not started', () => {
    expect(missionStartState({ isHeld: true, armedAt: null })).toBe('not_started');
    expect(missionStartCopy({ isHeld: true, armedAt: null })?.label).toBe('Not started');
  });

  it('held after it was released reads Paused', () => {
    expect(missionStartState({ isHeld: true, armedAt: T0.toISOString() })).toBe('paused');
    expect(missionStartCopy({ isHeld: true, armedAt: T0 })?.label).toBe('Paused');
  });
});

describe('MISSION_START_COPY', () => {
  const all = Object.values(MISSION_START_COPY).flatMap(c => Object.values(c));

  it('never says held, arm, force or approval', () => {
    for (const s of all) expect(s).not.toMatch(/\bheld\b|\bhold\b|\barm(ed|ing)?\b|force|approv/i);
  });

  it('labels fit a phone chip', () => {
    for (const c of Object.values(MISSION_START_COPY)) expect(c.label.length).toBeLessThanOrEqual(12);
  });

  it('a task in a not-started mission says so once and offers Start task', () => {
    const c = MISSION_START_COPY.not_started;
    expect(c.taskTitle).toBe('Mission not started');
    expect(c.taskReason).toBe('Start the mission to make its tasks available, or start this task on its own.');
    expect(c.taskReason).not.toContain(c.taskTitle);
    expect(c.taskAction).toBe('Start task');
  });

  it('a paused mission resumes rather than starts', () => {
    expect(MISSION_START_COPY.paused.action).toBe('Resume mission');
    expect(MISSION_START_COPY.paused.taskTitle).toBe('Mission paused');
  });
});

describe('armedAtForStartGate', () => {
  it('creating armed stamps now; creating held leaves it null', () => {
    expect(armedAtForStartGate(null, false, NOW)).toEqual(NOW);
    expect(armedAtForStartGate(null, true, NOW)).toBeUndefined();
  });

  it('releasing a never-started mission stamps now', () => {
    expect(armedAtForStartGate({ isHeld: true, armedAt: null, createdAt: T0 }, false, NOW)).toEqual(NOW);
  });

  it('holding a mission that has run stamps its release, so it reads Paused', () => {
    const at = armedAtForStartGate({ isHeld: false, armedAt: null, createdAt: T0 }, true, NOW);
    expect(at).toEqual(T0);
    expect(missionStartState({ isHeld: true, armedAt: at ?? null })).toBe('paused');
  });

  it('a recorded release is never moved', () => {
    expect(armedAtForStartGate({ isHeld: true, armedAt: T0, createdAt: T0 }, false, NOW)).toBeUndefined();
    expect(armedAtForStartGate({ isHeld: false, armedAt: T0, createdAt: T0 }, true, NOW)).toBeUndefined();
  });
});
