import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockMembershipFindFirst = mock(async (): Promise<any> => undefined);
const mockUserTeamIds = mock(async (_userId: string): Promise<string[]> => []);

mock.module('@buildd/core/db', () => ({
  db: { query: { teamMembers: { findFirst: mockMembershipFindFirst } } },
}));
mock.module('@/lib/permissions', () => ({
  roleHas: (role: string) => role === 'admin' || role === 'owner',
  getTeamPermissionOverrides: async () => null,
}));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockUserTeamIds }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => null }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => null }));

const { canManageTeamConnectors } = await import('./connector-team-auth');

beforeEach(() => {
  mockMembershipFindFirst.mockReset();
  mockMembershipFindFirst.mockResolvedValue(undefined);
  mockUserTeamIds.mockReset();
  mockUserTeamIds.mockResolvedValue([]);
});

describe('canManageTeamConnectors', () => {
  it('denies a user who does not belong to the team, even with no membership row', async () => {
    mockUserTeamIds.mockResolvedValue(['other-team']);
    expect(await canManageTeamConnectors('u1', 'team-a')).toBe(false);
  });

  it('allows an admin and denies a plain member', async () => {
    mockUserTeamIds.mockResolvedValue(['team-a']);
    mockMembershipFindFirst.mockResolvedValue({ role: 'admin' });
    expect(await canManageTeamConnectors('u1', 'team-a')).toBe(true);
    mockMembershipFindFirst.mockResolvedValue({ role: 'member' });
    expect(await canManageTeamConnectors('u1', 'team-a')).toBe(false);
  });

  it('allows the owner of a personal team (member of it, no membership row)', async () => {
    mockUserTeamIds.mockResolvedValue(['team-a']);
    expect(await canManageTeamConnectors('u1', 'team-a')).toBe(true);
  });
});
