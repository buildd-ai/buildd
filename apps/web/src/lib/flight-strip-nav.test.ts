import { describe, expect, it } from 'bun:test';
import { groupTasksByPhase, selectMissionRecords } from './flight-strip-nav';

describe('groupTasksByPhase', () => {
  it('stays ungrouped when no task carries a stored phase (Rule X-3/X-4)', () => {
    const tasks = [{ id: 'a' }, { id: 'b', missionPhaseIndex: null, missionPhaseLabel: null }];
    const groups = groupTasksByPhase(tasks);
    expect(groups).toHaveLength(1);
    expect(groups[0].index).toBeNull();
    expect(groups[0].tasks.map(t => t.id)).toEqual(['a', 'b']);
  });

  it('groups by phase index, in ascending order, with an unphased trailing group', () => {
    const tasks = [
      { id: 'spec', missionPhaseIndex: 0, missionPhaseLabel: 'Spec' },
      { id: 'build1', missionPhaseIndex: 1, missionPhaseLabel: 'Implementation' },
      { id: 'build2', missionPhaseIndex: 1, missionPhaseLabel: 'Implementation' },
      { id: 'loose', missionPhaseIndex: null, missionPhaseLabel: null },
    ];
    const groups = groupTasksByPhase(tasks);
    expect(groups.map(g => g.index)).toEqual([0, 1, null]);
    expect(groups[1].tasks.map(t => t.id)).toEqual(['build1', 'build2']);
    expect(groups[2].tasks.map(t => t.id)).toEqual(['loose']);
  });
});

describe('selectMissionRecords', () => {
  it('excludes capture-type artifacts (AC-15)', () => {
    const artifacts = [
      { type: 'screenshot' },
      { type: 'diff' },
      { type: 'recording' },
    ];
    expect(selectMissionRecords(artifacts)).toEqual([]);
  });

  it('includes review-shaped artifacts', () => {
    const artifacts = [
      { type: 'screenshot' },
      { type: 'report' },
      { type: 'summary' },
    ];
    const result = selectMissionRecords(artifacts);
    expect(result.map(a => a.type)).toEqual(['report', 'summary']);
  });
});
