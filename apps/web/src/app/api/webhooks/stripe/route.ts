import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { db } from '@buildd/core/db';
import { stripeEvents } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { billingPricesFromEnv } from '@buildd/core/billing';
import { getStripe } from '@/lib/billing/stripe';
import { applyStripeEvent } from '@/lib/billing/apply-stripe-event';

/**
 * POST /api/webhooks/stripe — Stripe's billing events. The ONLY writer of a
 * team's plan, billing status, subscription id and seat count.
 *
 * 1. Verify the Stripe-Signature header against STRIPE_WEBHOOK_SECRET over the
 *    raw body. Anything unsigned or mis-signed is a 400 and writes nothing.
 * 2. Claim the event id in stripe_events. Already there = a replay: 200, no-op.
 * 3. Apply it (lib/billing/apply-stripe-event.ts). If that throws, release the
 *    claim and answer 500 so Stripe retries it.
 *
 * Handled: checkout.session.completed, customer.subscription.updated,
 * customer.subscription.deleted, invoice.payment_failed. Others are 200 no-ops.
 * Runs regardless of BILLING_ENFORCED: recording the plan changes nothing
 * until entitlements read it.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  const stripe = getStripe();
  const prices = billingPricesFromEnv();
  if (!secret || !stripe || !prices) {
    return NextResponse.json({ error: 'Billing is not configured' }, { status: 503 });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing Stripe-Signature header' }, { status: 400 });
  }

  const payload = await req.text();
  let event: Stripe.Event;
  try {
    event = await Stripe.webhooks.constructEventAsync(payload, signature, secret);
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const claimed = await db
    .insert(stripeEvents)
    .values({ id: event.id, type: event.type })
    .onConflictDoNothing()
    .returning({ id: stripeEvents.id });
  if (claimed.length === 0) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    const result = await applyStripeEvent(event, { stripe, prices });
    if (result.teamId) {
      await db.update(stripeEvents).set({ teamId: result.teamId }).where(eq(stripeEvents.id, event.id));
    }
    return NextResponse.json({ received: true, outcome: result.outcome });
  } catch (error) {
    console.error('Stripe webhook apply error:', event.type, error);
    await db.delete(stripeEvents).where(eq(stripeEvents.id, event.id)).catch(() => {});
    return NextResponse.json({ error: 'Failed to apply event' }, { status: 500 });
  }
}
