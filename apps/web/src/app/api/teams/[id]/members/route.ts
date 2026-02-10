import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { teamMembers, users } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';

type TeamRole = 'owner' | 'admin' | 'member';

const ROLE_HIERARCHY: Record<TeamRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: teamId } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ members: [] });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Verify user is a member of this team
    const membership = await db.query.teamMembers.findFirst({
      where: and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.userId, user.id)
      ),
    });

    if (!membership) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    }

    const members = await db.query.teamMembers.findMany({
      where: eq(teamMembers.teamId, teamId),
      with: {
        user: true,
      },
    });

    const memberList = members.map(m => ({
      userId: m.userId,
      role: m.role,
      joinedAt: m.joinedAt,
      name: m.user.name,
      email: m.user.email,
      image: m.user.image,
    }));

    return NextResponse.json({ members: memberList });
  } catch (error) {
    console.error('Get team members error:', error);
    return NextResponse.json({ error: 'Failed to get team members' }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: teamId } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ success: true });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Verify current user is owner or admin
    const membership = await db.query.teamMembers.findFirst({
      where: and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.userId, user.id)
      ),
    });

    if (!membership) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    }

    const currentRole = membership.role as TeamRole;
    if (ROLE_HIERARCHY[currentRole] < ROLE_HIERARCHY['admin']) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json();
    const { userId, role } = body;

    if (!userId || !role) {
      return NextResponse.json({ error: 'userId and role are required' }, { status: 400 });
    }

    if (!['owner', 'admin', 'member'].includes(role)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
    }

    // Only owners can add other owners
    if (role === 'owner' && currentRole !== 'owner') {
      return NextResponse.json({ error: 'Only owners can add owners' }, { status: 403 });
    }

    // Validate user exists
    const targetUser = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true },
    });

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Check if already a member
    const existingMembership = await db.query.teamMembers.findFirst({
      where: and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.userId, userId)
      ),
    });

    if (existingMembership) {
      return NextResponse.json({ error: 'User is already a team member' }, { status: 409 });
    }

    await db
      .insert(teamMembers)
      .values({
        teamId,
        userId,
        role: role as TeamRole,
      });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Add team member error:', error);
    return NextResponse.json({ error: 'Failed to add team member' }, { status: 500 });
  }
}
