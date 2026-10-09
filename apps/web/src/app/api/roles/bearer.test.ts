/**
 * /api/roles from an MCP session: the bearer path (lib/roles-caller.ts).
 *
 * MCP's register_skill / update_skill / delete_skill { personal: true } call
 * these routes with the caller's own bearer. An OAuth session carries the
 * person (sessionUserId) and is authorized exactly like their dashboard
 * session, pinned to its workspace's team. A bld_ key or a per-task token has
 * no person, so it is refused with a reason and nothing is written.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  installPersonalRoleMocks, resetStore, store, teamRoles, bearer, addRole, jsonReq, params,
} from '@/lib/personal-roles.fixtures';

installPersonalRoleMocks();
const { GET, POST } = await import('./route');
const { PATCH, DELETE } = await import('./[id]/route');
const { POST: SHARE } = await import('./[id]/share/route');

const T = 'team-a';
const OTHER_T = 'team-b';
const AUTH = { authorization: 'Bearer oauth-jwt' };

function oauthAs(userId: string, teamId = T) {
  bearer.account = { id: 'acc-1', teamId, authType: 'oauth', level: 'worker', sessionUserId: userId };
}

const base = (extra: Record<string, unknown> = {}) => ({ name: 'My Helper', content: 'You help me', personal: true, ...extra });

beforeEach(() => {
  resetStore();
  teamRoles.member = { [T]: 'member', [OTHER_T]: 'member' };
  teamRoles.other = { [T]: 'member' };
});

describe('POST /api/roles with a bearer', () => {
  it('an OAuth member session creates a private personal role owned by that person, in the token team', async () => {
    oauthAs('member');
    const res = await POST(jsonReq('http://localhost/api/roles', 'POST', base(), AUTH));
    expect(res.status).toBe(201);
    expect(store.workspaceSkills).toHaveLength(1);
    expect(store.workspaceSkills[0]).toMatchObject({ teamId: T, ownerUserId: 'member', visibility: 'private', isRole: true });
  });

  it('pins an OAuth session to its token team: another team the person is in is not found', async () => {
    oauthAs('member', T);
    const res = await POST(jsonReq('http://localhost/api/roles', 'POST', base({ teamId: OTHER_T }), AUTH));
    expect(res.status).toBe(404);
    expect(store.workspaceSkills).toHaveLength(0);
  });

  it('an OAuth member session still cannot create a team role', async () => {
    oauthAs('member');
    const res = await POST(jsonReq('http://localhost/api/roles', 'POST', base({ personal: undefined }), AUTH));
    expect(res.status).toBe(403);
    expect(store.workspaceSkills).toHaveLength(0);
  });

  it('refuses a bld_ key with a reason: no person behind it', async () => {
    bearer.account = { id: 'acc-1', teamId: T, authType: 'api', level: 'admin' };
    const res = await POST(jsonReq('http://localhost/api/roles', 'POST', base(), AUTH));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('no person');
    expect(store.workspaceSkills).toHaveLength(0);
  });

  it('refuses a per-task token: it never creates a role for its requester', async () => {
    bearer.account = { id: 'acc-1', teamId: T, authType: 'api', level: 'worker', taskScope: { taskId: 't', workspaceId: 'w' } };
    const res = await POST(jsonReq('http://localhost/api/roles', 'POST', base(), AUTH));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('per-task token');
    expect(store.workspaceSkills).toHaveLength(0);
  });

  it('is 401 with an invalid bearer and no session', async () => {
    const res = await POST(jsonReq('http://localhost/api/roles', 'POST', base(), AUTH));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/roles with an OAuth bearer', () => {
  it("lists the session person's own private roles, marked mine, and never another member's private one", async () => {
    addRole({ teamId: T, slug: 'mine', isRole: true, ownerUserId: 'member', visibility: 'private' });
    addRole({ teamId: T, slug: 'theirs', isRole: true, ownerUserId: 'other', visibility: 'private' });
    addRole({ teamId: T, slug: 'shared', isRole: true, ownerUserId: 'other', visibility: 'team' });
    oauthAs('member');
    const res = await GET(jsonReq('http://localhost/api/roles', 'GET', undefined, AUTH));
    const { roles } = await res.json();
    const bySlug = Object.fromEntries(roles.map((r: any) => [r.slug, r]));
    expect(Object.keys(bySlug).sort()).toEqual(['mine', 'shared']);
    expect(bySlug.mine.mine).toBe(true);
    expect(bySlug.shared.mine).toBe(false);
  });
});

describe('PATCH / DELETE / share with an OAuth bearer', () => {
  it('the owner edits, shares and deletes their own personal role', async () => {
    const role = addRole({ teamId: T, slug: 'mine', isRole: true, ownerUserId: 'member', visibility: 'private' });
    oauthAs('member');

    const patched = await PATCH(jsonReq(`http://localhost/api/roles/${role.id}`, 'PATCH', { description: 'better' }, AUTH), params(role.id));
    expect(patched.status).toBe(200);
    expect(store.workspaceSkills[0].description).toBe('better');

    const shared = await SHARE(jsonReq(`http://localhost/api/roles/${role.id}/share`, 'POST', { visibility: 'team' }, AUTH), params(role.id));
    expect(shared.status).toBe(200);
    expect(store.workspaceSkills[0].visibility).toBe('team');

    const deleted = await DELETE(jsonReq(`http://localhost/api/roles/${role.id}`, 'DELETE', undefined, AUTH), params(role.id));
    expect(deleted.status).toBe(200);
    expect(store.workspaceSkills).toHaveLength(0);
  });

  it("another member's private role is not found over a bearer, and is left alone", async () => {
    const role = addRole({ teamId: T, slug: 'theirs', isRole: true, ownerUserId: 'other', visibility: 'private' });
    oauthAs('member');
    const shared = await SHARE(jsonReq(`http://localhost/api/roles/${role.id}/share`, 'POST', { visibility: 'team' }, AUTH), params(role.id));
    expect(shared.status).toBe(404);
    const deleted = await DELETE(jsonReq(`http://localhost/api/roles/${role.id}`, 'DELETE', undefined, AUTH), params(role.id));
    expect(deleted.status).toBe(404);
    expect(store.workspaceSkills[0]).toMatchObject({ visibility: 'private' });
  });

  it("an OAuth session cannot reach its person's role in a different team", async () => {
    const role = addRole({ teamId: OTHER_T, slug: 'elsewhere', isRole: true, ownerUserId: 'member', visibility: 'private' });
    oauthAs('member', T);
    const deleted = await DELETE(jsonReq(`http://localhost/api/roles/${role.id}`, 'DELETE', undefined, AUTH), params(role.id));
    expect(deleted.status).toBe(404);
    const shared = await SHARE(jsonReq(`http://localhost/api/roles/${role.id}/share`, 'POST', { visibility: 'team' }, AUTH), params(role.id));
    expect(shared.status).toBe(404);
    expect(store.workspaceSkills).toHaveLength(1);
  });

  it('a per-task token cannot edit a personal role', async () => {
    const role = addRole({ teamId: T, slug: 'mine', isRole: true, ownerUserId: 'member', visibility: 'private' });
    bearer.account = { id: 'acc-1', teamId: T, level: 'worker', taskScope: { taskId: 't', workspaceId: 'w' } };
    const res = await PATCH(jsonReq(`http://localhost/api/roles/${role.id}`, 'PATCH', { description: 'x' }, AUTH), params(role.id));
    expect(res.status).toBe(403);
    expect(store.workspaceSkills[0].description).toBeUndefined();
  });
});
