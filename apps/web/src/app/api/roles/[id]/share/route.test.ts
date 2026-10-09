import { describe, it, expect, beforeEach } from 'bun:test';
import {
  installPersonalRoleMocks, resetStore, store, teamRoles, session, addRole, jsonReq, params,
} from '@/lib/personal-roles.fixtures';

installPersonalRoleMocks();
const { POST } = await import('./route');

const T = 'team-a';
const share = (id: string, body: unknown) => POST(jsonReq(`http://localhost/api/roles/${id}/share`, 'POST', body), params(id));
const row = (id: string) => store.workspaceSkills.find(r => r.id === id)!;

function as(userId: string) {
  session.user = { id: userId };
}

let mine: Record<string, any>;

beforeEach(() => {
  resetStore();
  teamRoles.member = { [T]: 'member' };
  teamRoles.member2 = { [T]: 'member' };
  teamRoles.admin = { [T]: 'admin' };
  teamRoles.owner = { [T]: 'owner' };
  mine = addRole({ teamId: T, slug: 'mine', ownerUserId: 'member', visibility: 'private', isRole: true });
});

describe('POST /api/roles/[id]/share', () => {
  it('owner (a plain member) shares their role with the team', async () => {
    as('member');
    const res = await share(mine.id, { visibility: 'team' });
    expect(res.status).toBe(200);
    expect(row(mine.id).visibility).toBe('team');
  });

  it('owner takes a shared role back to private', async () => {
    row(mine.id).visibility = 'team';
    as('member');
    expect((await share(mine.id, { visibility: 'private' })).status).toBe(200);
    expect(row(mine.id).visibility).toBe('private');
  });

  it('rejects an unknown visibility', async () => {
    as('member');
    expect((await share(mine.id, { visibility: 'public' })).status).toBe(400);
    expect(row(mine.id).visibility).toBe('private');
  });

  it("another member gets 404 on someone's private role", async () => {
    as('member2');
    expect((await share(mine.id, { visibility: 'team' })).status).toBe(404);
    expect(row(mine.id).visibility).toBe('private');
  });

  it("another member cannot unshare someone's shared role (403)", async () => {
    row(mine.id).visibility = 'team';
    as('member2');
    expect((await share(mine.id, { visibility: 'private' })).status).toBe(403);
    expect(row(mine.id).visibility).toBe('team');
  });

  for (const who of ['admin', 'owner']) {
    it(`${who} can unshare a shared personal role`, async () => {
      row(mine.id).visibility = 'team';
      as(who);
      expect((await share(mine.id, { visibility: 'private' })).status).toBe(200);
      expect(row(mine.id).visibility).toBe('private');
    });
  }

  it('409 when a team role already has the slug', async () => {
    addRole({ teamId: T, slug: 'mine', isRole: true });
    as('member');
    const res = await share(mine.id, { visibility: 'team' });
    expect(res.status).toBe(409);
    expect(row(mine.id).visibility).toBe('private');
  });

  it("409 when another member's shared personal role has the slug", async () => {
    addRole({ teamId: T, slug: 'mine', ownerUserId: 'member2', visibility: 'team', isRole: true });
    as('member');
    expect((await share(mine.id, { visibility: 'team' })).status).toBe(409);
    expect(row(mine.id).visibility).toBe('private');
  });

  it("no clash with another member's private role, a workspace override, or another team", async () => {
    addRole({ teamId: T, slug: 'mine', ownerUserId: 'member2', visibility: 'private', isRole: true });
    addRole({ teamId: T, slug: 'mine', workspaceId: 'ws-1', isRole: true });
    addRole({ teamId: 'team-z', slug: 'mine', isRole: true });
    as('member');
    expect((await share(mine.id, { visibility: 'team' })).status).toBe(200);
    expect(row(mine.id).visibility).toBe('team');
  });

  it('400 on a team role', async () => {
    const team = addRole({ teamId: T, slug: 'builder', isRole: true });
    as('admin');
    expect((await share(team.id, { visibility: 'private' })).status).toBe(400);
    expect(row(team.id).visibility).toBe('team');
  });
});
