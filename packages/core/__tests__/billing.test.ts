import { describe, it, expect } from 'bun:test';
import {
  billingPricesFromEnv,
  checkoutLineItems,
  checkoutSeats,
  seatItemQuantity,
  teamBillingFromSubscription,
  seatDecision,
  type BillingPrices,
} from '../billing';
import { TEAM_PLAN_MIN_SEATS } from '../entitlements';

const PRICES: BillingPrices = { pro: 'price_pro', teamBase: 'price_team_base', teamSeat: 'price_team_seat' };
const ENV = { STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_TEAM_BASE: 'price_team_base', STRIPE_PRICE_TEAM_SEAT: 'price_team_seat' };

function sub(items: Array<[string, number]>, status = 'active', id = 'sub_1') {
  return { id, status, items: { data: items.map(([price, quantity]) => ({ price: { id: price }, quantity })) } };
}

describe('billingPricesFromEnv', () => {
  it('reads all three price ids', () => {
    expect(billingPricesFromEnv(ENV)).toEqual(PRICES);
  });

  it('is null when any price id is missing', () => {
    expect(billingPricesFromEnv({ ...ENV, STRIPE_PRICE_TEAM_SEAT: '' })).toBeNull();
    expect(billingPricesFromEnv({})).toBeNull();
  });
});

describe('checkoutSeats', () => {
  it('never goes below the Team minimum', () => {
    expect(checkoutSeats(undefined, 1)).toBe(TEAM_PLAN_MIN_SEATS);
    expect(checkoutSeats(2, 1)).toBe(TEAM_PLAN_MIN_SEATS);
  });

  it('covers the members the team already has', () => {
    expect(checkoutSeats(5, 8)).toBe(8);
  });

  it('honours a larger request, rounded down', () => {
    expect(checkoutSeats(12.7, 3)).toBe(12);
  });
});

describe('checkoutLineItems', () => {
  it('pro is one unit of the Pro price', () => {
    expect(checkoutLineItems('pro', 1, PRICES)).toEqual([{ price: 'price_pro', quantity: 1 }]);
  });

  it('team at the minimum is the base price alone', () => {
    expect(checkoutLineItems('team', 5, PRICES)).toEqual([{ price: 'price_team_base', quantity: 1 }]);
  });

  it('team past the minimum adds extra seats', () => {
    expect(checkoutLineItems('team', 8, PRICES)).toEqual([
      { price: 'price_team_base', quantity: 1 },
      { price: 'price_team_seat', quantity: 3 },
    ]);
  });
});

describe('seatItemQuantity', () => {
  it('is the seats above the base', () => {
    expect(seatItemQuantity(5)).toBe(0);
    expect(seatItemQuantity(9)).toBe(4);
    expect(seatItemQuantity(3)).toBe(0);
  });
});

describe('teamBillingFromSubscription', () => {
  it('maps an active Pro subscription', () => {
    expect(teamBillingFromSubscription(sub([['price_pro', 1]]), PRICES)).toEqual({
      plan: 'pro', billingStatus: 'active', stripeSubscriptionId: 'sub_1', paidSeats: null,
    });
  });

  it('maps a Team subscription to base + extra seats', () => {
    expect(teamBillingFromSubscription(sub([['price_team_base', 1], ['price_team_seat', 4]]), PRICES)).toEqual({
      plan: 'team', billingStatus: 'active', stripeSubscriptionId: 'sub_1', paidSeats: 9,
    });
  });

  it('a Team subscription with no seat item pays for the minimum', () => {
    expect(teamBillingFromSubscription(sub([['price_team_base', 1]]), PRICES).paidSeats).toBe(5);
  });

  it('keeps the paid plan while past_due or trialing', () => {
    expect(teamBillingFromSubscription(sub([['price_pro', 1]], 'past_due'), PRICES).plan).toBe('pro');
    expect(teamBillingFromSubscription(sub([['price_pro', 1]], 'trialing'), PRICES).plan).toBe('pro');
  });

  it('drops to free once the subscription is over', () => {
    for (const status of ['canceled', 'unpaid', 'incomplete_expired', 'incomplete', 'paused']) {
      const b = teamBillingFromSubscription(sub([['price_team_base', 1], ['price_team_seat', 2]], status), PRICES);
      expect(b.plan).toBe('free');
      expect(b.paidSeats).toBeNull();
      expect(b.billingStatus).toBe(status);
    }
  });

  it('an unknown price reads as free, not as a paid plan', () => {
    expect(teamBillingFromSubscription(sub([['price_other', 1]]), PRICES).plan).toBe('free');
  });
});

describe('seatDecision', () => {
  const ON = { BILLING_ENFORCED: '1' };

  it('always allows while billing is off', () => {
    expect(seatDecision({ plan: 'free', paidSeats: null, members: 40, pending: 3 }, {}).ok).toBe(true);
  });

  it('allows a Team member while under paid seats', () => {
    expect(seatDecision({ plan: 'team', paidSeats: 6, members: 4, pending: 1 }, ON).ok).toBe(true);
  });

  it('asks the owner to add seats instead of charging past them', () => {
    const d = seatDecision({ plan: 'team', paidSeats: 6, members: 5, pending: 1 }, ON);
    expect(d).toMatchObject({ ok: false, code: 'seats_exhausted', plan: 'team', paidSeats: 6, used: 6, action: 'add_seats' });
  });

  it('a Team with no seat count still covers the minimum', () => {
    expect(seatDecision({ plan: 'team', paidSeats: null, members: 4, pending: 0 }, ON).ok).toBe(true);
    expect(seatDecision({ plan: 'team', paidSeats: null, members: 5, pending: 0 }, ON).ok).toBe(false);
  });

  it('a single-member plan asks to upgrade', () => {
    expect(seatDecision({ plan: 'pro', paidSeats: null, members: 1, pending: 0 }, ON))
      .toMatchObject({ ok: false, action: 'upgrade' });
  });
});
