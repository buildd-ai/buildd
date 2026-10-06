/**
 * The team billing routes: Checkout, the customer portal, and changing seats.
 *
 * Who may spend the team's money (owner/admin only, never a member, never an
 * API key), that nothing exists while BILLING_ENFORCED is off, and what each
 * route asks Stripe for. The Stripe client is a recorder — no live calls — and
 * none of these routes may write the team's plan: the webhook does that.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

process.env.STRIPE_PRICE_PRO = 'price_pro';
process.env.STRIPE_PRICE_TEAM_BASE = 'price_team_base';
process.env.STRIPE_PRICE_TEAM_SEAT = 'price_team_seat';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';

const TEAM = '11111111-1111-4111-8111-111111111111';

let role: string | null;
let principalKind: 'session' | 'api_key';
let teamRow: Record<string, unknown>;
let usage: { members: number; pending: number };
let stripeConfigured: boolean;
const calls: Array<{ op: string; args: any[] }> = [];
const dbWrites: any[] = [];

mock.module('@/lib/auth-helpers', () => ({
  requireSessionUser: async () => principalKind === 'session'
    ? { user: { id: 'caller', email: 'owner@example.test' } }
    : { response: Response.json({ error: 'session required' }, { status: 403 }) },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
}));

mock.module('@buildd/core/db/schema', () => ({
  teams: { id: 'teams.id' },
  teamMembers: { teamId: 'teamMembers.teamId', userId: 'teamMembers.userId' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamMembers: { findFirst: async () => (role ? { teamId: TEAM, userId: 'caller', role } : undefined) },
      teams: { findFirst: async () => teamRow },
    },
    update: () => { dbWrites.push('update'); return { set: () => ({ where: async () => {} }) }; },
    insert: () => { dbWrites.push('insert'); return { values: async () => {} }; },
  },
}));

mock.module('@/lib/billing/seats', () => ({
  teamSeatUsage: async () => usage,
}));

function rec(op: string, result: (...args: any[]) => unknown) {
  return async (...args: any[]) => { calls.push({ op, args }); return result(...args); };
}

mock.module('@/lib/billing/stripe', () => ({
  getStripe: () => stripeConfigured ? {
    checkout: { sessions: { create: rec('checkout.create', () => ({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' })) } },
    billingPortal: { sessions: { create: rec('portal.create', () => ({ url: 'https://billing.stripe.test/p_1' })) } },
    subscriptions: {
      retrieve: rec('subscriptions.retrieve', (id: string) => ({
        id, status: 'active',
        items: { data: [
          { id: 'si_base', price: { id: 'price_team_base' }, quantity: 1 },
          ...(id === 'sub_with_seats' ? [{ id: 'si_seat', price: { id: 'price_team_seat' }, quantity: 2 }] : []),
        ] },
      })),
      update: rec('subscriptions.update', (id: string) => ({ id })),
    },
  } : null,
}));

const { POST: checkout } = await import('./checkout/route');
const { POST: portal } = await import('./portal/route');
const { POST: seats } = await import('./seats/route');

const ctx = { params: Promise.resolve({ id: TEAM }) };
function req(path: string, body: unknown = {}) {
  return new NextRequest(`http://localhost:3000/api/teams/${TEAM}/billing/${path}`, {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.BILLING_ENFORCED = '1';
  role = 'owner';
  principalKind = 'session';
  stripeConfigured = true;
  usage = { members: 1, pending: 0 };
  teamRow = { id: TEAM, name: 'Team', plan: 'free', billingStatus: null, stripeCustomerId: null, stripeSubscriptionId: null, paidSeats: null };
  calls.length = 0;
  dbWrites.length = 0;
});

describe('who may open Checkout', () => {
  it('refuses a member and asks Stripe for nothing', async () => {
    role = 'member';
    const res = await checkout(req('checkout', { plan: 'team' }), ctx);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('404s someone outside the team', async () => {
    role = null;
    const res = await checkout(req('checkout', { plan: 'pro' }), ctx);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('refuses an API key: buying is a signed-in person', async () => {
    principalKind = 'api_key';
    const res = await checkout(req('checkout', { plan: 'pro' }), ctx);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('lets an admin open Checkout', async () => {
    role = 'admin';
    const res = await checkout(req('checkout', { plan: 'pro' }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.test/cs_1' });
  });

  it('does not exist while BILLING_ENFORCED is off', async () => {
    delete process.env.BILLING_ENFORCED;
    for (const res of [
      await checkout(req('checkout', { plan: 'pro' }), ctx),
      await portal(req('portal'), ctx),
      await seats(req('seats', { seats: 6 }), ctx),
    ]) expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('503s when Stripe is not configured', async () => {
    stripeConfigured = false;
    const res = await checkout(req('checkout', { plan: 'pro' }), ctx);
    expect(res.status).toBe(503);
  });
});

describe('POST checkout', () => {
  it('a Team checkout buys at least the minimum and ties the session to the team', async () => {
    usage = { members: 2, pending: 0 };
    await checkout(req('checkout', { plan: 'team', seats: 3 }), ctx);
    const [params] = calls.find(c => c.op === 'checkout.create')!.args;
    expect(params).toMatchObject({
      mode: 'subscription',
      client_reference_id: TEAM,
      line_items: [{ price: 'price_team_base', quantity: 1 }],
      customer_email: 'owner@example.test',
      metadata: { teamId: TEAM, plan: 'team' },
      subscription_data: { metadata: { teamId: TEAM, plan: 'team' } },
    });
    expect(params.success_url).toStartWith('https://app.example.test/app/settings/billing');
    expect(params.cancel_url).toStartWith('https://app.example.test/app/settings/billing');
  });

  it('a Team checkout covers every current member and pending invite', async () => {
    usage = { members: 6, pending: 2 };
    await checkout(req('checkout', { plan: 'team', seats: 5 }), ctx);
    const [params] = calls.find(c => c.op === 'checkout.create')!.args;
    expect(params.line_items).toEqual([
      { price: 'price_team_base', quantity: 1 },
      { price: 'price_team_seat', quantity: 3 },
    ]);
  });

  it('reuses the Stripe customer the team already has', async () => {
    teamRow.stripeCustomerId = 'cus_1';
    await checkout(req('checkout', { plan: 'pro' }), ctx);
    const [params] = calls.find(c => c.op === 'checkout.create')!.args;
    expect(params.customer).toBe('cus_1');
    expect(params.customer_email).toBeUndefined();
  });

  it('refuses a second subscription while one is live', async () => {
    Object.assign(teamRow, { plan: 'pro', billingStatus: 'active', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
    const res = await checkout(req('checkout', { plan: 'team' }), ctx);
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it('refuses Pro for a team with more than one member', async () => {
    usage = { members: 3, pending: 0 };
    const res = await checkout(req('checkout', { plan: 'pro' }), ctx);
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it('400s an unknown plan', async () => {
    const res = await checkout(req('checkout', { plan: 'enterprise' }), ctx);
    expect(res.status).toBe(400);
  });

  it('never writes the team row itself', async () => {
    await checkout(req('checkout', { plan: 'team' }), ctx);
    expect(dbWrites).toHaveLength(0);
  });
});

describe('POST portal', () => {
  it('opens the portal for the team customer', async () => {
    teamRow.stripeCustomerId = 'cus_1';
    const res = await portal(req('portal'), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://billing.stripe.test/p_1' });
    const [params] = calls.find(c => c.op === 'portal.create')!.args;
    expect(params).toEqual({ customer: 'cus_1', return_url: 'https://app.example.test/app/settings/billing' });
  });

  it('409s a team that has never paid', async () => {
    const res = await portal(req('portal'), ctx);
    expect(res.status).toBe(409);
  });

  it('refuses a member', async () => {
    role = 'member';
    teamRow.stripeCustomerId = 'cus_1';
    expect((await portal(req('portal'), ctx)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe('POST seats', () => {
  beforeEach(() => {
    Object.assign(teamRow, { plan: 'team', billingStatus: 'active', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_base_only', paidSeats: 5 });
  });

  it('adds an extra-seat item when the subscription has none', async () => {
    const res = await seats(req('seats', { seats: 7 }), ctx);
    expect(res.status).toBe(200);
    const [id, params] = calls.find(c => c.op === 'subscriptions.update')!.args;
    expect(id).toBe('sub_base_only');
    expect(params.items).toEqual([{ price: 'price_team_seat', quantity: 2 }]);
    expect(params.proration_behavior).toBe('create_prorations');
    expect(dbWrites).toHaveLength(0);
  });

  it('changes the quantity of the existing seat item', async () => {
    teamRow.stripeSubscriptionId = 'sub_with_seats';
    await seats(req('seats', { seats: 10 }), ctx);
    const [, params] = calls.find(c => c.op === 'subscriptions.update')!.args;
    expect(params.items).toEqual([{ id: 'si_seat', quantity: 5 }]);
  });

  it('removes the seat item when going back to the minimum', async () => {
    teamRow.stripeSubscriptionId = 'sub_with_seats';
    usage = { members: 4, pending: 0 };
    await seats(req('seats', { seats: 5 }), ctx);
    const [, params] = calls.find(c => c.op === 'subscriptions.update')!.args;
    expect(params.items).toEqual([{ id: 'si_seat', deleted: true }]);
  });

  it('refuses fewer seats than members plus pending invites', async () => {
    usage = { members: 6, pending: 1 };
    const res = await seats(req('seats', { seats: 6 }), ctx);
    expect(res.status).toBe(409);
    expect(calls.filter(c => c.op === 'subscriptions.update')).toHaveLength(0);
  });

  it('409s a team not on a live Team subscription', async () => {
    Object.assign(teamRow, { plan: 'pro', stripeSubscriptionId: 'sub_pro' });
    expect((await seats(req('seats', { seats: 6 }), ctx)).status).toBe(409);
  });

  it('refuses a member', async () => {
    role = 'member';
    expect((await seats(req('seats', { seats: 6 }), ctx)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});
