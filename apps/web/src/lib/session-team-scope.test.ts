import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockGetUserTeamIds = mock(async (_userId: string) => ['team-a', 'team-b']);
const mockGetTeamWorkspaceIds = mock(async (teamId: string) =>
  teamId === 'team-a' ? ['ws-a1', 'ws-shared'] : ['ws-b1', 'ws-shared'],
);

mock.module('@/lib/team-access', () => ({
  getUserTeamIds: mockGetUserTeamIds,
  getTeamWorkspaceIds: mockGetTeamWorkspaceIds,
}));

import { resolveSessionTeamIds, workspaceIdsForTeams } from './session-team-scope';

beforeEach(() => {
  mockGetUserTeamIds.mockClear();
  mockGetTeamWorkspaceIds.mockClear();
});

describe('resolveSessionTeamIds', () => {
  it('defaults to every team the user belongs to', async () => {
    expect(await resolveSessionTeamIds('user-1', null)).toEqual(['team-a', 'team-b']);
  });

  it('narrows to the pinned team when the user belongs to it', async () => {
    expect(await resolveSessionTeamIds('user-1', 'team-b')).toEqual(['team-b']);
  });

  it('returns null for a pin outside the user teams', async () => {
    expect(await resolveSessionTeamIds('user-1', 'team-z')).toBeNull();
  });
});

describe('workspaceIdsForTeams', () => {
  it('unions and dedupes the workspaces of each team', async () => {
    expect((await workspaceIdsForTeams(['team-a', 'team-b'])).sort()).toEqual(['ws-a1', 'ws-b1', 'ws-shared']);
  });

  it('returns nothing for no teams', async () => {
    expect(await workspaceIdsForTeams([])).toEqual([]);
    expect(mockGetTeamWorkspaceIds).not.toHaveBeenCalled();
  });
});
