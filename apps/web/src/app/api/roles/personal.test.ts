import { describe, it, expect, beforeEach } from 'bun:test';
import {
  installPersonalRoleMocks, resetStore, store, teamRoles, session, addRole, jsonReq,
} from '@/lib/personal-roles.fixtures';

installPersonalRoleMocks();
const { GET, POST } = await import('./route');

const T = 'team-a';
const OTHER_T = 'team-b';

function as(userId: string) {
  session.user = { id: userId };
}

function base(extra: Record<string, unknown> = {}) {
  return { name: 'My Helper', content: 'You help me', ...extra };
}

beforeEach(() => {
  resetStore();
  teamRoles.member = { [T]: 'member' };
  teamRoles.admin = { [T]: 'admin' };
  teamRoles.owner = { [T]: 'owner' };
  teamRoles.multi = { [T]: 'member', [OTHER_T]: 'member' };
});

describe('POST /api/roles { personal: true }', () => {
  for (const who of ['member', 'admin', 'owner']) {
    it(`${who} creates a private personal role owned by them`, async () => {
      as(who);
      const res = await POST(jsonReq('http://localhost/api/roles', 'POST', base({ personal: true })));
      expect(res.status).toBe(201);
      expect(store.workspaceSkills).toHaveLength(1);
      expect(store.workspaceSkills[0]).toMatchObject({
        teamId: T, workspaceId: null, ownerUserId: who, visibility: 'private', isRole: true, slug: 'my-helper',
      });
    });
  }

  it('member cannot create a team role, and nothing is written', async () => {
    as('member');
    const res = await POST(jsonReq('http://localhost/api/roles', 'POST', base()));
    expect(res.status).toBe(403);
    expect(store.workspaceSkills).toHaveLength(0);
  });

  it('admin still creates a team role (owner NULL)', async () => {
    as('admin');
    const res = await POST(jsonReq('http://localhost/api/roles', 'POST', base()));
    expect(res.status).toBe(201);
    expect(store.workspaceSkills[0]).toMatchObject({ teamId: T, ownerUserId: null, visibility: 'team' });
  });

  it('refuses an operatorGrant on a personal role, naming the field', async () => {
    as('member');
    const res = await POST(jsonReq('http://localhost/api/roles', 'POST', base({
      personal: true, slug: 'operator', operatorGrant: { enabled: true },
    })));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('operatorGrant');
    expect(store.workspaceSkills).toHaveLength(0);
  });

  it("refuses requiredEnvVars mapped to someone else's secret", async () => {
    store.secrets.push({ id: 's1', teamId: T, userId: 'admin', label: 'NPM_TOKEN', purpose: 'role_env_secret' });
    store.secrets.push({ id: 's2', teamId: T, userId: null, label: 'TEAM_TOKEN', purpose: 'role_env_secret' });
    as('member');
    for (const label of ['NPM_TOKEN', 'TEAM_TOKEN']) {
      const res = await POST(jsonReq('http://localhost/api/roles', 'POST', base({
        personal: true, requiredEnvVars: { NPM_TOKEN: label },
      })));
      expect(res.status).toBe(400);
      expect((await res.json()).field).toBe('requiredEnvVars');
    }
    expect(store.workspaceSkills).toHaveLength(0);
  });

  it('accepts requiredEnvVars mapped to the owner’s own secret (and runner-provided vars)', async () => {
    store.secrets.push({ id: 's1', teamId: T, userId: 'member', label: 'MY_TOKEN', purpose: 'role_env_secret' });
    as('member');
    const res = await POST(jsonReq('http://localhost/api/roles', 'POST', base({
      personal: true, requiredEnvVars: { NPM_TOKEN: 'MY_TOKEN', BUILDD_API_KEY: 'whatever' },
    })));
    expect(res.status).toBe(201);
    expect(store.workspaceSkills[0].requiredEnvVars).toEqual({ NPM_TOKEN: 'MY_TOKEN', BUILDD_API_KEY: 'whatever' });
  });

  it('accepts a connector owned by or shared to the team; refuses a foreign one', async () => {
    store.connectors.push({ id: 'c-own', teamId: T, url: 'https://a.example' });
    store.connectors.push({ id: 'c-shared', teamId: OTHER_T, url: 'https://b.example' });
    store.connectors.push({ id: 'c-foreign', teamId: OTHER_T, url: 'https://c.example' });
    store.connectorShares.push({ connectorId: 'c-shared', sharedWithTeamId: T });
    as('member');

    const ok = await POST(jsonReq('http://localhost/api/roles', 'POST', base({ personal: true, connectorRefs: ['c-own', 'c-shared'] })));
    expect(ok.status).toBe(201);

    const bad = await POST(jsonReq('http://localhost/api/roles', 'POST', base({ personal: true, slug: 'two', connectorRefs: ['c-foreign'] })));
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(body.field).toBe('connectorRefs');
    expect(body.error).toContain('c-foreign');
    expect(store.workspaceSkills).toHaveLength(1);
  });

  it('refuses a duplicate personal slug for the same owner (409)', async () => {
    addRole({ teamId: T, slug: 'my-helper', ownerUserId: 'member', visibility: 'private', isRole: true });
    as('member');
    const res = await POST(jsonReq('http://localhost/api/roles', 'POST', base({ personal: true })));
    expect(res.status).toBe(409);
    expect(store.workspaceSkills).toHaveLength(1);
  });

  it('a private personal role may share a team role’s slug', async () => {
    addRole({ teamId: T, slug: 'my-helper', isRole: true });
    as('member');
    const res = await POST(jsonReq('http://localhost/api/roles', 'POST', base({ personal: true })));
    expect(res.status).toBe(201);
  });

  it('a team role may not take a shared personal role’s slug, but may take a private one’s', async () => {
    addRole({ teamId: T, slug: 'my-helper', ownerUserId: 'member', visibility: 'private', isRole: true });
    as('admin');
    expect((await POST(jsonReq('http://localhost/api/roles', 'POST', base()))).status).toBe(201);

    addRole({ teamId: T, slug: 'shared-one', ownerUserId: 'member', visibility: 'team', isRole: true });
    const res = await POST(jsonReq('http://localhost/api/roles', 'POST', base({ slug: 'shared-one' })));
    expect(res.status).toBe(409);
  });

  describe('target team', () => {
    it('uses body.teamId when it is one of the caller’s teams', async () => {
      as('multi');
      const res = await POST(jsonReq('http://localhost/api/roles', 'POST', base({ personal: true, teamId: OTHER_T })));
      expect(res.status).toBe(201);
      expect(store.workspaceSkills[0].teamId).toBe(OTHER_T);
    });

    it('404s a teamId the caller is not in', async () => {
      as('member');
      const res = await POST(jsonReq('http://localhost/api/roles', 'POST', base({ personal: true, teamId: OTHER_T })));
      expect(res.status).toBe(404);
      expect(store.workspaceSkills).toHaveLength(0);
    });

    it('falls back to the active-team cookie, not the first membership', async () => {
      as('multi');
      const req = jsonReq('http://localhost/api/roles', 'POST', base({ personal: true }));
      req.cookies.set('buildd-team', OTHER_T);
      const res = await POST(req);
      expect(res.status).toBe(201);
      expect(store.workspaceSkills[0].teamId).toBe(OTHER_T);
    });
  });
});

