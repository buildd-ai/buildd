import { describe, expect, it } from 'bun:test';
import { missionTaskAnchorId, missionTaskHref, parseMissionTaskHash, taskPageHref } from './mission-task-href';

describe('missionTaskHref', () => {
  it('sheet mode opens the task sheet over the mission, carrying ?from=', () => {
    expect(missionTaskHref({ missionId: 'm1', taskId: 't1', from: 'home', mode: 'sheet' })).toBe('/app/missions/m1?from=home&task=t1');
    expect(missionTaskHref({ missionId: 'm1', taskId: 't1', mode: 'sheet' })).toBe('/app/missions/m1?task=t1');
  });

  it('focus mode lands on the row via the #t- hash, with no task param', () => {
    expect(missionTaskHref({ missionId: 'm1', taskId: 't1', mode: 'focus' })).toBe('/app/missions/m1#t-t1');
    expect(missionTaskHref({ missionId: 'm1', taskId: 't1', from: 'missions', mode: 'focus' })).toBe('/app/missions/m1?from=missions#t-t1');
  });

  it('initiative origin carries initiativeId for the breadcrumb', () => {
    expect(missionTaskHref({ missionId: 'm1', taskId: 't1', from: 'initiative', initiativeId: 'i1', mode: 'sheet' }))
      .toBe('/app/missions/m1?from=initiative&initiativeId=i1&task=t1');
  });

  it('a task with no mission falls back to its own page', () => {
    expect(missionTaskHref({ missionId: null, taskId: 't1', mode: 'sheet' })).toBe('/app/tasks/t1');
  });

  it('never emits the retired ?tab= param', () => {
    expect(missionTaskHref({ missionId: 'm1', taskId: 't1', mode: 'sheet' })).not.toContain('tab=');
  });

  it('encodes ids', () => {
    expect(missionTaskHref({ missionId: 'm 1', taskId: 't/1', mode: 'sheet' })).toBe('/app/missions/m%201?task=t%2F1');
  });
});

describe('taskPageHref', () => {
  it('full page for a mission task carries the mission back-link context', () => {
    expect(taskPageHref({ taskId: 't1', missionId: 'm1' })).toBe('/app/tasks/t1?from=mission&missionId=m1');
    expect(taskPageHref({ taskId: 't1' })).toBe('/app/tasks/t1');
  });
});

describe('row anchors', () => {
  it('round-trips the #t- anchor', () => {
    expect(missionTaskAnchorId('abc')).toBe('t-abc');
    expect(parseMissionTaskHash('#t-abc')).toBe('abc');
    expect(parseMissionTaskHash('t-abc')).toBe('abc');
    expect(parseMissionTaskHash('#mission-artifacts')).toBeNull();
    expect(parseMissionTaskHash('')).toBeNull();
  });

  it('returns null instead of throwing on a malformed percent-escape', () => {
    expect(() => parseMissionTaskHash('#t-%E0')).not.toThrow();
    expect(parseMissionTaskHash('#t-%E0')).toBeNull();
    expect(parseMissionTaskHash('#t-a%20b')).toBe('a b');
  });
});
