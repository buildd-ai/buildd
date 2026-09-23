/**
 * Team routes and API keys.
 *
 * An API key acts as its own account, scoped to its own team. It may read its
 * team (list, detail, members, backend readiness); it may not administer teams
 * — creating/updating/deleting teams, changing members or roles, and managing
 * invitations require a signed-in session, whatever the key's level.
 *
 * Uses the real auth-helpers so the principal resolution is what is under test.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const writes: string[] = [];
let keyAccount: any = { id: 'acct-1', name: 'CI', teamId: 'team-1', level: 'admin' };

mock.module('@/auth', () => ({ auth: async () => null }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => keyAccount }));
mock.module('@/lib/backend-strand', () => ({
  getBackendStrandSummary: async ({ teamId }: { teamId: string }) => ({ teamId, backends: [] }),
}));
mock.module('@/lib/default-roles', () => ({ seedDefaultRolesForTeam: async () => {} }));

const teamRow = (id: string) => ({ id, name: `Team ${id}`, slug: id, plan: 'free' });

mock.module('@buildd/core/db', () => {
  const recordWrite = (kind: string) => () => {
    writes.push(kind);
    const chain: any = {
      values: () => chain, set: () => chain, where: () => chain,
      returning: () => Promise.resolve([{ id: 'x' }]),
      then: (r: any) => Promise.resolve().then(r),
    };
    return chain;
  };
  return {
    db: {
      query: {
        // Every team exists and has an owner — none of that may leak to a key.
        teams: { findFirst: async () => teamRow('team-1') },
        teamMembers: {
          findFirst: async () => ({ teamId: 'team-1', userId: 'owner-user', role: 'owner', user: { id: 'owner-user' } }),
          findMany: async () => [{ teamId: 'team-1', userId: 'owner-user', role: 'owner', joinedAt: null, user: { name: 'O', email: 'o@example.test', image: null }, team: teamRow('team-1') }],
        },
        workspaces: { findMany: async () => [] },
        teamInvitations: { findFirst: async () => ({ id: 'inv-1', teamId: 'team-1', status: 'pending', email: 'o@example.test', expiresAt: new Date(Date.now() + 1e6) }), findMany: async () => [] },
        connectors: { findFirst: async () => ({ id: 'c-1', teamId: 'team-1', authMode: 'oauth', clientId: 'cid', url: 'https://mcp.example.test', discoveredMetadata: { authMode: 'oauth', authorizationServer: { authorization_endpoint: 'https://as.example.test/a', token_endpoint: 'https://as.example.test/t' } } }) },
        users: { findFirst: async () => null },
      },
      select: () => ({ from: () => ({ where: () => ({ groupBy: async () => [{ teamId: 'team-1', count: 1 }] }) }) }),
      insert: recordWrite('insert'),
      update: recordWrite('update'),
      delete: recordWrite('delete'),
    },
  };
});

const teamsRoute = await import('./route');
const teamRoute = await import('./[id]/route');
const membersRoute = await import('./[id]/members/route');
const memberRoute = await import('./[id]/members/[userId]/route');
const invitationsRoute = await import('./[id]/invitations/route');
const invitationRoute = await import('./[id]/invitations/[invitationId]/route');
const readinessRoute = await import('./[id]/backend-readiness/route');
const acceptRoute = await import('../invitations/[token]/accept/route');
const connectRoute = await import('../connectors/[id]/connect/route');

function req(method: string, body?: unknown) {
  return new NextRequest('http://localhost:3000/api/x', {
    method,
    headers: { authorization: 'Bearer bld_test', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });

beforeEach(() => {
  process.env.NODE_ENV = 'production';
  writes.length = 0;
  keyAccount = { id: 'acct-1', name: 'CI', teamId: 'team-1', level: 'admin' };
});

describe('team administration requires a signed-in session', () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    ['POST /api/teams', () => teamsRoute.POST(req('POST', { name: 'N', slug: 'n' }))],
    ['PATCH /api/teams/[id]', () => teamRoute.PATCH(req('PATCH', { name: 'N' }), p({ id: 'team-1' }))],
    ['DELETE /api/teams/[id]', () => teamRoute.DELETE(req('DELETE'), p({ id: 'team-1' }))],
    ['POST /api/teams/[id]/members', () => membersRoute.POST(req('POST', { email: 'x@example.test', role: 'owner' }), p({ id: 'team-1' }))],
    ['PATCH /api/teams/[id]/members/[userId]', () => memberRoute.PATCH(req('PATCH', { role: 'owner' }), p({ id: 'team-1', userId: 'u-2' }))],
    ['DELETE /api/teams/[id]/members/[userId]', () => memberRoute.DELETE(req('DELETE'), p({ id: 'team-1', userId: 'u-2' }))],
    ['GET /api/teams/[id]/invitations', () => invitationsRoute.GET(req('GET'), p({ id: 'team-1' }))],
    ['POST /api/teams/[id]/invitations', () => invitationsRoute.POST(req('POST', { email: 'x@example.test', role: 'admin' }), p({ id: 'team-1' }))],
    ['DELETE /api/teams/[id]/invitations/[invitationId]', () => invitationRoute.DELETE(req('DELETE'), p({ id: 'team-1', invitationId: 'inv-1' }))],
    ['POST /api/invitations/[token]/accept', () => acceptRoute.POST(req('POST'), p({ token: 'tok' }))],
    ['POST /api/connectors/[id]/connect', () => connectRoute.POST(req('POST'), p({ id: 'c-1' }))],
  ];

  for (const [name, call] of cases) {
    it(`${name} refuses an admin-level API key with 403 and writes nothing`, async () => {
      const res = await call();
      expect(res.status).toBe(403);
      expect(writes).toEqual([]);
    });
  }
});

describe('API keys can read their own team only', () => {
  it('GET /api/teams lists only the key team', async () => {
    const res = await teamsRoute.GET(req('GET'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.teams.map((t: any) => t.id)).toEqual(['team-1']);
    expect(data.teams[0].role).toBeNull();
  });

  it('GET /api/teams/[id] returns the key team without a user role', async () => {
    const res = await teamRoute.GET(req('GET'), p({ id: 'team-1' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.currentUserRole).toBeNull();
  });

  it('GET /api/teams/[id] hides other teams', async () => {
    const res = await teamRoute.GET(req('GET'), p({ id: 'team-2' }));
    expect(res.status).toBe(404);
  });

  it('GET /api/teams/[id]/members is scoped to the key team', async () => {
    expect((await membersRoute.GET(req('GET'), p({ id: 'team-1' }))).status).toBe(200);
    expect((await membersRoute.GET(req('GET'), p({ id: 'team-2' }))).status).toBe(404);
  });

  it('GET /api/teams/[id]/backend-readiness is scoped to the key team', async () => {
    expect((await readinessRoute.GET(req('GET'), p({ id: 'team-1' }))).status).toBe(200);
    expect((await readinessRoute.GET(req('GET'), p({ id: 'team-2' }))).status).toBe(404);
  });
});