describe('GET /api/roles', () => {
  beforeEach(() => {
    store.workspaces.push({ id: 'ws-1', teamId: T });
    store.users.push({ id: 'member', name: 'Mem Ber' }, { id: 'admin', name: 'Ad Min' });
    addRole({ teamId: T, slug: 'builder', isRole: true });
    addRole({ teamId: T, slug: 'mine-private', ownerUserId: 'member', visibility: 'private', isRole: true });
    addRole({ teamId: T, slug: 'admins-private', ownerUserId: 'admin', visibility: 'private', isRole: true });
    addRole({ teamId: T, slug: 'admins-shared', ownerUserId: 'admin', visibility: 'team', isRole: true });
    addRole({ teamId: OTHER_T, slug: 'elsewhere', ownerUserId: 'x', visibility: 'team', isRole: true });
  });

  it('lists team roles, the caller’s own personal roles and shared ones with owner name; never others’ private ones', async () => {
    as('member');
    const res = await GET(jsonReq('http://localhost/api/roles', 'GET'));
    expect(res.status).toBe(200);
    const { roles } = await res.json();
    const slugs = roles.map((r: any) => r.slug).sort();
    expect(slugs).toEqual(['admins-shared', 'builder', 'mine-private']);
    const shared = roles.find((r: any) => r.slug === 'admins-shared');
    expect(shared).toMatchObject({ personal: true, visibility: 'team', ownerUserId: 'admin', ownerName: 'Ad Min' });
    expect(roles.find((r: any) => r.slug === 'builder').personal).toBeUndefined();
  });

  it('an admin does not see a member’s private role either', async () => {
    as('admin');
    const { roles } = await (await GET(jsonReq('http://localhost/api/roles', 'GET'))).json();
    expect(roles.map((r: any) => r.slug)).not.toContain('mine-private');
    expect(roles.map((r: any) => r.slug)).toContain('admins-private');
  });
});
