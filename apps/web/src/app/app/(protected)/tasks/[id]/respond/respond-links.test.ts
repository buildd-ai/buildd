/**
 * AC-12 (docs/design/mission-feed-mobile-continuity.md W6): answering from the
 * respond page returns a mission task to its row on the mission, and the back
 * link names the mission rather than the workspace. Illustrative fixtures.
 */
import { describe, expect, it } from 'bun:test';
import { respondBackLink, respondRedirectHref } from './respond-links';

describe('respondRedirectHref', () => {
  it('a mission task returns to its row on the mission', () => {
    expect(respondRedirectHref({ missionId: 'm1', taskId: 't1' })).toBe('/app/missions/m1#t-t1');
  });

  it('a task outside any mission goes to its own page', () => {
    expect(respondRedirectHref({ missionId: null, taskId: 't1' })).toBe('/app/tasks/t1');
  });

  it('no task to go to (task-less worker) → null, so the form stays put', () => {
    expect(respondRedirectHref({ missionId: 'm1', taskId: null })).toBeNull();
  });
});

describe('respondBackLink', () => {
  it('names the mission and lands on the task row', () => {
    expect(respondBackLink({ taskId: 't1', mission: { id: 'm1', title: 'Claim loop hardening' }, workspaceName: 'acme' }))
      .toEqual({ href: '/app/missions/m1#t-t1', label: 'Claim loop hardening' });
  });

  it('falls back to the workspace name and the task page outside a mission', () => {
    expect(respondBackLink({ taskId: 't1', mission: null, workspaceName: 'acme' }))
      .toEqual({ href: '/app/tasks/t1', label: 'acme' });
  });
});
