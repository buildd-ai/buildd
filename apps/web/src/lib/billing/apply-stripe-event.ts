import type Stripe from 'stripe';
import { db } from '@buildd/core/db';
import { teams } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { teamBillingFromSubscription, type BillingPrices, type SubscriptionLike } from '@buildd/core/billing';

/**
 * Apply one verified Stripe event to the team it belongs to. The webhook route
 * is the only caller, which makes it the only writer of teams.plan /
 * billing_status / stripe_subscription_id / paid_seats (and the first writer of
 * stripe_customer_id). Throws on a failed write so the route releases the
 * event id and Stripe retries.
 *
 * A team is found by its Stripe customer id, else by the team id buildd put on
 * the Checkout session / subscription metadata. An event for an unknown team,
 * or of a type not handled, is a no-op.
 */
export async function applyStripeEvent(
  event: Stripe.Event,
  deps: { stripe: Pick<Stripe, 'subscriptions'>; prices: BillingPrices },
): Promise<{ teamId: string | null; outcome: string }> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== 'subscription') return { teamId: null, outcome: 'ignored:not_subscription' };
      const customerId = idOf(session.customer);
      const subscriptionId = idOf(session.subscription);
      const team = await findTeam(customerId, session.client_reference_id ?? session.metadata?.teamId);
      if (!team) return { teamId: null, outcome: 'ignored:unknown_team' };
      if (!subscriptionId) return { teamId: team.id, outcome: 'ignored:no_subscription' };
      // The session says what was bought; the subscription says what it grants now.
      const sub = await deps.stripe.subscriptions.retrieve(subscriptionId);
      await writeTeam(team.id, {
        ...(customerId ? { stripeCustomerId: customerId } : {}),
        ...teamBillingFromSubscription(sub as unknown as SubscriptionLike, deps.prices),
      });
      return { teamId: team.id, outcome: 'applied' };
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = idOf(sub.customer);
      const team = await findTeam(customerId, sub.metadata?.teamId);
      if (!team) return { teamId: null, outcome: 'ignored:unknown_team' };
      // A team holds one subscription. An event about a different one (an
      // older, replaced subscription winding down) must not move the plan.
      if (team.stripeSubscriptionId && team.stripeSubscriptionId !== sub.id) {
        return { teamId: team.id, outcome: 'ignored:other_subscription' };
      }
      const customer = !team.stripeCustomerId && customerId ? { stripeCustomerId: customerId } : {};
      if (event.type === 'customer.subscription.deleted') {
        await writeTeam(team.id, { ...customer, plan: 'free', billingStatus: sub.status, stripeSubscriptionId: null, paidSeats: null });
      } else {
        await writeTeam(team.id, { ...customer, ...teamBillingFromSubscription(sub as unknown as SubscriptionLike, deps.prices) });
      }
      return { teamId: team.id, outcome: 'applied' };
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const team = await findTeam(idOf(invoice.customer), null);
      if (!team) return { teamId: null, outcome: 'ignored:unknown_team' };
      const subscriptionId = idOf(invoice.parent?.subscription_details?.subscription ?? null);
      if (!team.stripeSubscriptionId || (subscriptionId && subscriptionId !== team.stripeSubscriptionId)) {
        return { teamId: team.id, outcome: 'ignored:other_subscription' };
      }
      // The plan stays while Stripe retries the card; the subscription's own
      // update/delete event moves it if the retries run out.
      await writeTeam(team.id, { billingStatus: 'past_due' });
      return { teamId: team.id, outcome: 'applied' };
    }

    default:
      return { teamId: null, outcome: 'ignored:event_type' };
  }
}

type BillingTeamRow = { id: string; stripeCustomerId: string | null; stripeSubscriptionId: string | null };

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id ?? null;
}

async function findTeam(customerId: string | null, teamId: string | null | undefined): Promise<BillingTeamRow | null> {
  const columns = { id: true, stripeCustomerId: true, stripeSubscriptionId: true } as const;
  if (customerId) {
    const byCustomer = await db.query.teams.findFirst({ where: eq(teams.stripeCustomerId, customerId), columns });
    if (byCustomer) return byCustomer;
  }
  if (teamId && /^[0-9a-f-]{36}$/i.test(teamId)) {
    const byId = await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns });
    // A team already bound to a different customer is not this customer's team.
    if (byId && (!byId.stripeCustomerId || !customerId || byId.stripeCustomerId === customerId)) return byId;
  }
  return null;
}

async function writeTeam(teamId: string, values: Partial<typeof teams.$inferInsert>): Promise<void> {
  await db.update(teams).set({ ...values, updatedAt: new Date() }).where(eq(teams.id, teamId));
}
