/**
 * POST /api/invitations/[token]/accept — the plan member limit. A full team
 * refuses the join and leaves the invitation pending; someone already in the
 * team takes no new seat and is never refused.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = '11111111-1111-4111-8111-111111111111';
const memberInserts: any[] = [];
const invitationUpdates: any[] = [];
let existingMember: any = undefined;

mock.module('@/lib/auth-helpers', () => ({
  requireSessionUser: async () => ({ user: { id: 'joiner' } }),
}));

let capacity: any = { ok: true };
const capacityCalls: any[] = [];
mock.module('@/lib/billing/seats', () => ({
  checkSeatForNewMember: async (teamId: string, opts: any) => { capacityCalls.push({ teamId, opts }); return capacity; },
  seatsExhaustedResponse: (d: any, audience: string) =>
    Response.json({ ...d, error: audience === 'invitee' ? 'no free seats' : d.message }, { status: 402 }),
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
}));

mock.module('@buildd/core/db/schema', () => ({
  teamInvitations: { id: 'ti.id', token: 'ti.token' },
  teamMembers: { teamId: 'tm.teamId', userId: 'tm.userId' },
  teams: { id: 'teams.id' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamInvitations: {
        findFirst: async () => ({
          id: 'inv', teamId: TEAM, role: 'member', status: 'pending',
          expiresAt: new Date(Date.now() + 86_400_000),
        }),
      },
      teamMembers: { findFirst: async () => existingMember },
      teams: { findFirst: async () => ({ id: TEAM, name: 'T', slug: 't' }) },
    },
    insert: () => ({ values: (v: any) => ({ onConflictDoNothing: async () => { memberInserts.push(v); } }) }),
    update: () => ({ set: (v: any) => ({ where: async () => { invitationUpdates.push(v); } }) }),
  },
}));

import { POST } from './route';

const accept = () => POST(
  new NextRequest('http://localhost:3000/api/invitations/tok/accept', { method: 'POST' }),
  { params: Promise.resolve({ token: 'tok' }) },
);

beforeEach(() => {
  memberInserts.length = 0;
  invitationUpdates.length = 0;
  existingMember = undefined;
  capacity = { ok: true };
  capacityCalls.length = 0;
});

describe('POST /api/invitations/[token]/accept — plan member limit', () => {
  it('joins when the plan has room', async () => {
    const res = await accept();
    expect(res.status).toBe(200);
    expect(memberInserts).toHaveLength(1);
    expect(invitationUpdates).toEqual([{ status: 'accepted' }]);
  });

  it('refuses a full team and leaves the invitation pending', async () => {
    capacity = { ok: false, code: 'seats_exhausted', action: 'upgrade', paidSeats: 1, used: 1, message: 'full — see Settings → Billing' };
    const res = await accept();
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe('seats_exhausted');
    expect(capacityCalls).toEqual([{ teamId: TEAM, opts: { countPending: false } }]);
    expect(memberInserts).toHaveLength(0);
    expect(invitationUpdates).toHaveLength(0);
  });

  it('someone already in the team is not counted against the limit', async () => {
    existingMember = { userId: 'joiner' };
    capacity = { ok: false, code: 'seats_exhausted', action: 'upgrade', paidSeats: 1, used: 1, message: 'full — see Settings → Billing' };
    const res = await accept();
    expect(res.status).toBe(200);
    expect(capacityCalls).toHaveLength(0);
  });
});
