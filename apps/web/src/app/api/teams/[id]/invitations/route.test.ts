/**
 * POST /api/teams/[id]/invitations — the plan member limit. The gate itself
 * (billing switch, plan, counts) is covered in packages/core billing-limits;
 * here: the route asks it with pending invitations counted, refuses with its
 * message, and creates no invitation when refused.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = '11111111-1111-4111-8111-111111111111';
const inserted: any[] = [];

mock.module('@/lib/auth-helpers', () => ({
  requireSessionUser: async () => ({ user: { id: 'caller' } }),
}));

mock.module('@/lib/permissions', () => ({
  roleHas: () => true,
  getTeamPermissionOverrides: async () => null,
}));

let capacity: any = { ok: true };
const capacityCalls: any[] = [];
mock.module('@buildd/core/billing-limits', () => ({
  checkMemberCapacity: async (teamId: string, opts: any) => { capacityCalls.push({ teamId, opts }); return capacity; },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
}));

mock.module('@buildd/core/db/schema', () => ({
  teamInvitations: { teamId: 'ti.teamId', email: 'ti.email', status: 'ti.status' },
  teamMembers: { teamId: 'tm.teamId', userId: 'tm.userId' },
  users: { email: 'users.email' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamMembers: { findFirst: async () => ({ teamId: TEAM, userId: 'caller', role: 'owner' }) },
      users: { findFirst: async () => undefined },
      teamInvitations: { findFirst: async () => undefined, findMany: async () => [] },
    },
    insert: () => ({
      values: (v: any) => ({ returning: async () => { inserted.push(v); return [{ id: 'inv', ...v }]; } }),
    }),
  },
}));

import { POST } from './route';

function post(body: unknown) {
  return POST(
    new NextRequest(`http://localhost:3000/api/teams/${TEAM}/invitations`, {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: TEAM }) },
  );
}

beforeEach(() => {
  inserted.length = 0;
  capacityCalls.length = 0;
  capacity = { ok: true };
});

describe('POST /api/teams/[id]/invitations — plan member limit', () => {
  it('creates the invitation when the plan has room', async () => {
    const res = await post({ email: 'new@example.com', role: 'member' });
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(capacityCalls).toEqual([{ teamId: TEAM, opts: { includePendingInvites: true } }]);
  });

  it('refuses past maxMembers with the gate message and creates nothing', async () => {
    capacity = { ok: false, code: 'plan_member_limit', maxMembers: 1, current: 1, message: 'full — see Settings → Billing' };
    const res = await post({ email: 'new@example.com', role: 'member' });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'full — see Settings → Billing', code: 'plan_member_limit' });
    expect(inserted).toHaveLength(0);
  });
});
