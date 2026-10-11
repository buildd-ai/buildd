import { describe, it, expect, beforeEach } from 'bun:test';
import {
  installPersonalRoleMocks, resetStore, store, teamRoles, session, addRole, jsonReq, params,
} from '@/lib/personal-roles.fixtures';

installPersonalRoleMocks();
const { GET, PATCH, DELETE } = await import('./route');
const overrides = await import('./overrides/route');

const T = 'team-a';

function as(userId: string) {
  session.user = { id: userId };
}

const url = (id: string) => `http://localhost/api/roles/${id}`;

let privateRole: Record<string, any>;
let sharedRole: Record<string, any>;

beforeEach(() => {
  resetStore();
  teamRoles.member = { [T]: 'member' };
  teamRoles.member2 = { [T]: 'member' };
  teamRoles.admin = { [T]: 'admin' };
  teamRoles.owner = { [T]: 'owner' };
  store.workspaces.push({ id: 'ws-1', teamId: T });
  privateRole = addRole({ teamId: T, slug: 'mine', name: 'Mine', ownerUserId: 'member', visibility: 'private', isRole: true });
  sharedRole = addRole({ teamId: T, slug: 'ours', name: 'Ours', ownerUserId: 'member', visibility: 'team', isRole: true });
});

describe('GET /api/roles/[id] on personal roles', () => {
  it('owner reads their private role', async () => {
    as('member');
    expect((await GET(jsonReq(url(privateRole.id), 'GET'), params(privateRole.id))).status).toBe(200);
  });

  for (const who of ['member2', 'admin', 'owner']) {
    it(`${who} gets 404 for another member's private role`, async () => {
      as(who);
      expect((await GET(jsonReq(url(privateRole.id), 'GET'), params(privateRole.id))).status).toBe(404);
    });
  }
});

describe('PATCH /api/roles/[id] on personal roles', () => {
  it('owner (a plain member) edits their own role', async () => {
    as('member');
    const res = await PATCH(jsonReq(url(privateRole.id), 'PATCH', { name: 'Renamed' }), params(privateRole.id));
    expect(res.status).toBe(200);
    expect(store.workspaceSkills.find(r => r.id === privateRole.id)!.name).toBe('Renamed');
  });

  it("another member cannot edit someone's private role, and it is unchanged", async () => {
    as('member2');
    const res = await PATCH(jsonReq(url(privateRole.id), 'PATCH', { name: 'Hijacked' }), params(privateRole.id));
    expect(res.status).toBe(404);
    expect(store.workspaceSkills.find(r => r.id === privateRole.id)!.name).toBe('Mine');
  });

  it("another member cannot edit someone's shared role (403), unchanged", async () => {
    as('member2');
    const res = await PATCH(jsonReq(url(sharedRole.id), 'PATCH', { name: 'Hijacked' }), params(sharedRole.id));
    expect(res.status).toBe(403);
    expect(store.workspaceSkills.find(r => r.id === sharedRole.id)!.name).toBe('Ours');
  });

  for (const who of ['admin', 'owner']) {
    it(`${who} (manage_agent_roles) edits a shared personal role`, async () => {
      as(who);
      const res = await PATCH(jsonReq(url(sharedRole.id), 'PATCH', { name: 'Tidied' }), params(sharedRole.id));
      expect(res.status).toBe(200);
      expect(store.workspaceSkills.find(r => r.id === sharedRole.id)!.name).toBe('Tidied');
    });
  }

  it('refuses an operatorGrant, metadata untouched', async () => {
    const op = addRole({ teamId: T, slug: 'operator', ownerUserId: 'member', visibility: 'private', isRole: true, metadata: {} });
    as('member');
    const res = await PATCH(jsonReq(url(op.id), 'PATCH', { operatorGrant: { enabled: true } }), params(op.id));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('operatorGrant');
    expect(store.workspaceSkills.find(r => r.id === op.id)!.metadata).toEqual({});
  });

  it("refuses a foreign secret even when an admin edits a shared role (owner's secrets only)", async () => {
    store.secrets.push({ id: 's1', teamId: T, userId: 'admin', label: 'ADMIN_TOKEN' });
    as('admin');
    const res = await PATCH(jsonReq(url(sharedRole.id), 'PATCH', { requiredEnvVars: { TOKEN: 'ADMIN_TOKEN' } }), params(sharedRole.id));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('requiredEnvVars');
    expect(store.workspaceSkills.find(r => r.id === sharedRole.id)!.requiredEnvVars).toEqual({});
  });

  it('refuses a connector the team cannot use', async () => {
    store.connectors.push({ id: 'c-x', teamId: 'team-z', url: 'https://x.example' });
    as('member');
    const res = await PATCH(jsonReq(url(privateRole.id), 'PATCH', { connectorRefs: ['c-x'] }), params(privateRole.id));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('connectorRefs');
    expect(store.workspaceSkills.find(r => r.id === privateRole.id)!.connectorRefs).toEqual([]);
  });

  it('refuses moving a personal role into a workspace', async () => {
    as('member');
    const res = await PATCH(jsonReq(url(privateRole.id), 'PATCH', { workspaceId: 'ws-1' }), params(privateRole.id));
    expect(res.status).toBe(400);
    expect(store.workspaceSkills.find(r => r.id === privateRole.id)!.workspaceId).toBeNull();
  });

  it("a member still cannot edit a team role", async () => {
    const team = addRole({ teamId: T, slug: 'builder', name: 'Builder', isRole: true });
    as('member');
    const res = await PATCH(jsonReq(url(team.id), 'PATCH', { name: 'Mine now' }), params(team.id));
    expect(res.status).toBe(403);
    expect(store.workspaceSkills.find(r => r.id === team.id)!.name).toBe('Builder');
  });
});

