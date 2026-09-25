import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mock only the db layer — let real schema + drizzle-orm load. Mocking those
// globally (bun's mock.module is process-wide) would shadow exports other
// co-running test files import. getUserTeamIds → db.query.teamMembers.findMany;
// getUserDefaultTeamId → db.query.teams.findFirst (slug = personal-{userId}).
const mockTeamMembersFindMany = mock(() => [] as any[]);
const mockTeamMembersFindFirst = mock(() => null as any);
const mockTeamsFindFirst = mock(() => null as any);
const mockWorkspacesFindMany = mock(() => [] as any[]);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamMembers: { findMany: mockTeamMembersFindMany, findFirst: mockTeamMembersFindFirst },
      teams: { findFirst: mockTeamsFindFirst },
      workspaces: { findMany: mockWorkspacesFindMany },
    },
  },
}));

const {
  resolveActiveTeamId,
  getTeamWorkspaceIds,
  getUserTeamIds,
  resolveAccountTeamIds,
  getUserTeamRole,
  resolveActiveTeamScope,
} = await import('./team-access');
const { PgDialect } = await import('drizzle-orm/pg-core');

describe('getUserTeamIds', () => {
  beforeEach(() => {
    mockTeamMembersFindMany.mockReset();
    mockTeamsFindFirst.mockReset();
    mockTeamsFindFirst.mockResolvedValue(null);
  });

  it('returns team ids from teamMembers', async () => {
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'A' }, { teamId: 'B' }]);
    expect(await getUserTeamIds('user-1')).toEqual(['A', 'B']);
  });

  it('includes personal team when teamMembers is empty but personal team exists', async () => {
    mockTeamMembersFindMany.mockResolvedValue([]);
    mockTeamsFindFirst.mockResolvedValue({ id: 'personal-team-id' });
    expect(await getUserTeamIds('user-1')).toEqual(['personal-team-id']);
  });

  it('deduplicates when personal team is already in teamMembers', async () => {
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'personal-team-id' }, { teamId: 'B' }]);
    mockTeamsFindFirst.mockResolvedValue({ id: 'personal-team-id' });
    const result = await getUserTeamIds('user-1');
    expect(result.filter(id => id === 'personal-team-id')).toHaveLength(1);
    expect(result).toContain('B');
  });

  it('returns empty array when no memberships and no personal team', async () => {
    mockTeamMembersFindMany.mockResolvedValue([]);
    mockTeamsFindFirst.mockResolvedValue(null);
    expect(await getUserTeamIds('user-1')).toEqual([]);
  });
});

describe('getUserTeamIds concurrency', () => {
  beforeEach(() => {
    mockTeamMembersFindMany.mockReset();
    mockTeamsFindFirst.mockReset();
  });

  it('issues both statements concurrently, not one behind the other', async () => {
    // The memberships read and the personal-team read share no inputs, and
    // neon-http bills a full HTTP round trip per statement. This is a real
    // concurrency assertion rather than a shape assertion: the memberships
    // mock refuses to settle until the personal-team mock has been entered, so
    // a sequential implementation cannot get past it and the test fails by
    // timing out on its own bounded wait.
    let personalTeamStarted = false;
    mockTeamsFindFirst.mockImplementation(async () => {
      personalTeamStarted = true;
      return { id: 'P' };
    });
    mockTeamMembersFindMany.mockImplementation(async () => {
      const deadline = Date.now() + 500;
      while (!personalTeamStarted) {
        if (Date.now() > deadline) {
          throw new Error('personal-team read never started — the two statements are still serialized');
        }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return [{ teamId: 'A' }];
    });

    expect(new Set(await getUserTeamIds('user-1'))).toEqual(new Set(['A', 'P']));
  });
});

describe('getTeamWorkspaceIds', () => {
  beforeEach(() => {
    mockWorkspacesFindMany.mockReset();
  });

  it('returns workspace ids for a team', async () => {
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }, { id: 'ws-2' }]);
    expect(await getTeamWorkspaceIds('team-1')).toEqual(['ws-1', 'ws-2']);
  });

  it('returns empty array when team has no workspaces', async () => {
    mockWorkspacesFindMany.mockResolvedValue([]);
    expect(await getTeamWorkspaceIds('team-1')).toEqual([]);
  });
});

