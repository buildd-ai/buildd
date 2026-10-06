// Billing rules that do not need Stripe or the db: which Stripe prices mean
// which plan, what a Checkout session buys, what a subscription grants, and
// whether a team has a seat free for one more member.
//
// Prices (env, values in Doppler — never committed):
//   STRIPE_PRICE_PRO        — Pro, quantity 1
//   STRIPE_PRICE_TEAM_BASE  — Team, quantity 1, covers TEAM_PLAN_MIN_SEATS members
//   STRIPE_PRICE_TEAM_SEAT  — Team extra seat, quantity = seats above the minimum
//
// The Stripe webhook is the only writer of teams.plan / billing_status /
// stripe_subscription_id / paid_seats; it writes what
// teamBillingFromSubscription returns. Gates still read entitlements(team).

import { TEAM_PLAN_MIN_SEATS, entitlements, type TeamPlan } from './entitlements';

type Env = Record<string, string | undefined>;

export interface BillingPrices {
  pro: string;
  teamBase: string;
  teamSeat: string;
}

/** The three price ids, or null when any is unset (billing not configured). */
export function billingPricesFromEnv(env: Env = process.env): BillingPrices | null {
  const pro = env.STRIPE_PRICE_PRO?.trim();
  const teamBase = env.STRIPE_PRICE_TEAM_BASE?.trim();
  const teamSeat = env.STRIPE_PRICE_TEAM_SEAT?.trim();
  if (!pro || !teamBase || !teamSeat) return null;
  return { pro, teamBase, teamSeat };
}

export type PaidPlan = Exclude<TeamPlan, 'free'>;

/** Seats a Team checkout buys: the request, but never fewer than the minimum or than current members. */
export function checkoutSeats(requested: number | null | undefined, members: number): number {
  const asked = typeof requested === 'number' && Number.isFinite(requested) ? Math.floor(requested) : 0;
  return Math.max(TEAM_PLAN_MIN_SEATS, asked, members);
}

/** Quantity of the extra-seat price for a seat count (the base covers the minimum). */
export function seatItemQuantity(seats: number): number {
  return Math.max(0, Math.floor(seats) - TEAM_PLAN_MIN_SEATS);
}

export function checkoutLineItems(plan: PaidPlan, seats: number, prices: BillingPrices): Array<{ price: string; quantity: number }> {
  if (plan === 'pro') return [{ price: prices.pro, quantity: 1 }];
  const extra = seatItemQuantity(seats);
  return [
    { price: prices.teamBase, quantity: 1 },
    ...(extra > 0 ? [{ price: prices.teamSeat, quantity: extra }] : []),
  ];
}

/** Subscription statuses that keep the paid plan. past_due keeps it while Stripe retries the card. */
const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);

/** The shape of a Stripe subscription this module reads — a Stripe.Subscription satisfies it. */
export interface SubscriptionLike {
  id: string;
  status: string;
  items: { data: Array<{ price: { id: string } | string; quantity?: number | null }> };
}

export interface TeamBilling {
  plan: TeamPlan;
  billingStatus: string;
  stripeSubscriptionId: string;
  paidSeats: number | null;
}

/** What a subscription grants, as the team columns the webhook writes. */
export function teamBillingFromSubscription(sub: SubscriptionLike, prices: BillingPrices): TeamBilling {
  const qty = new Map<string, number>();
  for (const item of sub.items?.data ?? []) {
    const id = typeof item.price === 'string' ? item.price : item.price?.id;
    if (id) qty.set(id, (qty.get(id) ?? 0) + (item.quantity ?? 1));
  }

  let plan: TeamPlan = 'free';
  let paidSeats: number | null = null;
  if (PAID_STATUSES.has(sub.status)) {
    if (qty.has(prices.teamBase)) {
      plan = 'team';
      paidSeats = TEAM_PLAN_MIN_SEATS + (qty.get(prices.teamSeat) ?? 0);
    } else if (qty.has(prices.pro)) {
      plan = 'pro';
    }
  }
  return { plan, billingStatus: sub.status, stripeSubscriptionId: sub.id, paidSeats };
}

export type SeatDecision =
  | { ok: true }
  | {
      ok: false;
      code: 'seats_exhausted';
      plan: TeamPlan;
      /** Members the plan covers. */
      paidSeats: number;
      /** Members plus pending invitations. */
      used: number;
      /** Team plan: buy more seats. Free/Pro (one member): move to Team. */
      action: 'add_seats' | 'upgrade';
      message: string;
    };

/**
 * Whether one more member fits. Pending invitations count as used, so an
 * invite is refused up front rather than charging or failing on accept.
 * Never charges: when full, the caller shows the owner the way to add seats.
 */
export function seatDecision(
  team: { plan?: string | null; paidSeats?: number | null; members: number; pending: number },
  env: Env = process.env,
): SeatDecision {
  const ent = entitlements(team, { env });
  if (ent.maxMembers === null) return { ok: true };
  const used = team.members + team.pending;
  if (used < ent.maxMembers) return { ok: true };
  const action = ent.plan === 'team' ? 'add_seats' : 'upgrade';
  return {
    ok: false,
    code: 'seats_exhausted',
    plan: ent.plan,
    paidSeats: ent.maxMembers,
    used,
    action,
    message: action === 'add_seats'
      ? `All ${ent.maxMembers} paid seats are in use. An owner or admin can add seats in Settings → Billing.`
      : `The ${ent.plan === 'pro' ? 'Pro' : 'Free'} plan covers one member. Move to the Team plan in Settings → Billing to add people.`,
  };
}
