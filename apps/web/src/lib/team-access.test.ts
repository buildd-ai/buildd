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

const { resolveActiveTeamId, getTeamWorkspaceIds } = await import('./team-access');

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

  it('does not pick a personal team the user is not a member of', async () => {
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'A' }]);
    mockTeamsFindFirst.mockResolvedValue({ id: 'P' }); // personal P not in membership
    expect(await resolveActiveTeamId('user-1', null)).toBe('A');
  });

  it('returns null when the user belongs to no team', async () => {
    mockTeamMembersFindMany.mockResolvedValue([]);
    expect(await resolveActiveTeamId('user-1', 'A')).toBeNull();
  });
});
