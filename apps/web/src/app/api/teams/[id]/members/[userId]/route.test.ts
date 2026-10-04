/**
 * PATCH / DELETE /api/teams/[id]/members/[userId] — who may change a member's
 * role, who may remove a member, and who may remove an owner.
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

mock.module('@/lib/auth-helpers', () => ({
  requireSessionUser: async () => ({ user: { id: 'caller' } }),
  getRequestPrincipal: async () => ({ kind: 'user', user: { id: 'caller' } }),
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
}));

mock.module('@buildd/core/db/schema', () => ({
  teamMembers: { teamId: 'teamMembers.teamId', userId: 'teamMembers.userId', role: 'teamMembers.role' },
}));

function userIdIn(where: any): string | undefined {
  return where?.args?.find((c: any) => c.a === 'teamMembers.userId')?.b;
}

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamMembers: {
        findFirst: async (q: any) => {
          const userId = userIdIn(q.where);
          const m = userId ? memberships[userId] : undefined;
          return m ? { teamId: TEAM, userId, ...m } : undefined;
        },
        // Owner count for the last-owner guards.
        findMany: async () =>
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

  it('403s an admin, even moving member → admin', async () => {
    memberships.caller = { role: 'admin' };
    memberships.target = { role: 'member' };
    const res = await patch('target', { role: 'admin' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Only owners can change roles');
    expect(updates).toHaveLength(0);
  });

  it('lets an owner change a role', async () => {
    memberships.caller = { role: 'owner' };
    memberships.target = { role: 'member' };
    expect((await patch('target', { role: 'admin' })).status).toBe(200);
    expect(updates).toEqual([{ role: 'admin' }]);
  });

  it('keeps the last owner from demoting themselves', async () => {
    memberships.caller = { role: 'owner' };
    expect((await patch('caller', { role: 'admin' })).status).toBe(400);
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

  it('refuses an owner removing themselves', async () => {
    memberships.caller = { role: 'owner' };
    memberships.other = { role: 'owner' };
    expect((await del('caller')).status).toBe(400);
    expect(deletes).toBe(0);
  });
});
