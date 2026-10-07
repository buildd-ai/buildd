import { NextRequest, NextResponse } from 'next/server';
import { appBaseUrl } from '@/lib/app-url';
import { requireBillingManager } from '@/lib/billing/team-billing-access';

/**
 * POST /api/teams/[id]/billing/portal — a Stripe customer portal session for
 * the team (invoices, card, cancel). Owner or admin only. Whatever the owner
 * changes there comes back through the webhook.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: teamId } = await params;
  const access = await requireBillingManager(req, teamId);
  if (access.response) return access.response;
  const { team, stripe } = access;

  if (!team.stripeCustomerId) {
    return NextResponse.json({ error: 'This team has no billing account yet. Choose a plan first.', code: 'no_customer' }, { status: 409 });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: team.stripeCustomerId,
      return_url: `${appBaseUrl()}/app/settings/billing`,
    });
    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error('Stripe portal error:', error);
    return NextResponse.json({ error: 'Could not open billing' }, { status: 502 });
  }
}
