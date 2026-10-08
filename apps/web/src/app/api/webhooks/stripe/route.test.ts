/**
 * POST /api/webhooks/stripe — the only writer of a team's plan.
 *
 * Signatures are real: each payload is signed locally with Stripe's own test
 * header helper (pure HMAC, no network), so the rejection tests exercise the
 * SDK's verifier, not a stub. Only the Stripe API client is mocked — the
 * checkout event reads the subscription back from it — and live Stripe is
 * never called.
 *
 * The db mock is a tiny in-memory store keyed on the column a where clause
 * names, so each test asserts what was written to the team row, not a status
 * a mocked db would return anyway.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import Stripe from 'stripe';
import { NextRequest } from 'next/server';

const SECRET = 'whsec_test_secret';
process.env.STRIPE_WEBHOOK_SECRET = SECRET;
process.env.STRIPE_PRICE_PRO = 'price_pro';
process.env.STRIPE_PRICE_TEAM_BASE = 'price_team_base';
process.env.STRIPE_PRICE_TEAM_SEAT = 'price_team_seat';

const TEAM = '11111111-1111-4111-8111-111111111111';

type TeamRow = {
  id: string; plan: string; billingStatus: string | null; stripeCustomerId: string | null;
  stripeSubscriptionId: string | null; paidSeats: number | null;
};
let team: TeamRow;
let events: Map<string, { id: string; type: string }>;
let teamUpdates: number;
let subscriptions: Record<string, unknown>;
let failNextUpdate = false;

mock.module('drizzle-orm', () => ({
  eq: (col: string, val: unknown) => ({ col, val }),
}));

mock.module('@buildd/core/db/schema', () => ({
  teams: { id: 'teams.id', stripeCustomerId: 'teams.stripeCustomerId' },
  stripeEvents: { id: 'stripeEvents.id' },
}));

function matchTeam(where: { col: string; val: unknown }): TeamRow | undefined {
  if (where.col === 'teams.id' && where.val === team.id) return team;
  if (where.col === 'teams.stripeCustomerId' && where.val != null && where.val === team.stripeCustomerId) return team;
  return undefined;
}

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teams: { findFirst: async (q: any) => matchTeam(q.where) },
    },
    insert: () => ({
      values: (v: any) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (events.has(v.id)) return [];
            events.set(v.id, v);
            return [{ id: v.id }];
          },
        }),
      }),
    }),
    update: (table: any) => ({
      set: (v: any) => ({
        where: async (w: any) => {
          if (!('stripeCustomerId' in table)) return;
          if (failNextUpdate) { failNextUpdate = false; throw new Error('db down'); }
          const row = matchTeam(w);
          if (row) { Object.assign(row, v); teamUpdates++; }
        },
      }),
    }),
    delete: () => ({
      where: async (w: any) => { events.delete(w.val as string); },
    }),
  },
}));

mock.module('@/lib/billing/stripe', () => ({
  getStripe: () => ({
    subscriptions: {
      retrieve: async (id: string) => {
        const s = subscriptions[id];
        if (!s) throw new Error(`no subscription ${id}`);
        return s;
      },
    },
  }),
}));

const { POST } = await import('./route');

function sub(id: string, items: Array<[string, number]>, status = 'active', customer = 'cus_1') {
  return {
    id, object: 'subscription', status, customer, metadata: { teamId: TEAM },
    items: { data: items.map(([price, quantity]) => ({ price: { id: price }, quantity })) },
  };
}

let seq = 0;
function event(type: string, object: unknown, id = `evt_${++seq}`) {
  return { id, object: 'event', type, created: Math.floor(Date.now() / 1000), data: { object } };
}

async function deliver(body: unknown, opts: { signature?: string | null; secret?: string } = {}) {
  const payload = JSON.stringify(body);
  const signature = opts.signature === undefined
    ? await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: opts.secret ?? SECRET })
    : opts.signature;
  const headers = new Headers({ 'content-type': 'application/json' });
  if (signature !== null) headers.set('stripe-signature', signature);
  return POST(new NextRequest('http://localhost:3000/api/webhooks/stripe', { method: 'POST', headers, body: payload }));
}

beforeEach(() => {
  team = { id: TEAM, plan: 'free', billingStatus: null, stripeCustomerId: null, stripeSubscriptionId: null, paidSeats: null };
  events = new Map();
  teamUpdates = 0;
  subscriptions = {};
  failNextUpdate = false;
});

describe('signature', () => {
  it('rejects a request with no signature header', async () => {
    const res = await deliver(event('customer.subscription.updated', sub('sub_1', [['price_pro', 1]])), { signature: null });
    expect(res.status).toBe(400);
    expect(teamUpdates).toBe(0);
    expect(events.size).toBe(0);
  });

  it('rejects a payload signed with another secret', async () => {
    team.stripeCustomerId = 'cus_1';
    const res = await deliver(event('customer.subscription.updated', sub('sub_1', [['price_pro', 1]])), { secret: 'whsec_wrong' });
    expect(res.status).toBe(400);
    expect(team.plan).toBe('free');
    expect(events.size).toBe(0);
  });

  it('rejects a garbage signature', async () => {
    const res = await deliver(event('invoice.payment_failed', { customer: 'cus_1' }), { signature: 't=1,v1=deadbeef' });
    expect(res.status).toBe(400);
  });
});

describe('idempotency', () => {
  it('applies an event id once; a replay is acknowledged and changes nothing', async () => {
    team.stripeCustomerId = 'cus_1';
    team.stripeSubscriptionId = 'sub_1';
    const e = event('customer.subscription.updated', sub('sub_1', [['price_team_base', 1], ['price_team_seat', 2]]), 'evt_same');

    const first = await deliver(e);
    expect(first.status).toBe(200);
    expect(team.paidSeats).toBe(7);
    expect(teamUpdates).toBe(1);

    // Something else moved the row since; a replay of the old event must not undo it.
    team.paidSeats = 9;
    const replay = await deliver(e);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ duplicate: true });
    expect(team.paidSeats).toBe(9);
    expect(teamUpdates).toBe(1);
  });

  it('releases the event id when applying fails, so Stripe can retry it', async () => {
    team.stripeCustomerId = 'cus_1';
    failNextUpdate = true;
    const e = event('customer.subscription.updated', sub('sub_1', [['price_pro', 1]]), 'evt_retry');

    const failed = await deliver(e);
    expect(failed.status).toBe(500);
    expect(events.has('evt_retry')).toBe(false);

    const retried = await deliver(e);
    expect(retried.status).toBe(200);
    expect(team.plan).toBe('pro');
  });
});

describe('events', () => {
  it('checkout.session.completed records the customer and the subscription it bought', async () => {
    subscriptions.sub_new = sub('sub_new', [['price_team_base', 1], ['price_team_seat', 3]], 'active', 'cus_new');
    const res = await deliver(event('checkout.session.completed', {
      id: 'cs_1', object: 'checkout.session', mode: 'subscription', client_reference_id: TEAM,
      customer: 'cus_new', subscription: 'sub_new', metadata: { teamId: TEAM },
    }));
    expect(res.status).toBe(200);
    expect(team).toMatchObject({
      plan: 'team', billingStatus: 'active', stripeCustomerId: 'cus_new', stripeSubscriptionId: 'sub_new', paidSeats: 8,
    });
  });

  it('checkout.session.completed for a Pro purchase', async () => {
    subscriptions.sub_pro = sub('sub_pro', [['price_pro', 1]], 'active', 'cus_new');
    await deliver(event('checkout.session.completed', {
      id: 'cs_2', object: 'checkout.session', mode: 'subscription', client_reference_id: TEAM,
      customer: 'cus_new', subscription: 'sub_pro', metadata: {},
    }));
    expect(team).toMatchObject({ plan: 'pro', paidSeats: null, stripeSubscriptionId: 'sub_pro' });
  });

  it('customer.subscription.updated moves the plan and seat count', async () => {
    Object.assign(team, { plan: 'pro', billingStatus: 'active', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
    await deliver(event('customer.subscription.updated', sub('sub_1', [['price_team_base', 1]])));
    expect(team).toMatchObject({ plan: 'team', paidSeats: 5, billingStatus: 'active' });
  });

  it('customer.subscription.updated to canceled drops the team to free', async () => {
    Object.assign(team, { plan: 'team', billingStatus: 'active', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', paidSeats: 6 });
    await deliver(event('customer.subscription.updated', sub('sub_1', [['price_team_base', 1], ['price_team_seat', 1]], 'canceled')));
    expect(team).toMatchObject({ plan: 'free', paidSeats: null, billingStatus: 'canceled' });
  });

  it('customer.subscription.updated for an old subscription does not touch the current one', async () => {
    Object.assign(team, { plan: 'team', billingStatus: 'active', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_current', paidSeats: 6 });
    await deliver(event('customer.subscription.updated', sub('sub_old', [['price_pro', 1]], 'canceled')));
    expect(team).toMatchObject({ plan: 'team', paidSeats: 6, stripeSubscriptionId: 'sub_current' });
  });

  it('customer.subscription.deleted downgrades to free and clears the subscription', async () => {
    Object.assign(team, { plan: 'team', billingStatus: 'active', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', paidSeats: 7 });
    await deliver(event('customer.subscription.deleted', sub('sub_1', [['price_team_base', 1]], 'canceled')));
    expect(team).toMatchObject({ plan: 'free', billingStatus: 'canceled', stripeSubscriptionId: null, paidSeats: null, stripeCustomerId: 'cus_1' });
  });

  it('customer.subscription.deleted for an old subscription is ignored', async () => {
    Object.assign(team, { plan: 'pro', billingStatus: 'active', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_current' });
    await deliver(event('customer.subscription.deleted', sub('sub_old', [['price_pro', 1]], 'canceled')));
    expect(team).toMatchObject({ plan: 'pro', stripeSubscriptionId: 'sub_current' });
  });

  it('invoice.payment_failed marks the team past due and keeps the plan', async () => {
    Object.assign(team, { plan: 'pro', billingStatus: 'active', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
    await deliver(event('invoice.payment_failed', {
      id: 'in_1', object: 'invoice', customer: 'cus_1',
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } },
    }));
    expect(team).toMatchObject({ plan: 'pro', billingStatus: 'past_due' });
  });

  it('an event for an unknown customer is acknowledged and writes nothing', async () => {
    const stranger = { ...sub('sub_x', [['price_pro', 1]], 'active', 'cus_unknown'), metadata: {} };
    const res = await deliver(event('customer.subscription.updated', stranger));
    expect(res.status).toBe(200);
    expect(teamUpdates).toBe(0);
  });

  it('an event type it does not handle is acknowledged and writes nothing', async () => {
    const res = await deliver(event('customer.created', { id: 'cus_1' }));
    expect(res.status).toBe(200);
    expect(teamUpdates).toBe(0);
  });
});
