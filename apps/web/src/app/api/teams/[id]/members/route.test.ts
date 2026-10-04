/**
 * POST /api/teams/[id]/members — who may add a member, and who may add an owner.
 *
 * The db mock answers each teamMembers lookup from the `userId` in its where
 * clause, so a test asserts the role decision (whether an insert happened),
 * not just a status a mocked db would return anyway.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = '11111111-1111-4111-8111-111111111111';

let memberships: Record<string, { role: string } | undefined> = {};
const inserted: any[] = [];

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
  users: { id: 'users.id' },
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
        findMany: async () => [],
      },
      users: { findFirst: async () => ({ id: 'target' }) },
    },
    insert: () => ({ values: async (v: any) => { inserted.push(v); } }),
  },
}));

import { POST } from './route';

const ctx = { params: Promise.resolve({ id: TEAM }) };

function post(body: unknown) {
  return POST(
    new NextRequest(`http://localhost:3000/api/teams/${TEAM}/members`, {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    }),
    ctx,
  );
}

beforeEach(() => {
  memberships = {};
  inserted.length = 0;
});

describe('POST /api/teams/[id]/members', () => {
  it('404s a caller who is not in the team', async () => {
    const res = await post({ userId: 'target', role: 'member' });
    expect(res.status).toBe(404);
    expect(inserted).toHaveLength(0);
  });

  it('403s a member and adds nobody', async () => {
    memberships.caller = { role: 'member' };
    const res = await post({ userId: 'target', role: 'member' });
    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it('lets an admin add a member', async () => {
    memberships.caller = { role: 'admin' };
    const res = await post({ userId: 'target', role: 'member' });
    expect(res.status).toBe(200);
    expect(inserted).toEqual([{ teamId: TEAM, userId: 'target', role: 'member' }]);
  });

  it('lets an admin add an admin', async () => {
    memberships.caller = { role: 'admin' };
    const res = await post({ userId: 'target', role: 'admin' });
    expect(res.status).toBe(200);
    expect(inserted).toEqual([{ teamId: TEAM, userId: 'target', role: 'admin' }]);
  });

  it('403s an admin adding an owner, and adds nobody', async () => {
    memberships.caller = { role: 'admin' };
    const res = await post({ userId: 'target', role: 'owner' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Only owners can add owners');
    expect(inserted).toHaveLength(0);
  });

  it('lets an owner add an owner', async () => {
    memberships.caller = { role: 'owner' };
    const res = await post({ userId: 'target', role: 'owner' });
    expect(res.status).toBe(200);
    expect(inserted).toEqual([{ teamId: TEAM, userId: 'target', role: 'owner' }]);
  });
});
