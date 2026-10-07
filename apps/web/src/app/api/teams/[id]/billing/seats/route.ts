import { NextRequest, NextResponse } from 'next/server';
import type { BillingSeatsRequest } from '@buildd/shared';
import { seatItemQuantity } from '@buildd/core/billing';
import { TEAM_PLAN_MIN_SEATS } from '@buildd/core/entitlements';
import { hasLiveSubscription, requireBillingManager } from '@/lib/billing/team-billing-access';
import { teamSeatUsage } from '@/lib/billing/seats';

/**
 * POST /api/teams/[id]/billing/seats { seats } — set the Team plan's seat
 * count. Owner or admin only, and only by asking: adding a member past the
 * paid seats is refused (402), never charged, and points here.
 *
 * Changes the extra-seat item on the subscription, prorated. Writes nothing:
 * paid_seats moves when customer.subscription.updated reaches the webhook.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: teamId } = await params;
  const access = await requireBillingManager(req, teamId);
  if (access.response) return access.response;
  const { team, stripe, prices } = access;

  if (team.plan !== 'team' || !hasLiveSubscription(team)) {
    return NextResponse.json({ error: 'Seats apply to a live Team plan.', code: 'not_team_plan' }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as Partial<BillingSeatsRequest>;
  const seats = typeof body.seats === 'number' && Number.isInteger(body.seats) ? body.seats : NaN;
  if (!Number.isFinite(seats) || seats < TEAM_PLAN_MIN_SEATS || seats > 10_000) {
    return NextResponse.json({ error: `seats must be a whole number of at least ${TEAM_PLAN_MIN_SEATS}` }, { status: 400 });
  }

  const usage = await teamSeatUsage(teamId);
  const used = usage.members + usage.pending;
  if (seats < used) {
    return NextResponse.json(
      { error: `This team has ${used} members and pending invites. Remove people before going below that.`, code: 'below_usage', used },
      { status: 409 },
    );
  }

  try {
    const sub = await stripe.subscriptions.retrieve(team.stripeSubscriptionId!);
    const seatItem = sub.items.data.find((i) => (typeof i.price === 'string' ? i.price : i.price.id) === prices.teamSeat);
    const quantity = seatItemQuantity(seats);
    const items = seatItem
      ? [quantity > 0 ? { id: seatItem.id, quantity } : { id: seatItem.id, deleted: true }]
      : quantity > 0 ? [{ price: prices.teamSeat, quantity }] : [];
    if (items.length > 0) {
      await stripe.subscriptions.update(sub.id, { items, proration_behavior: 'create_prorations' });
    }
    return NextResponse.json({ ok: true, seats });
  } catch (error) {
    console.error('Stripe seats error:', error);
    return NextResponse.json({ error: 'Could not change seats' }, { status: 502 });
  }
}
