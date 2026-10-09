import { describe, it, expect, beforeEach } from 'bun:test';
import {
  installPersonalRoleMocks, resetStore, store, teamRoles, session, addRole, jsonReq, params,
} from '@/lib/personal-roles.fixtures';

installPersonalRoleMocks();
const { POST } = await import('./route');

const T = 'team-a';
const promote = (id: string) => POST(jsonReq(`http://localhost/api/roles/${id}/promote`, 'POST'), params(id));
const row = (id: string) => store.workspaceSkills.find(r => r.id === id)!;

function as(userId: string) {
  session.user = { id: userId };
}

let shared: Record<string, any>;

beforeEach(() => {
  resetStore();
  teamRoles.member = { [T]: 'member' };
  teamRoles.admin = { [T]: 'admin' };
  teamRoles.owner = { [T]: 'owner' };
  shared = addRole({ teamId: T, slug: 'ours', ownerUserId: 'member', visibility: 'team', isRole: true });
});

describe('POST /api/roles/[id]/promote', () => {
  for (const who of ['admin', 'owner']) {
    it(`${who} turns a shared personal role into a team role, keeping the slug`, async () => {
      as(who);
      const res = await promote(shared.id);
      expect(res.status).toBe(200);
      expect(row(shared.id)).toMatchObject({ ownerUserId: null, visibility: 'team', slug: 'ours' });
    });
  }

  it('the owner, a plain member, cannot promote their own role', async () => {
    as('member');
    expect((await promote(shared.id)).status).toBe(403);
    expect(row(shared.id).ownerUserId).toBe('member');
  });

  it('a private role must be shared first (and stays invisible to admins)', async () => {
    const priv = addRole({ teamId: T, slug: 'mine', ownerUserId: 'admin', visibility: 'private', isRole: true });
    as('admin');
    expect((await promote(priv.id)).status).toBe(409);
    expect(row(priv.id).ownerUserId).toBe('admin');

    const others = addRole({ teamId: T, slug: 'theirs', ownerUserId: 'member', visibility: 'private', isRole: true });
    expect((await promote(others.id)).status).toBe(404);
    expect(row(others.id).ownerUserId).toBe('member');
  });

  it('409 if a team role has meanwhile taken the slug', async () => {
    addRole({ teamId: T, slug: 'ours', isRole: true });
    as('admin');
    expect((await promote(shared.id)).status).toBe(409);
    expect(row(shared.id).ownerUserId).toBe('member');
  });

  it("warns that env vars mapped to the owner's secrets need team secrets", async () => {
    row(shared.id).requiredEnvVars = { NPM_TOKEN: 'MY_TOKEN', BUILDD_API_KEY: 'k' };
    as('admin');
    const body = await (await promote(shared.id)).json();
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain('NPM_TOKEN');
    expect(body.warnings[0]).not.toContain('BUILDD_API_KEY');
  });

  it('400 on a role that is already a team role', async () => {
    const team = addRole({ teamId: T, slug: 'builder', isRole: true });
    as('admin');
    expect((await promote(team.id)).status).toBe(400);
  });
});
