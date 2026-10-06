import { NextRequest, NextResponse } from 'next/server';
import type { BillingCheckoutRequest, PaidTeamPlan } from '@buildd/shared';
import { checkoutLineItems, checkoutSeats } from '@buildd/core/billing';
import { appBaseUrl } from '@/lib/app-url';
import { hasLiveSubscription, requireBillingManager } from '@/lib/billing/team-billing-access';
import { teamSeatUsage } from '@/lib/billing/seats';

/**
 * POST /api/teams/[id]/billing/checkout { plan: 'pro' | 'team', seats? }
 *
 * Opens a Stripe Checkout session for the team and returns its URL. Owner or
 * admin only. Writes nothing: the plan changes when Stripe's
 * checkout.session.completed reaches the webhook.
 *
 * Team buys at least 5 seats and at least everyone already on the team or
 * invited. A team with a live subscription changes it in the portal or the
 * seats route instead of stacking a second one.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: teamId } = await params;
  const access = await requireBillingManager(req, teamId);
  if (access.response) return access.response;
  const { team, user, stripe, prices } = access;

  const body = (await req.json().catch(() => ({}))) as Partial<BillingCheckoutRequest>;
  const plan = body.plan;
  if (plan !== 'pro' && plan !== 'team') {
    return NextResponse.json({ error: "plan must be 'pro' or 'team'" }, { status: 400 });
  }

  if (hasLiveSubscription(team)) {
    return NextResponse.json(
      { error: 'This team already has a subscription. Change it from Manage billing.', code: 'already_subscribed' },
      { status: 409 },
    );
  }

  const usage = await teamSeatUsage(teamId);
  if (plan === 'pro' && usage.members > 1) {
    return NextResponse.json(
      { error: `Pro covers one member and this team has ${usage.members}. Choose Team.`, code: 'too_many_members' },
      { status: 409 },
    );
  }

  const seats = plan === 'team' ? checkoutSeats(body.seats, usage.members + usage.pending) : 1;
  const billingUrl = `${appBaseUrl()}/app/settings/billing`;
  const metadata: Record<string, string> = { teamId, plan: plan satisfies PaidTeamPlan };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: checkoutLineItems(plan, seats, prices),
      client_reference_id: teamId,
      ...(team.stripeCustomerId
        ? { customer: team.stripeCustomerId }
        : user.email ? { customer_email: user.email } : {}),
      metadata,
      subscription_data: { metadata },
      allow_promotion_codes: true,
      success_url: `${billingUrl}?checkout=success`,
      cancel_url: `${billingUrl}?checkout=cancelled`,
    });
    if (!session.url) throw new Error('Checkout session has no url');
    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error('Stripe checkout error:', error);
    return NextResponse.json({ error: 'Could not start checkout' }, { status: 502 });
  }
}
