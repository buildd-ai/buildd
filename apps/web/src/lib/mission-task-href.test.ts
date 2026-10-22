import { describe, expect, it } from 'bun:test';
import { legacyTaskSheetRedirect, missionTaskAnchorId, missionTaskHref, parseMissionOriginParams, parseMissionTaskHash, taskAnswerHref, taskPageHref } from './mission-task-href';

describe('missionTaskHref', () => {
  it('a task link is the task page, never the mission with ?task= (spec d25d923d R-1)', () => {
    expect(missionTaskHref({ missionId: 'm1', taskId: 't1' })).toBe('/app/tasks/t1');
    expect(missionTaskHref({ missionId: 'm1', taskId: 't1', from: 'home' })).toBe('/app/tasks/t1?from=home');
    expect(missionTaskHref({ missionId: 'm1', taskId: 't1', from: 'home' })).not.toContain('task=');
  });

  it('focus mode lands on the row via the #t- hash, with no task param', () => {
    expect(missionTaskHref({ missionId: 'm1', taskId: 't1', mode: 'focus' })).toBe('/app/missions/m1#t-t1');
    expect(missionTaskHref({ missionId: 'm1', taskId: 't1', from: 'missions', mode: 'focus' })).toBe('/app/missions/m1?from=missions#t-t1');
  });

  it('initiative origin carries initiativeId, so the back link returns inside the initiative', () => {
    expect(missionTaskHref({ missionId: 'm1', taskId: 't1', from: 'initiative', initiativeId: 'i1' }))
      .toBe('/app/tasks/t1?from=initiative&initiativeId=i1');
    expect(missionTaskHref({ missionId: 'm1', taskId: 't1', from: 'initiative', initiativeId: 'i1', mode: 'focus' }))
      .toBe('/app/missions/m1?from=initiative&initiativeId=i1#t-t1');
  });

  it('a task with no mission is its own page, with no back context', () => {
    expect(missionTaskHref({ missionId: null, taskId: 't1', from: 'home' })).toBe('/app/tasks/t1');
    expect(missionTaskHref({ missionId: null, taskId: 't1', mode: 'focus' })).toBe('/app/tasks/t1');
  });

  it('never emits the retired ?tab= param', () => {
    expect(missionTaskHref({ missionId: 'm1', taskId: 't1' })).not.toContain('tab=');
  });

  it('encodes ids', () => {
    expect(missionTaskHref({ missionId: 'm 1', taskId: 't/1' })).toBe('/app/tasks/t%2F1');
    expect(missionTaskHref({ missionId: 'm 1', taskId: 't/1', mode: 'focus' })).toBe('/app/missions/m%201#t-t%2F1');
  });
});

describe('parseMissionOriginParams', () => {
  it('keeps a known origin, and an initiative id only with the initiative origin', () => {
    expect(parseMissionOriginParams({ from: 'home' })).toEqual({ from: 'home', initiativeId: null });
    expect(parseMissionOriginParams({ from: 'initiative', initiativeId: 'i1' })).toEqual({ from: 'initiative', initiativeId: 'i1' });
    expect(parseMissionOriginParams({ from: 'missions', initiativeId: 'i1' })).toEqual({ from: 'missions', initiativeId: null });
  });

  it('drops anything else: the old from=mission, a stray value, an array', () => {
    expect(parseMissionOriginParams({ from: 'mission' })).toEqual({ from: null, initiativeId: null });
    expect(parseMissionOriginParams({ from: 'x' })).toEqual({ from: null, initiativeId: null });
    expect(parseMissionOriginParams({ from: ['home'] })).toEqual({ from: null, initiativeId: null });
    expect(parseMissionOriginParams({})).toEqual({ from: null, initiativeId: null });
  });
});

describe('taskPageHref', () => {
  it('full page for a mission task carries the mission back-link context', () => {
    expect(taskPageHref({ taskId: 't1', missionId: 'm1' })).toBe('/app/tasks/t1?from=mission&missionId=m1');
    expect(taskPageHref({ taskId: 't1' })).toBe('/app/tasks/t1');
  });
});

// An answer link lands on the full answering experience (the task page's
// question, its options and its own-words box, focused), whatever mission
// the task belongs to.
describe('taskAnswerHref', () => {
  it('is the task page with the answer focused, keeping the mission back-link', () => {
    expect(taskAnswerHref({ taskId: 't1', missionId: 'm1' })).toBe('/app/tasks/t1?from=mission&missionId=m1&respond=1');
    expect(taskAnswerHref({ taskId: 't1' })).toBe('/app/tasks/t1?respond=1');
    expect(taskAnswerHref({ taskId: 't1', missionId: null })).toBe('/app/tasks/t1?respond=1');
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

// Spec d25d923d R-2, AC-2: the retired task sheet's URL lands on the task page.
describe('legacyTaskSheetRedirect', () => {
  const T = '0b4f6f9e-3c1a-4c62-9a7e-1f0d2c3b4a5d';
  const I = '7d2e9c41-8b3a-4f6e-a1c2-5e4d3c2b1a09';

  it('?task=T goes to /app/tasks/T', () => {
    expect(legacyTaskSheetRedirect('m1', { task: T })).toBe(`/app/tasks/${T}`);
  });

  it('keeps the back context: from, and an initiative id with the initiative origin', () => {
    expect(legacyTaskSheetRedirect('m1', { task: T, from: 'home' })).toBe(`/app/tasks/${T}?from=home`);
    expect(legacyTaskSheetRedirect('m1', { task: T, from: 'initiative', initiativeId: I }))
      .toBe(`/app/tasks/${T}?from=initiative&initiativeId=${I}`);
  });

  it('carries respond=1; a mission artifact param stays behind', () => {
    expect(legacyTaskSheetRedirect('m1', { task: T, respond: '1' })).toBe(`/app/tasks/${T}?respond=1`);
    expect(legacyTaskSheetRedirect('m1', { task: T, from: 'home', respond: '1' })).toBe(`/app/tasks/${T}?from=home&respond=1`);
  });

  it('no task, or one that is not a task id: no redirect, the mission page renders', () => {
    expect(legacyTaskSheetRedirect('m1', {})).toBeNull();
    expect(legacyTaskSheetRedirect('m1', { task: 'nope' })).toBeNull();
    expect(legacyTaskSheetRedirect('m1', { task: [T, T] })).toBeNull();
  });
});
