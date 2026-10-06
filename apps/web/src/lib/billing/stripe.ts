import Stripe from 'stripe';

/**
 * The Stripe API client, or null when STRIPE_SECRET_KEY is unset (billing not
 * configured on this deployment — routes answer 503 rather than throwing).
 * Created once per process. Tests mock this module; nothing calls live Stripe.
 *
 * Signature checks do not go through here: Stripe.webhooks is static and
 * needs only STRIPE_WEBHOOK_SECRET.
 */
let client: Stripe | null = null;

export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  client ??= new Stripe(key);
  return client;
}
