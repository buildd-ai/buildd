import type { NextRequest } from 'next/server';
import type Stripe from 'stripe';
import { db } from '@buildd/core/db';
import { teamMembers, teams } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { isBillingEnforced } from '@buildd/core/entitlements';
import { billingPricesFromEnv, type BillingPrices } from '@buildd/core/billing';
import { requireSessionUser } from '@/lib/auth-helpers';
import { roleHas } from '@/lib/permission-registry';
import { getStripe } from './stripe';

/** The team columns the billing routes and page read. */
export const BILLING_TEAM_COLUMNS = {
  id: true,
  name: true,
  plan: true,
  billingStatus: true,
  stripeCustomerId: true,
  stripeSubscriptionId: true,
  paidSeats: true,
} as const;

export interface BillingTeam {
  id: string;
  name: string;
  plan: string;
  billingStatus: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  paidSeats: number | null;
}

export type BillingAccess =
  | { response: Response; team?: undefined }
  | { response?: undefined; team: BillingTeam; user: { id: string; email?: string | null }; stripe: Stripe; prices: BillingPrices };

/** Subscription statuses that count as a live subscription (one Checkout must not stack a second on). */
export const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due']);

export function hasLiveSubscription(team: Pick<BillingTeam, 'stripeSubscriptionId' | 'billingStatus'>): boolean {
  return !!team.stripeSubscriptionId && LIVE_SUBSCRIPTION_STATUSES.has(team.billingStatus ?? '');
}

/**
 * The gate every team billing route opens with. In order:
 * - BILLING_ENFORCED off → 404: billing does not exist yet.
 * - not signed in → 401; an API key → 403 (spending money is a person).
 * - not a member → 404; a member without `manage_billing` (owner/admin, locked) → 403.
 * - Stripe key or price ids unset → 503.
 */
export async function requireBillingManager(req: NextRequest, teamId: string): Promise<BillingAccess> {
  if (!isBillingEnforced()) {
    return { response: Response.json({ error: 'Not found' }, { status: 404 }) };
  }

  const session = await requireSessionUser(req);
  if (session.response) return { response: session.response };

  const membership = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, session.user.id)),
  });
  if (!membership) return { response: Response.json({ error: 'Team not found' }, { status: 404 }) };
  // manage_billing is locked, so team overrides never apply.
  if (!roleHas(membership.role, 'manage_billing', null)) {
    return { response: Response.json({ error: 'Only a team owner or admin can manage billing' }, { status: 403 }) };
  }

  const stripe = getStripe();
  const prices = billingPricesFromEnv();
  if (!stripe || !prices) {
    return { response: Response.json({ error: 'Billing is not configured on this deployment' }, { status: 503 }) };
  }

  const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: BILLING_TEAM_COLUMNS });
  if (!team) return { response: Response.json({ error: 'Team not found' }, { status: 404 }) };

  return { team: team as BillingTeam, user: session.user, stripe, prices };
}
