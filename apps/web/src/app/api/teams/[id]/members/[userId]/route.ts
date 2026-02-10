import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { teamMembers } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';

type TeamRole = 'owner' | 'admin' | 'member';

const ROLE_HIERARCHY: Record<TeamRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  const { id: teamId, userId: targetUserId } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ success: true });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Verify current user is owner
    const currentMembership = await db.query.teamMembers.findFirst({
      where: and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.userId, user.id)
      ),
    });

    if (!currentMembership || currentMembership.role !== 'owner') {
      return NextResponse.json({ error: 'Only owners can change roles' }, { status: 403 });
    }

    const body = await req.json();
    const { role } = body;

    if (!role || !['owner', 'admin', 'member'].includes(role)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
    }

    // Verify target is a member
    const targetMembership = await db.query.teamMembers.findFirst({
      where: and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.userId, targetUserId)
      ),
    });

    if (!targetMembership) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    // If changing own role away from owner, check if last owner
    if (targetUserId === user.id && targetMembership.role === 'owner' && role !== 'owner') {
      const owners = await db.query.teamMembers.findMany({
        where: and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.role, 'owner')
        ),
        columns: { userId: true },
      });

      if (owners.length <= 1) {
        return NextResponse.json({ error: 'Cannot change role - you are the last owner' }, { status: 400 });
      }
    }

    await db
      .update(teamMembers)
      .set({ role: role as TeamRole })
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, targetUserId)
        )
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Update member role error:', error);
    return NextResponse.json({ error: 'Failed to update member role' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  const { id: teamId, userId: targetUserId } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ success: true });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Verify current user is owner or admin
    const currentMembership = await db.query.teamMembers.findFirst({
      where: and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.userId, user.id)
      ),
    });

    if (!currentMembership) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    }

    const currentRole = currentMembership.role as TeamRole;
    if (ROLE_HIERARCHY[currentRole] < ROLE_HIERARCHY['admin']) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Verify target is a member
    const targetMembership = await db.query.teamMembers.findFirst({
      where: and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.userId, targetUserId)
      ),
    });

    if (!targetMembership) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    // Cannot remove self if owner (must transfer first)
    if (targetUserId === user.id && currentRole === 'owner') {
      return NextResponse.json({ error: 'Owners cannot remove themselves. Transfer ownership first.' }, { status: 400 });
    }

    // Cannot remove last owner
    if (targetMembership.role === 'owner') {
      const owners = await db.query.teamMembers.findMany({
        where: and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.role, 'owner')
        ),
        columns: { userId: true },
      });

      if (owners.length <= 1) {
        return NextResponse.json({ error: 'Cannot remove the last owner' }, { status: 400 });
      }
    }

    // Admins cannot remove owners
    if (currentRole === 'admin' && targetMembership.role === 'owner') {
      return NextResponse.json({ error: 'Admins cannot remove owners' }, { status: 403 });
    }

    await db
      .delete(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, targetUserId)
        )
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Remove team member error:', error);
    return NextResponse.json({ error: 'Failed to remove team member' }, { status: 500 });
  }
}