describe('resolveActiveTeamId', () => {
  beforeEach(() => {
    mockTeamMembersFindMany.mockReset();
    mockTeamsFindFirst.mockReset();
    mockTeamsFindFirst.mockResolvedValue(null);
    // No team has workspaces unless a test says so — the default then falls
    // back to personal → first team, which the older cases below pin.
    mockWorkspacesFindMany.mockReset();
    mockWorkspacesFindMany.mockResolvedValue([]);
  });

  it('returns the cookie team when the user is a member', async () => {
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'A' }, { teamId: 'B' }]);
    expect(await resolveActiveTeamId('user-1', 'A')).toBe('A');
  });

  it('ignores a cookie team the user is NOT a member of and falls back to personal', async () => {
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'A' }, { teamId: 'B' }]);
    mockTeamsFindFirst.mockResolvedValue({ id: 'B' }); // personal team is B
    expect(await resolveActiveTeamId('user-1', 'Z')).toBe('B');
  });

  it('falls back to the first team when there is no personal team', async () => {
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'A' }, { teamId: 'B' }]);
    mockTeamsFindFirst.mockResolvedValue(null);
    expect(await resolveActiveTeamId('user-1', null)).toBe('A');
  });

  it('prefers personal team over first team when personal team exists (no cookie)', async () => {
    // getUserTeamIds now includes the personal team via slug fallback, so
    // resolveActiveTeamId will find it in teamIds and prefer it.
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'A' }]);
    mockTeamsFindFirst.mockResolvedValue({ id: 'P' }); // personal team is P
    expect(await resolveActiveTeamId('user-1', null)).toBe('P');
  });

  it('returns null when the user belongs to no team', async () => {
    mockTeamMembersFindMany.mockResolvedValue([]);
    mockTeamsFindFirst.mockResolvedValue(null);
    expect(await resolveActiveTeamId('user-1', 'A')).toBeNull();
  });

  // Same default as resolveActiveTeamScope, so every scoped page agrees with
  // the header: without a valid cookie, personal only if it has workspaces.
  it('no cookie + empty personal team + another team with workspaces → that team', async () => {
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'A' }, { teamId: 'P' }]);
    mockTeamsFindFirst.mockResolvedValue({ id: 'P' });
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-a', name: 'Alpha', teamId: 'A' }]);
    expect(await resolveActiveTeamId('user-1', null)).toBe('A');
    expect(await resolveActiveTeamId('user-1', 'Z')).toBe('A');
  });

  it('agrees with resolveActiveTeamScope on every cookie shape', async () => {
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'B' }, { teamId: 'A' }, { teamId: 'P' }]);
    mockTeamsFindFirst.mockResolvedValue({ id: 'P' });
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-b', name: 'Beta', teamId: 'B' },
      { id: 'ws-a', name: 'Alpha', teamId: 'A' },
    ]);
    for (const cookie of [null, undefined, 'Z', 'B', 'P']) {
      expect(await resolveActiveTeamId('user-1', cookie)).toBe((await resolveActiveTeamScope('user-1', cookie)).teamId);
    }
  });

  it('a valid cookie is returned without a workspace query', async () => {
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'A' }, { teamId: 'B' }]);
    expect(await resolveActiveTeamId('user-1', 'B')).toBe('B');
    expect(mockWorkspacesFindMany).not.toHaveBeenCalled();
  });

  it('resolves personal team for accounts with no teamMembers row (P0 regression: mission detail 404)', async () => {
    // Simulates a user whose personal team exists but has no teamMembers row —
    // these accounts hit notFound() on the mission detail page before this fix.
    mockTeamMembersFindMany.mockResolvedValue([]);
    mockTeamsFindFirst.mockResolvedValue({ id: 'personal-team-id' });
    expect(await resolveActiveTeamId('user-1', null)).toBe('personal-team-id');
  });
});

