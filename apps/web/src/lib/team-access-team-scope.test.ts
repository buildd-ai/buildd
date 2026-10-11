import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Team-scoped access: a workspace's `accessMode: 'open'` widens access to the
// members and accounts of the workspace's OWN team, never to other teams.

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

const teamAccess = await import('./team-access');
const { verifyWorkspaceAccess, verifyAccountWorkspaceAccess } = teamAccess;

beforeEach(() => {
  for (const m of [
    mockWorkspacesFindFirst, mockTeamMembersFindFirst, mockTeamMembersFindMany,
    mockTeamsFindFirst, mockAccountsFindFirst, mockAccountWorkspacesFindFirst,
  ]) m.mockReset();
  mockTeamMembersFindMany.mockResolvedValue([]);
  mockTeamsFindFirst.mockResolvedValue(null);
});

// team-access's uuid guard rejects a non-UUID workspaceId before it ever
// reaches these mocks, so every workspaceId below must be UUID-shaped — the
// mocks don't filter by value, so the exact id doesn't otherwise matter.
const WS_ID = '11111111-1111-4111-8111-111111111111';

describe('verifyWorkspaceAccess — open workspaces', () => {
  it('denies a signed-in user who is not a member of the owning team', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-a', accessMode: 'open' });
    mockTeamMembersFindFirst.mockResolvedValue(null);
    expect(await verifyWorkspaceAccess('user-other', WS_ID)).toBeNull();
  });

  it('allows a member of the owning team', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: 'team-a', accessMode: 'open' });
    mockTeamMembersFindFirst.mockResolvedValue({ role: 'member' });
    expect(await verifyWorkspaceAccess('user-member', WS_ID)).toEqual({ teamId: 'team-a', role: 'member' });
  });
});

describe('verifyAccountWorkspaceAccess — open workspaces', () => {
  it('allows an account from the owning team without an explicit link', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-a', accessMode: 'open' });
    mockAccountsFindFirst.mockResolvedValue({ teamId: 'team-a' });
    expect(await verifyAccountWorkspaceAccess('acct-same', WS_ID)).toBe(true);
  });

  it('denies an account from another team that has no explicit link', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-a', accessMode: 'open' });
    mockAccountsFindFirst.mockResolvedValue({ teamId: 'team-b' });
    mockAccountWorkspacesFindFirst.mockResolvedValue(null);
    expect(await verifyAccountWorkspaceAccess('acct-other', WS_ID)).toBe(false);
  });

  it('still honours an explicit accountWorkspaces link for another team', async () => {
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-a', accessMode: 'open' });
    mockAccountsFindFirst.mockResolvedValue({ teamId: 'team-b' });
    mockAccountWorkspacesFindFirst.mockResolvedValue({ canClaim: true, canCreate: true });
    expect(await verifyAccountWorkspaceAccess('acct-linked', WS_ID, 'canClaim')).toBe(true);
  });
});

describe('team-wide admin-tier helpers are gone', () => {
  // Every team-scoped decision names its permission (can / teamIdsWhere in
  // lib/permissions.ts), so a team's permission overrides apply to it. A
  // hard-coded owner/admin helper would ignore them; none may come back.
  const removed = ['getUserAdmin', 'getCallerAdmin', 'canCallerAdmin'].map(p => `${p}${p.startsWith('can') ? 'Team' : 'TeamIds'}`);

  it('team-access no longer exports them', () => {
    for (const name of removed) expect(name in teamAccess).toBe(false);
  });

  it('no source file under apps/web/src calls or stubs them', async () => {
    const root = new URL('..', import.meta.url).pathname;
    const hits: string[] = [];
    for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: root })) {
      const text = await Bun.file(root + file).text();
      for (const name of removed) if (text.includes(name)) hits.push(`${file}: ${name}`);
    }
    expect(hits).toEqual([]);
  });
});

 it('workspace-limited tokens cannot use another open workspace', async () => {
   mockAccountsFindFirst.mockResolvedValue({teamId:'team-a', workspaceIds:[]});
   mockWorkspacesFindFirst.mockResolvedValue({id:WS_ID,teamId:'team-a',accessMode:'open'});
   expect(await verifyAccountWorkspaceAccess('limited', WS_ID)).toBe(false);
 });
