import { describe, expect, it } from 'bun:test';
import { humanPickableRoles, isSystemRoleSlug } from '@buildd/shared';
import { missionVisualReviewHref, systemRoleIntent, VISUAL_REVIEW_IS_MISSION_SCOPED } from './system-role-intent';

describe('system roles in generic task creation', () => {
  it('the visual auditor is a system role; ordinary roles are not', () => {
    expect(isSystemRoleSlug('visual-auditor')).toBe(true);
    expect(isSystemRoleSlug('builder')).toBe(false);
    expect(isSystemRoleSlug(null)).toBe(false);
  });

  it('generic pickers drop it', () => {
    const roles = [{ slug: 'builder' }, { slug: 'visual-auditor' }, { slug: 'researcher' }];
    expect(humanPickableRoles(roles).map(r => r.slug)).toEqual(['builder', 'researcher']);
  });
});

describe('systemRoleIntent', () => {
  it('ignores ordinary roles', () => {
    expect(systemRoleIntent({ roleSlug: 'builder', missionId: 'm-1' })).toBeNull();
    expect(systemRoleIntent({})).toBeNull();
  });

  it('with a mission: routes to that mission\'s Visual review', () => {
    expect(systemRoleIntent({ roleSlug: 'visual-auditor', missionId: 'm-1' }))
      .toEqual({ kind: 'mission', missionId: 'm-1', href: '/app/missions/m-1?visualReview=1' });
    expect(systemRoleIntent({ skillSlug: 'visual-auditor', missionId: 'm-1' })?.kind).toBe('mission');
    expect(missionVisualReviewHref('m-1')).not.toContain('/tasks/new');
  });

  it('without a mission: explains the mission scope, files nothing', () => {
    expect(systemRoleIntent({ roleSlug: 'visual-auditor', missionId: '' })).toEqual({ kind: 'no_mission' });
    expect(VISUAL_REVIEW_IS_MISSION_SCOPED).toContain('belongs to a mission');
    expect(VISUAL_REVIEW_IS_MISSION_SCOPED).toContain('No task was created');
  });
});
