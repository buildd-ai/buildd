import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { teamMembers, teams } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireSessionUser } from '@/lib/auth-helpers';
import { roleHas, isTeamRole, getTeamPermissionOverrides } from '@/lib/permissions';
import { clampCreatorKeys } from '@/lib/creator-key-clamp';

async function ownerCount(teamId: string): Promise<number> {
  const owners = await db.query.teamMembers.findMany({
    where: and(
      eq(teamMembers.teamId, teamId),
      eq(teamMembers.role, 'owner')
    ),
    columns: { userId: true },
  });
  return owners.length;
}

/**
 * Change a member's role. member ↔ admin takes `assign_team_roles`; any change
 * to or from owner takes `assign_team_owner`. Demoting an owner is refused
 * while they are the team's last owner, whoever asks.
 *
 * Once the role is written, the keys the target minted in this team are
 * clamped to what the new role may mint (creator-key-clamp.ts); the response
 * says how many changed as `clampedKeys`.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  const { id: teamId, userId: targetUserId } = await params;

  const session = await requireSessionUser(req);
  if (session.response) return session.response;
  const user = session.user;

  try {
    const currentMembership = await db.query.teamMembers.findFirst({
      where: and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.userId, user.id)
      ),
    });

    if (!currentMembership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Owner holds every permission, so assign_team_roles is the floor for any
    // role change: refuse before revealing whether the target exists.
    const overrides = await getTeamPermissionOverrides(teamId);
    if (!roleHas(currentMembership.role, 'assign_team_roles', overrides)) {
      return NextResponse.json({ error: 'Changing roles needs the assign_team_roles permission' }, { status: 403 });
    }

    const body = await req.json();
    const { role } = body;

    if (!isTeamRole(role)) {
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

    if (
      (targetMembership.role === 'owner' || role === 'owner') &&
      !roleHas(currentMembership.role, 'assign_team_owner', null /* locked */)
    ) {
      return NextResponse.json({ error: "Changing a role to or from owner needs the assign_team_owner permission" }, { status: 403 });
    }

    if (targetMembership.role === 'owner' && role !== 'owner' && (await ownerCount(teamId)) <= 1) {
      return NextResponse.json({ error: 'Cannot demote the last owner. Make someone else an owner first.' }, { status: 400 });
    }

    const updated = await db
      .update(teamMembers)
      .set({ role })
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, targetUserId)
        )
      )
      .returning({ userId: teamMembers.userId });

    if (updated.length === 0) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    const clampedKeys = await clampCreatorKeys({ teamId, userId: targetUserId, role, overrides });

    return NextResponse.json({ success: true, clampedKeys });
  } catch (error) {
    console.error('Update member role error:', error);
    return NextResponse.json({ error: 'Failed to update member role' }, { status: 500 });
  }
}

/**
 * Remove a member, or leave. Removing someone else takes
 * `manage_team_members` (and `assign_team_owner` for an owner). Removing
 * yourself is leaving: any member may, except the last owner and the owner of
 * a personal team.
 *
 * Once the membership is gone, the keys the person minted in this team are
 * clamped to what a member may mint, admin scopes dropped. They are not
 * revoked. The response says how many changed as `clampedKeys`.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  const { id: teamId, userId: targetUserId } = await params;

  const session = await requireSessionUser(req);
  if (session.response) return session.response;
  const user = session.user;

  try {
    const currentMembership = await db.query.teamMembers.findFirst({
      where: and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.userId, user.id)
      ),
    });

    if (!currentMembership) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    }

    const currentRole = currentMembership.role;

    if (targetUserId === user.id) {
      const team = await db.query.teams.findFirst({
        where: eq(teams.id, teamId),
        columns: { slug: true },
      });
      if (team?.slug.startsWith('personal-')) {
        return NextResponse.json({ error: 'You cannot leave your personal team' }, { status: 400 });
      }
      if (currentRole === 'owner' && (await ownerCount(teamId)) <= 1) {
        return NextResponse.json({ error: 'You are the last owner. Transfer ownership before leaving.' }, { status: 400 });
      }
    } else {
      if (!roleHas(currentRole, 'manage_team_members', await getTeamPermissionOverrides(teamId))) {
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

      if (targetMembership.role === 'owner') {
        // Removing an owner takes more than member management: admins cannot.
        if (!roleHas(currentRole, 'assign_team_owner', null /* locked */)) {
          return NextResponse.json({ error: 'Admins cannot remove owners' }, { status: 403 });
        }
        if ((await ownerCount(teamId)) <= 1) {
          return NextResponse.json({ error: 'Cannot remove the last owner' }, { status: 400 });
        }
      }
    }

    const removed = await db
      .delete(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, targetUserId)
        )
      )
      .returning({ userId: teamMembers.userId });

    // Nothing removed (they already left): their keys were clamped then.
    const clampedKeys = removed.length > 0
      ? await clampCreatorKeys({ teamId, userId: targetUserId, role: null })
      : 0;

    return NextResponse.json({ success: true, clampedKeys });
  } catch (error) {
    console.error('Remove team member error:', error);
    return NextResponse.json({ error: 'Failed to remove team member' }, { status: 500 });
  }
}
