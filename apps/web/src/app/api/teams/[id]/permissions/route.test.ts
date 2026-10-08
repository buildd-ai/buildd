/**
 * Who may read and change a team's permission grants: any signed-in member
 * reads; only a role holding manage_team_permissions (owner, locked) writes.
 * API keys can do neither. Invalid input is a 400 that names the problem, and
 * nothing is written.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = '11111111-1111-4111-8111-111111111111';

let principal: any = null;
let memberRole: string | null = null;
let stored: unknown = {};
let writes: unknown[] = [];

mock.module('@/lib/auth-helpers', () => ({ getRequestPrincipal: async () => principal }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamMembers: { findFirst: async () => (memberRole ? { role: memberRole } : null) },
      teams: { findFirst: async () => ({ id: TEAM, permissionOverrides: stored }) },
    },
    update: () => ({
      set: (values: { permissionOverrides: unknown }) => ({
        where: () => ({
          returning: async () => {
            writes.push(values.permissionOverrides);
            stored = values.permissionOverrides;
            return [{ id: TEAM }];
          },
        }),
      }),
    }),
  },
}));

const { GET, PUT } = await import('./route');
const ctx = (id = TEAM) => ({ params: Promise.resolve({ id }) });
const url = (id = TEAM) => `http://localhost/api/teams/${id}/permissions`;
const get = (id = TEAM) => GET(new NextRequest(url(id)), ctx(id));
const put = (body: unknown, id = TEAM) => PUT(new NextRequest(url(id), {
  method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
}), ctx(id));

const session = () => ({ kind: 'session', user: { id: 'u1' } });
const adminKey = () => ({ kind: 'api_key', account: { id: 'a', name: 'k', teamId: TEAM, level: 'admin' } });

beforeEach(() => {
  principal = null; memberRole = null; stored = {}; writes = [];
});

describe('GET', () => {
  it('401 without credentials, 404 for a non-member, 403 for an API key', async () => {
    expect((await get()).status).toBe(401);
    principal = session();
    expect((await get()).status).toBe(404);
    principal = adminKey();
    expect((await get()).status).toBe(403);
  });

  it('a member reads every permission with defaults, effective roles and lock state, but cannot edit', async () => {
    principal = session(); memberRole = 'member';
    stored = { manage_connectors: ['owner', 'admin', 'member'] };
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canEdit).toBe(false);
    const connectors = body.permissions.find((p: any) => p.name === 'manage_connectors');
    expect(connectors).toMatchObject({ defaultRoles: ['owner', 'admin'], roles: ['owner', 'admin', 'member'], locked: false, overridden: true });
    const del = body.permissions.find((p: any) => p.name === 'delete_team');
    expect(del).toMatchObject({ roles: ['owner'], locked: true, overridden: false });
  });

  it('an owner can edit; an admin cannot', async () => {
    principal = session(); memberRole = 'owner';
    expect((await (await get()).json()).canEdit).toBe(true);
    memberRole = 'admin';
    expect((await (await get()).json()).canEdit).toBe(false);
  });
});

describe('PUT', () => {
  it('an owner replaces the overrides; entries equal to the default are not stored', async () => {
    principal = session(); memberRole = 'owner';
    const res = await put({ overrides: { manage_connectors: ['admin', 'member'], run_experiments: ['owner', 'admin'] } });
    expect(res.status).toBe(200);
    expect(writes).toEqual([{ manage_connectors: ['owner', 'admin', 'member'] }]);
    const body = await res.json();
    expect(body.permissions.find((p: any) => p.name === 'manage_connectors').roles).toEqual(['owner', 'admin', 'member']);
  });

  it('an admin is refused, even though admins manage members and settings', async () => {
    principal = session(); memberRole = 'admin';
    expect((await put({ overrides: { manage_connectors: ['admin', 'member'] } })).status).toBe(403);
    expect(writes).toEqual([]);
  });

  it('an admin cannot unlock owner-only power by granting themselves manage_team_permissions', async () => {
    principal = session(); memberRole = 'owner';
    stored = { manage_team_permissions: ['owner', 'admin'] };
    memberRole = 'admin';
    expect((await put({ overrides: {} })).status).toBe(403);
  });

  it('an API key is refused', async () => {
    principal = adminKey();
    expect((await put({ overrides: {} })).status).toBe(403);
    expect(writes).toEqual([]);
  });

  it('400 with the reason for unknown, locked or malformed input; nothing written', async () => {
    principal = session(); memberRole = 'owner';
    for (const overrides of [{ nope: ['admin'] }, { delete_team: ['admin'] }, { manage_connectors: ['root'] }, { manage_connectors: 'admin' }]) {
      const res = await put({ overrides });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
    expect((await put({})).status).toBe(400);
    expect(writes).toEqual([]);
  });

  it('{} resets every permission to its default', async () => {
    principal = session(); memberRole = 'owner';
    stored = { manage_connectors: ['owner'] };
    expect((await put({ overrides: {} })).status).toBe(200);
    expect(writes).toEqual([{}]);
  });
});
