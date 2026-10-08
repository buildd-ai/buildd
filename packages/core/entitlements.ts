// What a team is entitled to, by billing plan. The one place every billing gate
// reads (member count, knowledge-base cap, decision calls on buildd's key) —
// gates never look at `teams.plan` directly.
//
// Plans (knowledge-base: buildd/plans/billing-v1.md):
//   free — 1 member, small knowledge base, decision calls bring-your-own-key
//   pro  — 1 member, full knowledge base, decision calls included
//   team — paid seat count members (min 5), shared full knowledge base, decisions included
//
// Enforcement is behind a global switch, BILLING_ENFORCED (env), default OFF.
// While off every team gets unlimited entitlements, so shipping the plan column
// and this helper changes nothing until the switch is flipped.
//
// No Stripe here: the webhook writes `teams.plan` / `paidSeats`, this only reads.

import type { TeamPlan } from '@buildd/shared';

export type { TeamPlan };

export const TEAM_PLANS: readonly TeamPlan[] = ['free', 'pro', 'team'];

/** Fewest members a Team plan covers, whatever seat count Stripe reports. */
export const TEAM_PLAN_MIN_SEATS = 5;

/**
 * Free plan knowledge-base cap, as a DOCUMENT COUNT (not bytes, not age): the
 * number of distinct source documents the team has ingested into its knowledge
 * base. A count is what a person can see and reason about ("you have 50 of 50
 * docs"); a byte cap would punish one large file and say nothing useful.
 */
export const FREE_KNOWLEDGE_BASE_DOC_CAP = 50;

export interface Entitlements {
  /** The team's plan, normalized — an unknown stored value reads as 'free'. */
  plan: TeamPlan;
  /** Whether BILLING_ENFORCED is on. False = every limit below is lifted. */
  enforced: boolean;
  /** Max team members. null = unlimited. */
  maxMembers: number | null;
  /** Max knowledge-base documents (see FREE_KNOWLEDGE_BASE_DOC_CAP). null = unlimited. */
  knowledgeBaseCap: number | null;
  /** True = decision calls may run on buildd's key; false = the team brings its own. */
  decisionCallsIncluded: boolean;
}

/** The team fields entitlements depend on — a `teams` row satisfies it. */
export interface EntitlementTeam {
  plan?: string | null;
  paidSeats?: number | null;
}

type Env = Record<string, string | undefined>;

/** BILLING_ENFORCED switch. Only an explicit 1/true/on/yes turns it on. */
export function isBillingEnforced(env: Env = process.env): boolean {
  const raw = env.BILLING_ENFORCED?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** Any stored value that is not a known plan is treated as 'free'. */
export function normalizePlan(plan: string | null | undefined): TeamPlan {
  return (TEAM_PLANS as readonly string[]).includes(plan ?? '') ? (plan as TeamPlan) : 'free';
}

function teamSeats(paidSeats: number | null | undefined): number {
  const seats = typeof paidSeats === 'number' && Number.isFinite(paidSeats) ? Math.floor(paidSeats) : 0;
  return Math.max(TEAM_PLAN_MIN_SEATS, seats);
}

export function entitlements(team: EntitlementTeam, opts: { env?: Env } = {}): Entitlements {
  const plan = normalizePlan(team.plan);
  const enforced = isBillingEnforced(opts.env ?? process.env);

  if (!enforced) {
    return { plan, enforced, maxMembers: null, knowledgeBaseCap: null, decisionCallsIncluded: true };
  }

  switch (plan) {
    case 'team':
      return { plan, enforced, maxMembers: teamSeats(team.paidSeats), knowledgeBaseCap: null, decisionCallsIncluded: true };
    case 'pro':
      return { plan, enforced, maxMembers: 1, knowledgeBaseCap: null, decisionCallsIncluded: true };
    case 'free':
      return { plan, enforced, maxMembers: 1, knowledgeBaseCap: FREE_KNOWLEDGE_BASE_DOC_CAP, decisionCallsIncluded: false };
  }
}
