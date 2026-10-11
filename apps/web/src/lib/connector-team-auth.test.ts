import { describe, it, expect, mock, beforeEach } from 'bun:test';

// The real permissions module runs: membership rows come from teamMembers,
// the personal team from teams (slug lookup), overrides from teams (id lookup).
let memberships: { teamId: string; role: string }[] = [];
let personalTeamId: string | null = null;
let overrides: Record<string, unknown> = {};

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamMembers: { findMany: async () => memberships },
      teams: {
        findFirst: async ({ where }: { where: { b: string } }) => {
          const value = where.b;
          if (value.startsWith('personal-')) return personalTeamId ? { id: personalTeamId } : undefined;
          return { permissionOverrides: overrides[value] ?? null };
        },
      },
    },
  },
}));
mock.module('drizzle-orm', () => ({
  eq: (a: unknown, b: unknown) => ({ a, b, op: 'eq' }),
  and: (...args: unknown[]) => ({ args, op: 'and' }),
}));
mock.module('@buildd/core/db/schema', () => ({
  teamMembers: { userId: 'userId', teamId: 'teamId' },
  teams: { id: 'id', slug: 'slug', permissionOverrides: 'permissionOverrides' },
}));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: async () => memberships.map(m => m.teamId) }));
let currentUser: { id: string } | null = null;
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => currentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => null }));

const { canManageTeamConnectors, canWriteTeamConnectors, resolveConnectorTeam } = await import('./connector-team-auth');
const { NextRequest } = await import('next/server');

beforeEach(() => {
  memberships = [];
  personalTeamId = null;
  overrides = {};
  currentUser = null;
});

describe('canManageTeamConnectors', () => {
  it('denies a user who does not belong to the team', async () => {
    memberships = [{ teamId: 'other-team', role: 'owner' }];
    expect(await canManageTeamConnectors('u1', 'team-a')).toBe(false);
  });

  it('allows an owner and an admin, denies a plain member', async () => {
    memberships = [{ teamId: 'team-a', role: 'owner' }];
    expect(await canManageTeamConnectors('u1', 'team-a')).toBe(true);
    memberships = [{ teamId: 'team-a', role: 'admin' }];
    expect(await canManageTeamConnectors('u1', 'team-a')).toBe(true);
    memberships = [{ teamId: 'team-a', role: 'member' }];
    expect(await canManageTeamConnectors('u1', 'team-a')).toBe(false);
  });

  it('allows the owner of their personal team, which has no membership row', async () => {
    personalTeamId = 'team-a';
    expect(await canManageTeamConnectors('u1', 'team-a')).toBe(true);
  });

  it('fails closed when there is no membership row and the team is not the caller’s personal team', async () => {
    personalTeamId = 'my-personal-team';
    expect(await canManageTeamConnectors('u1', 'team-a')).toBe(false);
  });

  it('honours a team override that grants manage_connectors to members', async () => {
    memberships = [{ teamId: 'team-a', role: 'member' }];
    overrides = { 'team-a': { manage_connectors: ['owner', 'admin', 'member'] } };
    expect(await canManageTeamConnectors('u1', 'team-a')).toBe(true);
  });

  it('honours a team override that takes manage_connectors from admins', async () => {
    memberships = [{ teamId: 'team-a', role: 'admin' }];
    overrides = { 'team-a': { manage_connectors: ['owner'] } };
    expect(await canManageTeamConnectors('u1', 'team-a')).toBe(false);
  });
});

describe('canWriteTeamConnectors', () => {
  it('a session caller is checked against manage_connectors', async () => {
    memberships = [{ teamId: 'team-a', role: 'member' }];
    expect(await canWriteTeamConnectors({ type: 'session', user: { id: 'u1' } }, 'team-a')).toBe(false);
    memberships = [{ teamId: 'team-a', role: 'admin' }];
    expect(await canWriteTeamConnectors({ type: 'session', user: { id: 'u1' } }, 'team-a')).toBe(true);
  });

  it('an admin-access API key may write its own team only', async () => {
    const api = { type: 'api' as const, account: { id: 'acc-1', teamId: 'team-a' } };
    expect(await canWriteTeamConnectors(api, 'team-a')).toBe(true);
    expect(await canWriteTeamConnectors(api, 'team-b')).toBe(false);
  });
});

describe('resolveConnectorTeam', () => {
  const req = () => new NextRequest('http://localhost:3000/api/connectors/catalog');

  it('a member resolves to their team without manage rights; an admin with them', async () => {
    currentUser = { id: 'u1' };
    memberships = [{ teamId: 'team-a', role: 'member' }];
    expect(await resolveConnectorTeam(req())).toMatchObject({ teamId: 'team-a', canManage: false });
    memberships = [{ teamId: 'team-a', role: 'admin' }];
    expect(await resolveConnectorTeam(req())).toMatchObject({ teamId: 'team-a', canManage: true });
  });
});
