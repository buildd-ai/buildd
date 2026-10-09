import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Installation ownership is derived from (a) teams with workspaces on an
// installation of the same GitHub account and (b) the installer's teams.

let installation: Record<string, unknown> | null = null;
let sameAccount: Array<{ id: string }> = [];
let workspacesByCall: Array<Array<{ teamId: string }>> = [];
const userTeams: Record<string, string[]> = {};
const adminTeams: Record<string, string[]> = {};
// The team's permission overrides, read by the real permission check.
let overrides: Record<string, unknown> | null = null;

// Each test has one caller, so every listed team is theirs: admin where
// adminTeams lists it, member otherwise.
function callerMemberships() {
  const admin = new Set(Object.values(adminTeams).flat());
  const all = new Set([...Object.values(userTeams).flat(), ...admin]);
  return [...all].map(teamId => ({ teamId, role: admin.has(teamId) ? 'admin' : 'member' }));
}

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      githubInstallations: {
        findFirst: async () => installation,
        findMany: async () => sameAccount,
      },
      workspaces: { findMany: async () => workspacesByCall.shift() ?? [] },
      teamMembers: { findMany: async () => callerMemberships() },
      teams: { findFirst: async () => ({ id: 'not-a-personal-team', permissionOverrides: overrides }) },
    },
  },
}));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async (u: string) => userTeams[u] ?? [],
}));

const { getInstallationOwnerTeamIds, getInstallationAccessForUser } = await import('./github-installation-access');

beforeEach(() => {
  installation = { id: 'inst-1', accountId: 42, installedByUserId: null };
  sameAccount = [{ id: 'inst-1' }, { id: 'inst-old' }];
  workspacesByCall = [];
  for (const k of Object.keys(userTeams)) delete userTeams[k];
  for (const k of Object.keys(adminTeams)) delete adminTeams[k];
  overrides = null;
});

describe('getInstallationOwnerTeamIds', () => {
  it('includes teams with workspaces on any installation of the same GitHub account', async () => {
    workspacesByCall = [[{ teamId: 'team-a' }, { teamId: 'team-a' }]];
    expect(await getInstallationOwnerTeamIds('inst-1')).toEqual(['team-a']);
  });

  it('includes the installer\'s teams', async () => {
    installation = { id: 'inst-1', accountId: 42, installedByUserId: 'user-installer' };
    userTeams['user-installer'] = ['team-i'];
    workspacesByCall = [[]];
    expect(await getInstallationOwnerTeamIds('inst-1')).toEqual(['team-i']);
  });

  it('is empty for an unknown installation', async () => {
    installation = null;
    expect(await getInstallationOwnerTeamIds('missing')).toEqual([]);
  });
});

describe('getInstallationAccessForUser', () => {
  it('a user in no owning team can neither view nor manage', async () => {
    userTeams['user-x'] = ['team-x'];
    workspacesByCall = [[{ teamId: 'team-a' }], [{ teamId: 'team-a' }]];
    const access = await getInstallationAccessForUser('user-x', { id: 'inst-1', installedByUserId: null });
    expect(access.canView).toBe(false);
    expect(access.canManage).toBe(false);
  });

  it('a member of an owning team can view but not manage', async () => {
    userTeams['user-m'] = ['team-a'];
    workspacesByCall = [[{ teamId: 'team-a' }], [{ teamId: 'team-a' }]];
    const access = await getInstallationAccessForUser('user-m', { id: 'inst-1', installedByUserId: null });
    expect(access.canView).toBe(true);
    expect(access.canManage).toBe(false);
  });

  it('an admin of an owning team can manage; other teams using it are reported', async () => {
    userTeams['user-a'] = ['team-a'];
    adminTeams['user-a'] = ['team-a'];
    workspacesByCall = [[{ teamId: 'team-a' }, { teamId: 'team-b' }], [{ teamId: 'team-a' }, { teamId: 'team-b' }]];
    const access = await getInstallationAccessForUser('user-a', { id: 'inst-1', installedByUserId: null });
    expect(access.canManage).toBe(true);
    expect(access.otherTeamsUsingIt).toEqual(['team-b']);
  });
});

describe('getInstallationAccessForUser honours the team permission overrides', () => {
  it('an admin of an owning team cannot manage once manage_github_installation is owner-only', async () => {
    userTeams['user-a'] = ['team-a'];
    adminTeams['user-a'] = ['team-a'];
    overrides = { manage_github_installation: ['owner'] };
    workspacesByCall = [[{ teamId: 'team-a' }], [{ teamId: 'team-a' }]];
    const access = await getInstallationAccessForUser('user-a', { id: 'inst-1', installedByUserId: null });
    expect(access.canView).toBe(true);
    expect(access.canManage).toBe(false);
    // Disconnecting is refused too: team-a now counts as a team they do not administer.
    expect(access.otherTeamsUsingIt).toEqual(['team-a']);
  });

  it('a member of an owning team can manage once manage_github_installation is granted to members', async () => {
    userTeams['user-m'] = ['team-a'];
    overrides = { manage_github_installation: ['owner', 'admin', 'member'] };
    workspacesByCall = [[{ teamId: 'team-a' }], [{ teamId: 'team-a' }]];
    const access = await getInstallationAccessForUser('user-m', { id: 'inst-1', installedByUserId: null });
    expect(access.canManage).toBe(true);
    expect(access.otherTeamsUsingIt).toEqual([]);
  });
});
