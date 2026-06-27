import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mock only the db layer — let real schema + drizzle-orm load. Mocking those
// globally (bun's mock.module is process-wide) would shadow exports other
// co-running test files import. getUserTeamIds → db.query.teamMembers.findMany;
// getUserDefaultTeamId → db.query.teams.findFirst (slug = personal-{userId}).
const mockTeamMembersFindMany = mock(() => [] as any[]);
const mockTeamsFindFirst = mock(() => null as any);
const mockWorkspacesFindMany = mock(() => [] as any[]);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamMembers: { findMany: mockTeamMembersFindMany },
      teams: { findFirst: mockTeamsFindFirst },
      workspaces: { findMany: mockWorkspacesFindMany },
    },
  },
}));

const { resolveActiveTeamId, getTeamWorkspaceIds, getUserTeamIds } = await import('./team-access');

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

  it('resolves personal team for accounts with no teamMembers row (P0 regression: mission detail 404)', async () => {
    // Simulates a user whose personal team exists but has no teamMembers row —
    // these accounts hit notFound() on the mission detail page before this fix.
    mockTeamMembersFindMany.mockResolvedValue([]);
    mockTeamsFindFirst.mockResolvedValue({ id: 'personal-team-id' });
    expect(await resolveActiveTeamId('user-1', null)).toBe('personal-team-id');
  });
});
