import { db } from '@buildd/core/db';
import { teamInvitations, teamMembers, teams } from '@buildd/core/db/schema';
import { and, count, eq } from 'drizzle-orm';
import { isBillingEnforced } from '@buildd/core/entitlements';
import { seatDecision, type SeatDecision } from '@buildd/core/billing';

/** Members on the team and invitations still pending — what a seat count must cover. */
export async function teamSeatUsage(teamId: string): Promise<{ members: number; pending: number }> {
  const [[m], [p]] = await Promise.all([
    db.select({ n: count() }).from(teamMembers).where(eq(teamMembers.teamId, teamId)),
    db.select({ n: count() }).from(teamInvitations).where(and(eq(teamInvitations.teamId, teamId), eq(teamInvitations.status, 'pending'))),
  ]);
  return { members: Number(m?.n ?? 0), pending: Number(p?.n ?? 0) };
}

/**
 * Whether the team has a seat for one more member. Billing off = always yes,
 * with no query. `countPending` is true when inviting (a pending invite holds a
 * seat) and false when an invitation is being accepted (it already held one).
 *
 * Never charges: a full Team plan is refused, and the owner adds seats
 * themselves from Settings → Billing.
 */
export async function checkSeatForNewMember(teamId: string, opts: { countPending: boolean }): Promise<SeatDecision> {
  if (!isBillingEnforced()) return { ok: true };
  const [team, usage] = await Promise.all([
    db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { plan: true, paidSeats: true } }),
    teamSeatUsage(teamId),
  ]);
  return seatDecision({
    plan: team?.plan,
    paidSeats: team?.paidSeats,
    members: usage.members,
    pending: opts.countPending ? usage.pending : 0,
  });
}

/**
 * 402 for a full team. The body carries the decision so the dashboard can
 * offer the owner the Billing page; `billingUrl` is where seats are added.
 */
export function seatsExhaustedResponse(decision: Extract<SeatDecision, { ok: false }>, audience: 'manager' | 'invitee'): Response {
  const error = audience === 'invitee'
    ? 'This team has no free seats. Ask a team owner or admin to add seats, then accept again.'
    : decision.message;
  return Response.json({ ...decision, error, billingUrl: '/app/settings/billing' }, { status: 402 });
}