describe('resolveActiveTeamScope — the one active-team resolver the shell and Home share', () => {
  // Team T is the user's personal team; team U is another membership. The
  // shell used to default to "first team" and Home to "every workspace, no
  // team", so a user without a valid cookie saw one team named in the header
  // and a "no workspace yet" empty state on Home.
  let wsByTeam: Record<string, { id: string; name: string }[]>;
  const dialect = new PgDialect();

  beforeEach(() => {
    wsByTeam = {
      T: [{ id: 'ws-t1', name: 'Alpha' }, { id: 'ws-t2', name: 'Beta' }],
      U: [{ id: 'ws-u1', name: 'Gamma' }],
    };
    mockTeamMembersFindMany.mockReset();
    mockTeamsFindFirst.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'U' }, { teamId: 'T' }]);
    mockTeamsFindFirst.mockResolvedValue({ id: 'T' });
    // Answer from the team ids actually bound into the WHERE clause, so a
    // resolver that queried the wrong team returns the wrong workspaces.
    mockWorkspacesFindMany.mockImplementation(((args: any) => {
      const { params } = dialect.sqlToQuery(args.where);
      const teams = params.filter((p) => typeof p === 'string' && p in wsByTeam) as string[];
      return Promise.resolve(teams.flatMap((t) => wsByTeam[t].map((w) => ({ ...w, teamId: t }))));
    }) as any);
  });

  it('no cookie → personal team and its workspaces', async () => {
    expect(await resolveActiveTeamScope('user-1', undefined)).toEqual({ teamId: 'T', workspaces: wsByTeam.T });
  });

  it('stale cookie (a team the user left) → personal team, never an empty workspace set', async () => {
    const scope = await resolveActiveTeamScope('user-1', 'team-the-user-left');
    expect(scope.teamId).toBe('T');
    expect(scope.workspaces).toEqual(wsByTeam.T);
  });

  it('valid cookie → that team and its workspaces', async () => {
    expect(await resolveActiveTeamScope('user-1', 'U')).toEqual({ teamId: 'U', workspaces: wsByTeam.U });
  });

  // #1032: first load (no cookie) must never land on an empty team when the
  // user has workspaces elsewhere. Personal is preferred only if it has any.
  it('no cookie + empty personal team + another team with workspaces → that team', async () => {
    wsByTeam.T = [];
    expect(await resolveActiveTeamScope('user-1', undefined)).toEqual({ teamId: 'U', workspaces: wsByTeam.U });
  });

  it('stale cookie + empty personal team → the team that has workspaces', async () => {
    wsByTeam.T = [];
    expect((await resolveActiveTeamScope('user-1', 'team-the-user-left')).teamId).toBe('U');
  });

  it('several non-personal teams with workspaces → a stable pick, independent of membership row order', async () => {
    wsByTeam.T = [];
    wsByTeam.V = [{ id: 'ws-v1', name: 'Delta' }];
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'V' }, { teamId: 'U' }, { teamId: 'T' }]);
    const first = (await resolveActiveTeamScope('user-1', undefined)).teamId;
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'T' }, { teamId: 'U' }, { teamId: 'V' }]);
    expect((await resolveActiveTeamScope('user-1', undefined)).teamId).toBe(first);
    expect(first).toBe('U');
  });

  it('no team has workspaces → personal team', async () => {
    wsByTeam.T = [];
    wsByTeam.U = [];
    expect(await resolveActiveTeamScope('user-1', undefined)).toEqual({ teamId: 'T', workspaces: [] });
  });

  it('no team has workspaces and there is no personal team → first team', async () => {
    mockTeamsFindFirst.mockResolvedValue(null);
    wsByTeam.T = [];
    wsByTeam.U = [];
    expect((await resolveActiveTeamScope('user-1', undefined)).teamId).toBe('T');
  });

  it('a valid cookie wins even when that team has no workspaces', async () => {
    wsByTeam.U = [];
    expect(await resolveActiveTeamScope('user-1', 'U')).toEqual({ teamId: 'U', workspaces: [] });
  });

  it('no team at all → null team, no workspaces, no workspace query', async () => {
    mockTeamMembersFindMany.mockResolvedValue([]);
    mockTeamsFindFirst.mockResolvedValue(null);
    expect(await resolveActiveTeamScope('user-1', 'U')).toEqual({ teamId: null, workspaces: [] });
    expect(mockWorkspacesFindMany).not.toHaveBeenCalled();
  });

  it('propagates a workspace-query failure instead of reporting "no workspaces"', async () => {
    mockWorkspacesFindMany.mockImplementation((() => Promise.reject(new Error('db down'))) as any);
    await expect(resolveActiveTeamScope('user-1', 'U')).rejects.toThrow('db down');
  });
});

describe('resolveAccountTeamIds — an API key resolves to exactly its own team', () => {
  beforeEach(() => {
    mockTeamMembersFindMany.mockReset();
    mockTeamMembersFindFirst.mockReset();
    mockTeamsFindFirst.mockReset();
    // A member of the key's team who also belongs to other teams.
    mockTeamMembersFindFirst.mockResolvedValue({ userId: 'someone' });
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'key-team' }, { teamId: 'other-team' }]);
    mockTeamsFindFirst.mockResolvedValue({ id: 'key-team', slug: 'personal-someone' });
  });

  it("returns only the key account's team, not a member's other teams", async () => {
    expect(await resolveAccountTeamIds(null, { teamId: 'key-team' })).toEqual(['key-team']);
  });

  it('uses the API account scope even when a session user is also present', async () => {
    expect(await resolveAccountTeamIds({ id: 'someone' }, { teamId: 'key-team' })).toEqual(['key-team']);
  });

  it('a key on a personal team stays on that team', async () => {
    mockTeamMembersFindFirst.mockResolvedValue(null);
    expect(await resolveAccountTeamIds(null, { teamId: 'key-team' })).toEqual(['key-team']);
  });

  it('session users still resolve to all of their teams', async () => {
    mockTeamsFindFirst.mockResolvedValue(null);
    expect(await resolveAccountTeamIds({ id: 'user-9' }, null)).toEqual(['key-team', 'other-team']);
  });
});

describe('getUserTeamRole', () => {
  beforeEach(() => {
    mockTeamMembersFindFirst.mockReset();
    mockTeamsFindFirst.mockReset();
  });

  it('returns the membership role', async () => {
    mockTeamMembersFindFirst.mockResolvedValue({ role: 'member' });
    expect(await getUserTeamRole('user-1', 'team-a')).toBe('member');
  });

  it("treats the user's own personal team as owner when no membership row exists", async () => {
    mockTeamMembersFindFirst.mockResolvedValue(null);
    mockTeamsFindFirst.mockResolvedValue({ id: 'team-p', slug: 'personal-user-1' });
    expect(await getUserTeamRole('user-1', 'team-p')).toBe('owner');
  });

  it('returns null for a team the user does not belong to', async () => {
    mockTeamMembersFindFirst.mockResolvedValue(null);
    mockTeamsFindFirst.mockResolvedValue({ id: 'team-x', slug: 'personal-someone-else' });
    expect(await getUserTeamRole('user-1', 'team-x')).toBeNull();
  });
});
