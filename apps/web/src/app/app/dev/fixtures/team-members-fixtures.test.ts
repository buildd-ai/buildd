import { describe, expect, it } from 'bun:test';
import { isQaFixtureMemberId } from '../../(protected)/settings/team/qa-state';
import { FIXTURE_VIEWS, TEAM_MEMBERS_FIXTURE_STATE, isFixtureView } from './visual-review-fixtures';
import {
  TEAM_MEMBERS_FIXTURE_VIEWERS,
  parseTeamMembersViewer,
  teamMembersFixtureLinks,
  teamMembersFixtureProps,
} from './team-members-fixtures';

/**
 * `?state=team-members&viewer=owner|admin|member`: the team detail page's
 * member list (owner, admin, member) seen by each role, for the visual audit,
 * whose QA account is the sole owner of a team of one.
 */

describe('team-members fixture', () => {
  it('is a fixtures page state', () => {
    expect(FIXTURE_VIEWS).toContain(TEAM_MEMBERS_FIXTURE_STATE);
    expect(isFixtureView(TEAM_MEMBERS_FIXTURE_STATE)).toBe(true);
  });

  it('parses the viewer, defaulting to owner', () => {
    expect(parseTeamMembersViewer(new URLSearchParams('viewer=admin'))).toBe('admin');
    expect(parseTeamMembersViewer(new URLSearchParams('viewer=member'))).toBe('member');
    expect(parseTeamMembersViewer(new URLSearchParams(''))).toBe('owner');
    expect(parseTeamMembersViewer(new URLSearchParams('viewer=root'))).toBe('owner');
  });

  it('links every viewer', () => {
    expect(teamMembersFixtureLinks().map((l) => l.href)).toEqual(
      TEAM_MEMBERS_FIXTURE_VIEWERS.map((v) => `?state=${TEAM_MEMBERS_FIXTURE_STATE}&viewer=${v}`),
    );
  });

  for (const viewer of TEAM_MEMBERS_FIXTURE_VIEWERS) {
    it(`${viewer}: one row per role, the viewer is the matching row`, () => {
      const props = teamMembersFixtureProps(viewer);
      expect(props.members.map((m) => m.role).sort()).toEqual(['admin', 'member', 'owner']);
      expect(props.currentUserRole).toBe(viewer);
      const me = props.members.find((m) => m.userId === props.currentUserId);
      expect(me?.role).toBe(viewer);
      // Not personal, so Transfer ownership and Leave team render.
      expect(props.isPersonal).toBe(false);
    });
  }

  it('gates management on the viewer role like the real page', () => {
    expect(teamMembersFixtureProps('owner').canManage).toBe(true);
    expect(teamMembersFixtureProps('admin').canManage).toBe(true);
    expect(teamMembersFixtureProps('member').canManage).toBe(false);
  });

  it('uses only ids TeamDetailClient never writes for', () => {
    for (const viewer of TEAM_MEMBERS_FIXTURE_VIEWERS) {
      const props = teamMembersFixtureProps(viewer);
      expect(isQaFixtureMemberId(props.currentUserId)).toBe(true);
      for (const m of props.members) {
        expect(isQaFixtureMemberId(m.userId)).toBe(true);
        expect(m.email.endsWith('@example.com')).toBe(true);
      }
    }
  });
});

describe('isQaFixtureMemberId', () => {
  it('matches fixture ids only', () => {
    expect(isQaFixtureMemberId('qa-fixture-member')).toBe(true);
    expect(isQaFixtureMemberId('qa-fixture-admin')).toBe(true);
    expect(isQaFixtureMemberId('user-1')).toBe(false);
    expect(isQaFixtureMemberId('x-qa-fixture-member')).toBe(false);
    expect(isQaFixtureMemberId('')).toBe(false);
  });
});
