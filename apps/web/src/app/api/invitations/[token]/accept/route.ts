import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { teamInvitations, teamMembers, teams } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';

// POST /api/invitations/[token]/accept — accept an invitation
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const invitation = await db.query.teamInvitations.findFirst({
      where: eq(teamInvitations.token, token),
    });

    if (!invitation) {
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
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

    // Get team info to return
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, invitation.teamId),
    });

    return NextResponse.json({ team });
  } catch (error) {
    console.error('Accept invitation error:', error);
    return NextResponse.json({ error: 'Failed to accept invitation' }, { status: 500 });
  }
}
