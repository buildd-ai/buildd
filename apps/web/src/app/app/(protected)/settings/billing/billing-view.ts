import { normalizePlan, TEAM_PLAN_MIN_SEATS, type TeamPlan } from '@buildd/core/entitlements';
import type { ChipTone } from '@/components/ui/Chip';

/** What the Billing page shows, derived from the team row and head counts. Pure, so it is testable. */
export interface BillingView {
  plan: TeamPlan;
  planLabel: string;
  status: { label: string; tone: ChipTone } | null;
  /** "4 of 5 seats used" on Team; members otherwise. */
  seatsLine: string;
  /** Live subscription: change it in the portal, never stack a second Checkout. */
  subscribed: boolean;
  /** Has a Stripe customer: the portal can open (invoices even after cancelling). */
  hasCustomer: boolean;
  paidSeats: number | null;
  used: number;
  /** Plans the owner can start from here. */
  upgrades: Array<'pro' | 'team'>;
  /** A single-member plan with more than one person can't take Pro. */
  proBlocked: boolean;
}

export const PLAN_LABELS: Record<TeamPlan, string> = { free: 'Free', pro: 'Pro', team: 'Team' };

export const PLAN_FEATURES: Record<TeamPlan, string[]> = {
  free: ['1 member', 'Small knowledge base', 'Decisions on your own model key'],
  pro: ['1 member', 'Full knowledge base', 'Decisions included'],
  team: [`${TEAM_PLAN_MIN_SEATS} seats or more`, 'Shared full knowledge base', 'Decisions included'],
};

const STATUS: Record<string, { label: string; tone: ChipTone }> = {
  active: { label: 'active', tone: 'success' },
  trialing: { label: 'trial', tone: 'info' },
  past_due: { label: 'payment failed', tone: 'warning' },
  unpaid: { label: 'unpaid', tone: 'error' },
  canceled: { label: 'cancelled', tone: 'muted' },
  incomplete: { label: 'incomplete', tone: 'warning' },
  incomplete_expired: { label: 'expired', tone: 'muted' },
  paused: { label: 'paused', tone: 'muted' },
};

const LIVE = new Set(['active', 'trialing', 'past_due']);

export function billingView(
  team: { plan?: string | null; billingStatus?: string | null; stripeCustomerId?: string | null; stripeSubscriptionId?: string | null; paidSeats?: number | null },
  usage: { members: number; pending: number },
): BillingView {
  const plan = normalizePlan(team.plan);
  const subscribed = !!team.stripeSubscriptionId && LIVE.has(team.billingStatus ?? '');
  const used = usage.members + usage.pending;
  const paidSeats = plan === 'team' ? Math.max(TEAM_PLAN_MIN_SEATS, team.paidSeats ?? 0) : null;
  const people = (n: number) => `${n} ${n === 1 ? 'member' : 'members'}`;
  const seatsLine = paidSeats !== null
    ? `${used} of ${paidSeats} seats used${usage.pending > 0 ? `, ${usage.pending} invited` : ''}`
    : `${people(usage.members)}${usage.pending > 0 ? `, ${usage.pending} invited` : ''}`;

  return {
    plan,
    planLabel: PLAN_LABELS[plan],
    status: team.billingStatus ? STATUS[team.billingStatus] ?? { label: team.billingStatus.replace(/_/g, ' '), tone: 'muted' } : null,
    seatsLine,
    subscribed,
    hasCustomer: !!team.stripeCustomerId,
    paidSeats,
    used,
    upgrades: subscribed ? [] : (['pro', 'team'] as const).filter((p) => p !== plan),
    proBlocked: usage.members > 1,
  };
}
