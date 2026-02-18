import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { teamInvitations, teamMembers } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth-helpers';

// DELETE /api/teams/[id]/invitations/[invitationId] — revoke invitation
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; invitationId: string }> }
) {
  const { id: teamId, invitationId } = await params;

  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify user is owner or admin of this team
  const membership = await db.query.teamMembers.findFirst({
    where: and(
      eq(teamMembers.teamId, teamId),
      eq(teamMembers.userId, user.id)
    ),
  });

  if (!membership || membership.role === 'member') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    // Verify the invitation belongs to this team
    const invitation = await db.query.teamInvitations.findFirst({
      where: and(
        eq(teamInvitations.id, invitationId),
        eq(teamInvitations.teamId, teamId)
      ),
    });

    if (!invitation) {
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }

    await db.delete(teamInvitations).where(eq(teamInvitations.id, invitationId));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete invitation error:', error);
    return NextResponse.json({ error: 'Failed to delete invitation' }, { status: 500 });
  }
}
