/**
 * `?state=team-members&viewer=owner|admin|member`: TeamDetailClient (the
 * /app/teams/[id] page) with an owner, an admin and a member, seen as each.
 * The visual QA account is the sole owner of a team of one, so the role
 * select, Remove, Transfer ownership and the admin-vs-member gating never
 * render for it. Every id here passes isQaFixtureMemberId, so the member
 * handlers return before any request.
 */
import { roleHas } from '@/lib/permission-registry';
import { TEAM_MEMBERS_FIXTURE_STATE } from './visual-review-fixtures';

export const TEAM_MEMBERS_FIXTURE_VIEWERS = ['owner', 'admin', 'member'] as const;
export type TeamMembersFixtureViewer = (typeof TEAM_MEMBERS_FIXTURE_VIEWERS)[number];

const TEAM = {
  id: 'qa-fixture-team',
  name: 'Acme Robotics',
  slug: 'acme-robotics',
  createdAt: '2026-01-15T12:00:00.000Z',
};

const MEMBERS = [
  { userId: 'qa-fixture-owner', role: 'owner', joinedAt: '2026-01-15T12:00:00.000Z', name: 'Olivia Owner', email: 'olivia@example.com', image: null },
  { userId: 'qa-fixture-admin', role: 'admin', joinedAt: '2026-02-03T12:00:00.000Z', name: 'Adrian Admin', email: 'adrian.admin.with-a-long-address@example.com', image: null },
  { userId: 'qa-fixture-member', role: 'member', joinedAt: '2026-03-21T12:00:00.000Z', name: null, email: 'member@example.com', image: null },
] as const;

export function parseTeamMembersViewer(q: URLSearchParams): TeamMembersFixtureViewer {
  const v = q.get('viewer');
  return (TEAM_MEMBERS_FIXTURE_VIEWERS as readonly string[]).includes(v ?? '') ? (v as TeamMembersFixtureViewer) : 'owner';
}

export function teamMembersFixtureLinks(): Array<{ label: string; href: string }> {
  return TEAM_MEMBERS_FIXTURE_VIEWERS.map((v) => ({
    label: `as ${v}`,
    href: `?state=${TEAM_MEMBERS_FIXTURE_STATE}&viewer=${v}`,
  }));
}

/** TeamDetailClient's props for `viewer`, gated the way teams/[id]/page.tsx gates them (no overrides). */
export function teamMembersFixtureProps(viewer: TeamMembersFixtureViewer) {
  const me = MEMBERS.find((m) => m.role === viewer)!;
  return {
    team: TEAM,
    members: MEMBERS.map((m) => ({ ...m })),
    currentUserRole: viewer,
    currentUserId: me.userId,
    isPersonal: false,
    canManage: roleHas(viewer, 'manage_team_members', null),
    permissionOverrides: null,
  };
}
