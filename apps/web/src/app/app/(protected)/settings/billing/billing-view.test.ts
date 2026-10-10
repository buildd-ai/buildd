import { describe, expect, it } from 'bun:test';
import { billingView, PLAN_FEATURES } from './billing-view';

const free = { plan: 'free', billingStatus: null, stripeCustomerId: null, stripeSubscriptionId: null, paidSeats: null };

describe('billingView', () => {
  it('a free team can start Pro or Team', () => {
    const v = billingView(free, { members: 1, pending: 0 });
    expect(v).toMatchObject({ plan: 'free', planLabel: 'Free', status: null, subscribed: false, upgrades: ['pro', 'team'], proBlocked: false });
    expect(v.seatsLine).toBe('1 member');
  });

  it('Pro is blocked for a team with several people', () => {
    expect(billingView(free, { members: 3, pending: 1 })).toMatchObject({ proBlocked: true, seatsLine: '3 members, 1 invited' });
  });

  it('a live Team subscription offers no new Checkout and counts seats', () => {
    const v = billingView(
      { plan: 'team', billingStatus: 'active', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', paidSeats: 7 },
      { members: 5, pending: 1 },
    );
    expect(v).toMatchObject({ subscribed: true, hasCustomer: true, upgrades: [], paidSeats: 7, used: 6 });
    expect(v.status).toEqual({ label: 'active', tone: 'success' });
    expect(v.seatsLine).toBe('6 of 7 members, 1 invited');
  });

  it('a failed payment reads as a warning, not as orange', () => {
    const v = billingView({ ...free, plan: 'pro', billingStatus: 'past_due', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' }, { members: 1, pending: 0 });
    expect(v.status).toEqual({ label: 'payment failed', tone: 'warning' });
    expect(v.subscribed).toBe(true);
  });

  it('a cancelled team keeps its customer for invoices and can buy again', () => {
    const v = billingView({ ...free, billingStatus: 'canceled', stripeCustomerId: 'cus_1' }, { members: 1, pending: 0 });
    expect(v).toMatchObject({ hasCustomer: true, subscribed: false, upgrades: ['pro', 'team'] });
  });

  it('an unknown stored plan reads as Free', () => {
    expect(billingView({ ...free, plan: 'enterprise' }, { members: 1, pending: 0 }).planLabel).toBe('Free');
  });

  it('copy has no em dashes', () => {
    for (const lines of Object.values(PLAN_FEATURES)) for (const l of lines) expect(l).not.toContain('—');
  });
});
