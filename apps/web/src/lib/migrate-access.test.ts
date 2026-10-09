import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockTeamMembersFindMany = mock(() => [] as any[]);
const mockTeamsFindFirst = mock(() => null as any);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamMembers: { findMany: mockTeamMembersFindMany },
      teams: { findFirst: mockTeamsFindFirst },
    },
  },
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mock(async () => null) }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mock(async () => null) }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mock(async () => []) }));
mock.module('@/lib/token-route-policy', () => ({ hasTokenRouteAdminAccess: mock(() => false) }));

const { isTeamAdmin } = await import('./migrate-access');

/** The personal-team lookup asks teams by slug; the overrides read asks by id. */
function personalTeam(id: string | null) {
  mockTeamsFindFirst.mockImplementation(async (q: any) => {
    if (q?.columns?.permissionOverrides) return { permissionOverrides: {} };
    return id ? { id } : null;
  });
}

beforeEach(() => {
  mockTeamMembersFindMany.mockReset();
  mockTeamsFindFirst.mockReset();
  mockTeamMembersFindMany.mockResolvedValue([]);
  personalTeam(null);
});

describe('isTeamAdmin', () => {
  it('denies a user with no membership row in the team', async () => {
    expect(await isTeamAdmin('u1', 'team-t')).toBe(false);
  });

  it("allows the user's personal team without a membership row", async () => {
    personalTeam('team-personal');
    expect(await isTeamAdmin('u1', 'team-personal')).toBe(true);
    expect(await isTeamAdmin('u1', 'team-t')).toBe(false);
  });

  it('allows owner and admin, denies member', async () => {
    mockTeamMembersFindMany.mockResolvedValue([
      { teamId: 'team-o', role: 'owner' },
      { teamId: 'team-a', role: 'admin' },
      { teamId: 'team-m', role: 'member' },
    ]);
    expect(await isTeamAdmin('u1', 'team-o')).toBe(true);
    expect(await isTeamAdmin('u1', 'team-a')).toBe(true);
    expect(await isTeamAdmin('u1', 'team-m')).toBe(false);
  });

  it("applies the team's overrides", async () => {
    mockTeamMembersFindMany.mockResolvedValue([{ teamId: 'team-a', role: 'admin' }]);
    mockTeamsFindFirst.mockImplementation(async (q: any) =>
      q?.columns?.permissionOverrides ? { permissionOverrides: { migrate_workspace: ['owner'] } } : null);
    expect(await isTeamAdmin('u1', 'team-a')).toBe(false);
  });
});
