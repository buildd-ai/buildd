import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Installation ownership is derived from (a) teams with workspaces on an
// installation of the same GitHub account and (b) the installer's teams.

let installation: Record<string, unknown> | null = null;
let sameAccount: Array<{ id: string }> = [];
let workspacesByCall: Array<Array<{ teamId: string }>> = [];
const userTeams: Record<string, string[]> = {};
const adminTeams: Record<string, string[]> = {};

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      githubInstallations: {
        findFirst: async () => installation,
        findMany: async () => sameAccount,
      },
      workspaces: { findMany: async () => workspacesByCall.shift() ?? [] },
    },
  },
}));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async (u: string) => userTeams[u] ?? [],
  getUserAdminTeamIds: async (u: string) => adminTeams[u] ?? [],
}));

const { getInstallationOwnerTeamIds, getInstallationAccessForUser } = await import('./github-installation-access');

beforeEach(() => {
  installation = { id: 'inst-1', accountId: 42, installedByUserId: null };
  sameAccount = [{ id: 'inst-1' }, { id: 'inst-old' }];
  workspacesByCall = [];
  for (const k of Object.keys(userTeams)) delete userTeams[k];
  for (const k of Object.keys(adminTeams)) delete adminTeams[k];
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