describe('DELETE /api/roles/[id] on personal roles', () => {
  it('owner deletes their own role', async () => {
    as('member');
    expect((await DELETE(jsonReq(url(privateRole.id), 'DELETE'), params(privateRole.id))).status).toBe(200);
    expect(store.workspaceSkills.some(r => r.id === privateRole.id)).toBe(false);
  });

  it("another member cannot delete someone's shared role", async () => {
    as('member2');
    expect((await DELETE(jsonReq(url(sharedRole.id), 'DELETE'), params(sharedRole.id))).status).toBe(403);
    expect(store.workspaceSkills.some(r => r.id === sharedRole.id)).toBe(true);
  });

  it("an admin cannot delete someone's private role (invisible)", async () => {
    as('admin');
    expect((await DELETE(jsonReq(url(privateRole.id), 'DELETE'), params(privateRole.id))).status).toBe(404);
    expect(store.workspaceSkills.some(r => r.id === privateRole.id)).toBe(true);
  });

  it('an admin deletes a shared personal role', async () => {
    as('admin');
    expect((await DELETE(jsonReq(url(sharedRole.id), 'DELETE'), params(sharedRole.id))).status).toBe(200);
    expect(store.workspaceSkills.some(r => r.id === sharedRole.id)).toBe(false);
  });
});

describe('POST /api/roles/[id]/overrides on personal roles', () => {
  it('400s for the owner: personal roles have no workspace overrides', async () => {
    as('member');
    const before = store.workspaceSkills.length;
    const res = await overrides.POST(jsonReq(`${url(privateRole.id)}/overrides`, 'POST', { workspaceId: 'ws-1', content: 'x' }), params(privateRole.id));
    expect(res.status).toBe(400);
    expect(store.workspaceSkills).toHaveLength(before);
  });

  it("404s for an admin on someone's private role", async () => {
    as('admin');
    const res = await overrides.POST(jsonReq(`${url(privateRole.id)}/overrides`, 'POST', { workspaceId: 'ws-1' }), params(privateRole.id));
    expect(res.status).toBe(404);
  });

  it('400s for an admin on a shared personal role', async () => {
    as('admin');
    const before = store.workspaceSkills.length;
    const res = await overrides.POST(jsonReq(`${url(sharedRole.id)}/overrides`, 'POST', { workspaceId: 'ws-1' }), params(sharedRole.id));
    expect(res.status).toBe(400);
    expect(store.workspaceSkills).toHaveLength(before);
  });
});
