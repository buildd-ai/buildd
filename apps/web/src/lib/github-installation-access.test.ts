import { describe, it, expect, beforeEach, mock } from 'bun:test';

// What a user may do with an installation, given its owning teams.

let workspacesByCall: Array<Array<{ teamId: string }>> = [];
const userTeams: Record<string, string[]> = {};
const adminTeams: Record<string, string[]> = {};

// Each test has one caller, so every listed team is theirs: admin where
// adminTeams lists it, member otherwise.
function callerMemberships() {
  const admin = new Set(Object.values(adminTeams).flat());
  const all = new Set([...Object.values(userTeams).flat(), ...admin]);
  return [...all].map(teamId => ({ teamId, role: admin.has(teamId) ? 'admin' : 'member' }));
}

mock.module('@buildd/core/db', () => ({
  db: {
    // getInstallationOwnerTeamIds: the owning teams, here the first workspace list's teams.
    execute: async () => ({
      rows: [...new Set((workspacesByCall.shift() ?? []).map(w => w.teamId))].map(team_id => ({ team_id })),
    }),
    query: {
      workspaces: { findMany: async () => workspacesByCall.shift() ?? [] },
      teamMembers: { findMany: async () => callerMemberships() },
      teams: { findFirst: async () => ({ id: 'not-a-personal-team' }) },
    },
  },
}));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async (u: string) => userTeams[u] ?? [],
}));

const { getInstallationAccessForUser } = await import('./github-installation-access');

beforeEach(() => {
  workspacesByCall = [];
  for (const k of Object.keys(userTeams)) delete userTeams[k];
  for (const k of Object.keys(adminTeams)) delete adminTeams[k];
 
});

// getInstallationOwnerTeamIds is one SQL read; its rule is pinned on real Postgres in
// tests/db/team-installation-ownership.test.ts, against installationBelongsToTeam.

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
