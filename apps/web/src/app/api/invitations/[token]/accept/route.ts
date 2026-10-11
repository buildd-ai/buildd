import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { teamInvitations, teamMembers, teams } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { requireSessionUser } from '@/lib/auth-helpers';
import { checkSeatForNewMember, seatsExhaustedResponse } from '@/lib/billing/seats';

function normaliseEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

/** `maria@acme.dev` → `m***@acme.dev`: enough to recognise, not to harvest. */
function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at < 1) return '***';
  return `${trimmed[0]}***${trimmed.slice(at)}`;
}

// POST /api/invitations/[token]/accept — accept an invitation
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const session = await requireSessionUser(req);
  if (session.response) return session.response;
  const user = session.user;

  try {
    const invitation = await db.query.teamInvitations.findFirst({
      where: eq(teamInvitations.token, token),
    });

    if (!invitation) {
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }

    // An invite link is a capability for one address: anyone else holding it
    // is refused before it is touched (no expiry write, no seat check).
    if (normaliseEmail(invitation.email) !== normaliseEmail(user.email)) {
      return NextResponse.json({
        error: `This invitation was sent to ${maskEmail(invitation.email)}. Sign in with that address to accept it.`,
      }, { status: 403 });
    }

    if (invitation.status !== 'pending') {
      return NextResponse.json({ error: `Invitation has already been ${invitation.status}` }, { status: 400 });
    }

    if (new Date(invitation.expiresAt) <= new Date()) {
      // Mark as expired
      await db.update(teamInvitations)
        .set({ status: 'expired' })
        .where(eq(teamInvitations.id, invitation.id));
      return NextResponse.json({ error: 'Invitation has expired' }, { status: 410 });
    }

    // The invite held a seat, so only members count here. Someone already in
    // the team takes no new seat. A team that lost seats since (downgrade) is
    // refused; the invitation stays pending.
    const alreadyMember = await db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.teamId, invitation.teamId), eq(teamMembers.userId, user.id)),
      columns: { userId: true },
    });
    if (!alreadyMember) {
      const seat = await checkSeatForNewMember(invitation.teamId, { countPending: false });
      if (!seat.ok) return seatsExhaustedResponse(seat, 'invitee');
    }

    // Add user to team
    await db.insert(teamMembers)
      .values({
        teamId: invitation.teamId,
        userId: user.id,
        role: invitation.role,
      })
      .onConflictDoNothing();

    // Mark invitation as accepted
    await db.update(teamInvitations)
      .set({ status: 'accepted' })
      .where(eq(teamInvitations.id, invitation.id));

    // Get team info to return. Explicit column list — an unfiltered query selects
    // every column declared in schema.ts, so removing one breaks this route for the
    // whole build window, since db:migrate runs before next build. Identity only;
    // this response never carried anything a caller needs beyond them.
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, invitation.teamId),
      columns: { id: true, name: true, slug: true },
    });

    return NextResponse.json({ team });
  } catch (error) {
    console.error('Accept invitation error:', error);
    return NextResponse.json({ error: 'Failed to accept invitation' }, { status: 500 });
  }
}
