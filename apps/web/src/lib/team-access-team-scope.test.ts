import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Team-scoped access: a workspace's `accessMode: 'open'` widens access to the
// members and accounts of the workspace's OWN team, never to other teams; and
// the admin-scope helpers only ever return teams where the caller holds
// admin/owner (or, for an API key, the key's own team at admin level).

const mockWorkspacesFindFirst = mock(() => null as any);
const mockTeamMembersFindFirst = mock(() => null as any);
const mockTeamMembersFindMany = mock(() => [] as any[]);
const mockTeamsFindFirst = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockAccountWorkspacesFindFirst = mock(() => null as any);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      teamMembers: { findFirst: mockTeamMembersFindFirst, findMany: mockTeamMembersFindMany },
      teams: { findFirst: mockTeamsFindFirst },
      accounts: { findFirst: mockAccountsFindFirst },
      accountWorkspaces: { findFirst: mockAccountWorkspacesFindFirst },
    },
  },
}));

const {
  verifyWorkspaceAccess,
  verifyAccountWorkspaceAccess,
  getUserAdminTeamIds,
  getCallerAdminTeamIds,
  canCallerAdminTeam,
} = await import('./team-access');

beforeEach(() => {
  for (const m of [
    mockWorkspacesFindFirst, mockTeamMembersFindFirst, mockTeamMembersFindMany,
    mockTeamsFindFirst, mockAccountsFindFirst, mockAccountWorkspacesFindFirst,
  ]) m.mockReset();
  mockTeamMembersFindMany.mockResolvedValue([]);
  mockTeamsFindFirst.mockResolvedValue(null);
});

describe('verifyWorkspaceAccess — open workspaces', () => {
  it('denies a signed-in user who is not a member of the owning team', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-a', accessMode: 'open' });
    mockTeamMembersFindFirst.mockResolvedValue(null);
    expect(await verifyWorkspaceAccess('user-other', 'ws-open-1')).toBeNull();
  });

  it('allows a member of the owning team', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-a', accessMode: 'open' });
    mockTeamMembersFindFirst.mockResolvedValue({ role: 'member' });
    expect(await verifyWorkspaceAccess('user-member', 'ws-open-2')).toEqual({ teamId: 'team-a', role: 'member' });
  });
});

describe('verifyAccountWorkspaceAccess — open workspaces', () => {
  it('allows an account from the owning team without an explicit link', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-a', accessMode: 'open' });
    mockAccountsFindFirst.mockResolvedValue({ teamId: 'team-a' });
    expect(await verifyAccountWorkspaceAccess('acct-same', 'ws-open-a1')).toBe(true);
  });

  it('denies an account from another team that has no explicit link', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-a', accessMode: 'open' });
    mockAccountsFindFirst.mockResolvedValue({ teamId: 'team-b' });
    mockAccountWorkspacesFindFirst.mockResolvedValue(null);
    expect(await verifyAccountWorkspaceAccess('acct-other', 'ws-open-a2')).toBe(false);
  });

  it('still honours an explicit accountWorkspaces link for another team', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-a', accessMode: 'open' });
    mockAccountsFindFirst.mockResolvedValue({ teamId: 'team-b' });
    mockAccountWorkspacesFindFirst.mockResolvedValue({ canClaim: true, canCreate: true });
    expect(await verifyAccountWorkspaceAccess('acct-linked', 'ws-open-a3', 'canClaim')).toBe(true);
  });
});

describe('getUserAdminTeamIds', () => {
  it('returns only teams where the user is admin or owner, plus their personal team', async () => {
    mockTeamMembersFindMany.mockResolvedValue([
      { teamId: 'team-owner', role: 'owner' },
      { teamId: 'team-admin', role: 'admin' },
      { teamId: 'team-member', role: 'member' },
    ]);
    mockTeamsFindFirst.mockResolvedValue({ id: 'team-personal' });
    const ids = await getUserAdminTeamIds('user-admin-scope');
    expect(ids.sort()).toEqual(['team-admin', 'team-owner', 'team-personal']);
  });
});

describe('getCallerAdminTeamIds / canCallerAdminTeam', () => {
  it('an admin-level key administers only its own team', async () => {
    const caller = { kind: 'account' as const, accountId: 'a1', teamId: 'team-k', level: 'admin' };
    expect(await getCallerAdminTeamIds(caller)).toEqual(['team-k']);
    expect(await canCallerAdminTeam(caller, 'team-k')).toBe(true);
    expect(await canCallerAdminTeam(caller, 'team-x')).toBe(false);
  });

  it('a worker-level key administers nothing', async () => {
    const caller = { kind: 'account' as const, accountId: 'a2', teamId: 'team-k', level: 'worker' };
    expect(await getCallerAdminTeamIds(caller)).toEqual([]);
    expect(await canCallerAdminTeam(caller, 'team-k')).toBe(false);
  });

  it('a session member of a team cannot administer it', async () => {
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'team-m', role: 'member' }]);
    const caller = { kind: 'user' as const, userId: 'user-member-only' };
    expect(await canCallerAdminTeam(caller, 'team-m')).toBe(false);
  });
});
