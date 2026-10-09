import { describe, it, expect, beforeEach } from 'bun:test';
import {
  installPersonalRoleMocks, resetStore, store, teamRoles, session, addRole, jsonReq, params,
} from '@/lib/personal-roles.fixtures';

installPersonalRoleMocks();
const { GET, POST } = await import('./route');
const one = await import('./[skillId]/route');

const T = 'team-a';
const WS = 'ws-1';

beforeEach(() => {
  resetStore();
  teamRoles.admin = { [T]: 'admin' };
  store.workspaces.push({ id: WS, teamId: T });
  session.user = { id: 'admin' };
});

describe('workspace skills routes and personal roles', () => {
  it('POST refuses a personal role and directs to /api/roles; nothing is written', async () => {
    const res = await POST(jsonReq(`http://localhost/api/workspaces/${WS}/skills`, 'POST', {
      name: 'Mine', content: 'x', isRole: true, personal: true,
    }), params(WS));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('/api/roles');
    expect(store.workspaceSkills).toHaveLength(0);
  });

  it('GET never lists personal roles, shared or private', async () => {
    addRole({ teamId: T, slug: 'builder', isRole: true });
    addRole({ teamId: T, slug: 'shared-one', ownerUserId: 'm', visibility: 'team', isRole: true });
    addRole({ teamId: T, slug: 'private-one', ownerUserId: 'm', visibility: 'private', isRole: true });
    const res = await GET(jsonReq(`http://localhost/api/workspaces/${WS}/skills`, 'GET'), params(WS));
    expect(res.status).toBe(200);
    const { skills } = await res.json();
    expect(skills.map((s: any) => s.slug)).toEqual(['builder']);
  });

  it('GET /skills/[skillId] does not resolve a personal role through the team fallback', async () => {
    const priv = addRole({ teamId: T, slug: 'private-one', ownerUserId: 'm', visibility: 'private', isRole: true });
    const res = await one.GET(
      jsonReq(`http://localhost/api/workspaces/${WS}/skills/${priv.id}`, 'GET'),
      { params: Promise.resolve({ id: WS, skillId: priv.id }) },
    );
    expect(res.status).toBe(404);
  });
});
