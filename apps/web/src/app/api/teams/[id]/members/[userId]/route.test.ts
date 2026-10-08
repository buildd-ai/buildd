/**
 * PATCH / DELETE /api/teams/[id]/members/[userId] — who may change a member's
 * role, who may remove a member, who may remove an owner, and who may leave.
 *
 * The db mock answers each teamMembers lookup from the `userId` in its where
 * clause, so a test asserts the role decision (whether a write happened), not
 * just a status a mocked db would return anyway.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = '11111111-1111-4111-8111-111111111111';

let memberships: Record<string, { role: string } | undefined> = {};
const updates: any[] = [];
let deletes = 0;
// The team row: its slug (personal or not) and its permission overrides.
let team: { slug: string; permissionOverrides: unknown };
// When set, what the owner-count query returns instead of the owners in `memberships`.
let ownerRows: { userId: string }[] | null = null;

mock.module('@/lib/auth-helpers', () => ({
  requireSessionUser: async () => ({ user: { id: 'caller' } }),
  getRequestPrincipal: async () => ({ kind: 'user', user: { id: 'caller' } }),
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
}));

mock.module('@buildd/core/db/schema', () => ({ teams: { id: 'teams.id', permissionOverrides: 'teams.permission_overrides' },
  teamMembers: { teamId: 'teamMembers.teamId', userId: 'teamMembers.userId', role: 'teamMembers.role' },
}));

function userIdIn(where: any): string | undefined {
  return where?.args?.find((c: any) => c.a === 'teamMembers.userId')?.b;
}

mock.module('@buildd/core/db', () => ({
  db: {
    query: { teams: { findFirst: async () => team },
      teamMembers: {
        findFirst: async (q: any) => {
          const userId = userIdIn(q.where);
          const m = userId ? memberships[userId] : undefined;
          return m ? { teamId: TEAM, userId, ...m } : undefined;
        },
        // Owner count for the last-owner guards.
        findMany: async () => ownerRows ??
          Object.entries(memberships).filter(([, m]) => m?.role === 'owner').map(([userId]) => ({ userId })),
      },
    },
    update: () => ({ set: (v: any) => ({ where: async () => { updates.push(v); } }) }),
    delete: () => ({ where: async () => { deletes++; } }),
  },
}));

import { PATCH, DELETE } from './route';

const ctx = (userId: string) => ({ params: Promise.resolve({ id: TEAM, userId }) });

function patch(target: string, body: unknown) {
  return PATCH(
    new NextRequest(`http://localhost:3000/api/teams/${TEAM}/members/${target}`, {
      method: 'PATCH',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    }),
    ctx(target),
  );
}

function del(target: string) {
  return DELETE(
    new NextRequest(`http://localhost:3000/api/teams/${TEAM}/members/${target}`, { method: 'DELETE' }),
    ctx(target),
  );
}

beforeEach(() => {
  memberships = {};
  updates.length = 0;
  deletes = 0;
  team = { slug: 'acme', permissionOverrides: null };
  ownerRows = null;
});

describe('PATCH /api/teams/[id]/members/[userId] — change a role', () => {
  it('403s a non-member', async () => {
    memberships.target = { role: 'member' };
    expect((await patch('target', { role: 'admin' })).status).toBe(403);
    expect(updates).toHaveLength(0);
  });

  it('403s a member', async () => {
    memberships.caller = { role: 'member' };
    memberships.target = { role: 'member' };
    expect((await patch('target', { role: 'admin' })).status).toBe(403);
    expect(updates).toHaveLength(0);
  });

  it('lets an admin move a member to admin', async () => {
    memberships.caller = { role: 'admin' };
    memberships.target = { role: 'member' };
    expect((await patch('target', { role: 'admin' })).status).toBe(200);
    expect(updates).toEqual([{ role: 'admin' }]);
  });

  it('lets an admin move an admin to member', async () => {
    memberships.caller = { role: 'admin' };
    memberships.target = { role: 'admin' };
    expect((await patch('target', { role: 'member' })).status).toBe(200);
    expect(updates).toEqual([{ role: 'member' }]);
  });

  it('403s an admin promoting anyone to owner, naming the missing permission', async () => {
    memberships.caller = { role: 'admin' };
    memberships.target = { role: 'member' };
    const res = await patch('target', { role: 'owner' });
    expect(res.status).toBe(403);
    const { error } = await res.json();
    expect(error).toContain('assign_team_owner');
    expect(error).not.toContain('Only owners can change roles');
    expect(updates).toHaveLength(0);
  });

  it('403s an admin demoting an owner, even when another owner remains', async () => {
    memberships.caller = { role: 'admin' };
    memberships.target = { role: 'owner' };
    memberships.other = { role: 'owner' };
    const res = await patch('target', { role: 'admin' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('assign_team_owner');
    expect(updates).toHaveLength(0);
  });

  it('403s a member whose team has not granted assign_team_roles', async () => {
    memberships.caller = { role: 'member' };
    memberships.target = { role: 'member' };
    const res = await patch('target', { role: 'admin' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('assign_team_roles');
    expect(updates).toHaveLength(0);
  });

  it('honours a team that grants assign_team_roles to members', async () => {
    team.permissionOverrides = { assign_team_roles: ['owner', 'admin', 'member'] };
    memberships.caller = { role: 'member' };
    memberships.target = { role: 'member' };
    expect((await patch('target', { role: 'admin' })).status).toBe(200);
    expect(updates).toEqual([{ role: 'admin' }]);
  });

  it('a team that narrows assign_team_roles to owners refuses admins', async () => {
    team.permissionOverrides = { assign_team_roles: ['owner'] };
    memberships.caller = { role: 'admin' };
    memberships.target = { role: 'member' };
    expect((await patch('target', { role: 'admin' })).status).toBe(403);
    expect(updates).toHaveLength(0);
  });

  it('lets an owner change a role', async () => {
    memberships.caller = { role: 'owner' };
    memberships.target = { role: 'member' };
    expect((await patch('target', { role: 'admin' })).status).toBe(200);
    expect(updates).toEqual([{ role: 'admin' }]);
  });

  it('lets an owner promote a member to owner', async () => {
    memberships.caller = { role: 'owner' };
    memberships.target = { role: 'member' };
    expect((await patch('target', { role: 'owner' })).status).toBe(200);
    expect(updates).toEqual([{ role: 'owner' }]);
  });

  it('lets an owner demote another owner when one remains', async () => {
    memberships.caller = { role: 'owner' };
    memberships.target = { role: 'owner' };
    expect((await patch('target', { role: 'member' })).status).toBe(200);
    expect(updates).toEqual([{ role: 'member' }]);
  });

  it('keeps the last owner from demoting themselves', async () => {
    memberships.caller = { role: 'owner' };
    expect((await patch('caller', { role: 'admin' })).status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it('lets an owner step down when another owner remains', async () => {
    memberships.caller = { role: 'owner' };
    memberships.other = { role: 'owner' };
    expect((await patch('caller', { role: 'admin' })).status).toBe(200);
    expect(updates).toEqual([{ role: 'admin' }]);
  });

  it('keeps the last owner from being demoted by anyone, not only themselves', async () => {
    // The guard reads the current owner count, not "is the caller the target":
    // here the owner rows the count sees are the target's alone.
    memberships.caller = { role: 'owner' };
    memberships.target = { role: 'owner' };
    ownerRows = [{ userId: 'target' }];
    const res = await patch('target', { role: 'member' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/last owner/i);
    expect(updates).toHaveLength(0);
  });
});

describe('DELETE /api/teams/[id]/members/[userId] — remove a member', () => {
  it('404s a non-member', async () => {
    memberships.target = { role: 'member' };
    expect((await del('target')).status).toBe(404);
    expect(deletes).toBe(0);
  });

  it('403s a member', async () => {
    memberships.caller = { role: 'member' };
    memberships.target = { role: 'member' };
    expect((await del('target')).status).toBe(403);
    expect(deletes).toBe(0);
  });

  it('lets an admin remove a member', async () => {
    memberships.caller = { role: 'admin' };
    memberships.target = { role: 'member' };
    expect((await del('target')).status).toBe(200);
    expect(deletes).toBe(1);
  });

  it('403s an admin removing an owner, even when another owner remains', async () => {
    memberships.caller = { role: 'admin' };
    memberships.target = { role: 'owner' };
    memberships.other = { role: 'owner' };
    const res = await del('target');
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Admins cannot remove owners');
    expect(deletes).toBe(0);
  });

  it('lets an owner remove another owner when one remains', async () => {
    memberships.caller = { role: 'owner' };
    memberships.target = { role: 'owner' };
    expect((await del('target')).status).toBe(200);
    expect(deletes).toBe(1);
  });

  it('lets an owner remove an admin', async () => {
    memberships.caller = { role: 'owner' };
    memberships.target = { role: 'admin' };
    expect((await del('target')).status).toBe(200);
    expect(deletes).toBe(1);
  });
});

describe('DELETE /api/teams/[id]/members/[userId] — leave the team', () => {
  it('lets a member leave without manage_team_members', async () => {
    memberships.caller = { role: 'member' };
    memberships.owner = { role: 'owner' };
    expect((await del('caller')).status).toBe(200);
    expect(deletes).toBe(1);
  });

  it('lets an admin leave', async () => {
    memberships.caller = { role: 'admin' };
    memberships.owner = { role: 'owner' };
    expect((await del('caller')).status).toBe(200);
    expect(deletes).toBe(1);
  });

  it('lets an owner leave when another owner remains', async () => {
    memberships.caller = { role: 'owner' };
    memberships.other = { role: 'owner' };
    expect((await del('caller')).status).toBe(200);
    expect(deletes).toBe(1);
  });

  it('refuses the last owner leaving', async () => {
    memberships.caller = { role: 'owner' };
    memberships.target = { role: 'member' };
    const res = await del('caller');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/last owner/i);
    expect(deletes).toBe(0);
  });

  it('refuses leaving a personal team', async () => {
    team.slug = 'personal-caller';
    memberships.caller = { role: 'owner' };
    memberships.other = { role: 'owner' };
    const res = await del('caller');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/personal/i);
    expect(deletes).toBe(0);
  });

  it('404s leaving a team you are not in', async () => {
    expect((await del('caller')).status).toBe(404);
    expect(deletes).toBe(0);
  });
});
