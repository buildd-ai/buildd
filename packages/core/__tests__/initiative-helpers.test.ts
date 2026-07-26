import { describe, it, expect } from 'bun:test';
import {
  computeInitiativeProgress,
  computeInitiativeSegments,
  crossedMilestone,
  type ChildMissionProgress,
  type MissionSegment,
} from '../mission-helpers';

function child(
  status: ChildMissionProgress['status'],
  totalTasks: number,
  completedTasks: number,
): ChildMissionProgress {
  return { status, totalTasks, completedTasks };
}

describe('computeInitiativeProgress', () => {
  it('returns an empty rollup for an initiative with no missions (no NaN)', () => {
    const r = computeInitiativeProgress([]);
    expect(r.totalMissions).toBe(0);
    expect(r.completedMissions).toBe(0);
    expect(r.totalTasks).toBe(0);
    expect(r.completedTasks).toBe(0);
    expect(r.progress).toBe(0);
    expect(r.status).toBe('empty');
  });

  it('is task-weighted across child missions', () => {
    // Mission A: 3/4 done, Mission B: 1/4 done → 4/8 = 50%
    const r = computeInitiativeProgress([child('active', 4, 3), child('active', 4, 1)]);
    expect(r.totalTasks).toBe(8);
    expect(r.completedTasks).toBe(4);
    expect(r.progress).toBe(50);
    expect(r.status).toBe('active');
  });

  it('rounds task-weighted progress to the nearest integer', () => {
    // 2/3 → 67
    const r = computeInitiativeProgress([child('active', 3, 2)]);
    expect(r.progress).toBe(67);
  });

  it('rolls up to completed when every mission is completed', () => {
    const r = computeInitiativeProgress([child('completed', 2, 2), child('completed', 3, 3)]);
    expect(r.completedMissions).toBe(2);
    expect(r.progress).toBe(100);
    expect(r.status).toBe('completed');
  });

  it('treats archived missions as terminal (initiative completed)', () => {
    const r = computeInitiativeProgress([child('completed', 1, 1), child('archived', 0, 0)]);
    expect(r.status).toBe('completed');
  });

  it('reports blocked when any child mission is budget_exhausted', () => {
    const r = computeInitiativeProgress([child('active', 2, 1), child('budget_exhausted', 2, 0)]);
    expect(r.status).toBe('blocked');
  });

  it('blocked takes precedence over active', () => {
    const r = computeInitiativeProgress([child('active', 4, 4), child('budget_exhausted', 1, 0)]);
    expect(r.status).toBe('blocked');
  });

  it('reports paused when missions exist but none are active/blocked and not all complete', () => {
    const r = computeInitiativeProgress([child('paused', 2, 1), child('paused', 2, 0)]);
    expect(r.status).toBe('paused');
  });

  it('active takes precedence over paused', () => {
    const r = computeInitiativeProgress([child('paused', 2, 0), child('active', 2, 1)]);
    expect(r.status).toBe('active');
  });

  it('falls back to mission-weighted progress when there are no countable tasks', () => {
    // 2 missions, both completed, zero deliverable tasks → 100% via mission weighting
    const r = computeInitiativeProgress([child('completed', 0, 0), child('completed', 0, 0)]);
    expect(r.totalTasks).toBe(0);
    expect(r.progress).toBe(100);
    expect(r.status).toBe('completed');
  });

  it('mission-weighted fallback: 1 of 2 missions complete, no tasks → 50%', () => {
    const r = computeInitiativeProgress([child('completed', 0, 0), child('active', 0, 0)]);
    expect(r.progress).toBe(50);
    expect(r.status).toBe('active');
  });

  it('counts completedMissions by mission status, not task completion', () => {
    // A mission with all tasks done but status still active is NOT a completed mission
    const r = computeInitiativeProgress([child('active', 2, 2), child('completed', 2, 2)]);
    expect(r.completedMissions).toBe(1);
    expect(r.status).toBe('active');
  });
});

describe('computeInitiativeSegments', () => {
  const seg = (taskId: string, state: MissionSegment['state']): MissionSegment => ({ taskId, state });

  it('returns an empty run for an initiative with no missions', () => {
    expect(computeInitiativeSegments([])).toEqual([]);
  });

  it('returns an empty run when every child has no segments', () => {
    expect(computeInitiativeSegments([{ segments: [] }, {}])).toEqual([]);
  });

  it('concatenates child segments in child order, preserving each task key', () => {
    const a = { segments: [seg('a1', 'solid'), seg('a2', 'ghost')] };
    const b = { segments: [seg('b1', 'empty')] };
    expect(computeInitiativeSegments([a, b])).toEqual([
      seg('a1', 'solid'),
      seg('a2', 'ghost'),
      seg('b1', 'empty'),
    ]);
  });

  it('tolerates a child with an undefined segments field', () => {
    const a = { segments: [seg('a1', 'notch')] };
    expect(computeInitiativeSegments([a, {}])).toEqual([seg('a1', 'notch')]);
  });
});

describe('crossedMilestone', () => {
  it('returns the highest threshold crossed prev→curr', () => {
    expect(crossedMilestone(68, 82)).toBe(75); // crosses 75, not 90
    expect(crossedMilestone(48, 52)).toBe(50);
    expect(crossedMilestone(0, 100)).toBe(100); // highest of many crossed
    expect(crossedMilestone(76, 95)).toBe(90);
  });

  it('returns null when nothing is crossed', () => {
    expect(crossedMilestone(10, 20)).toBeNull(); // no threshold in (10,20]
    expect(crossedMilestone(75, 80)).toBeNull(); // 90 not yet reached
  });

  it('never fires on a non-increase (stalled or regressed)', () => {
    expect(crossedMilestone(50, 50)).toBeNull();
    expect(crossedMilestone(90, 40)).toBeNull();
  });

  it('treats the threshold as inclusive on curr, exclusive on prev', () => {
    expect(crossedMilestone(49, 50)).toBe(50); // reaches exactly 50
    expect(crossedMilestone(50, 74)).toBeNull(); // already past 50, not yet 75
  });
});
