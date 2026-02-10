import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { teams, teamMembers, users } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';

type TeamRole = 'owner' | 'admin' | 'member';

const ROLE_HIERARCHY: Record<TeamRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

async function verifyTeamAccess(
  userId: string,
  teamId: string,
  requiredRole?: TeamRole
): Promise<{ role: TeamRole } | null> {
  const membership = await db.query.teamMembers.findFirst({
    where: and(
      eq(teamMembers.teamId, teamId),
      eq(teamMembers.userId, userId)
    ),
  });

  if (!membership) return null;

  const role = membership.role as TeamRole;

  if (requiredRole && ROLE_HIERARCHY[role] < ROLE_HIERARCHY[requiredRole]) {
    return null;
  }

  return { role };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ team: null });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const access = await verifyTeamAccess(user.id, id);
    if (!access) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    }

    const team = await db.query.teams.findFirst({
      where: eq(teams.id, id),
    });

    if (!team) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    }

    // Get members with user info
    const members = await db.query.teamMembers.findMany({
      where: eq(teamMembers.teamId, id),
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

    return NextResponse.json({
      team,
      members: memberList,
      currentUserRole: access.role,
    });
  } catch (error) {
    console.error('Get team error:', error);
    return NextResponse.json({ error: 'Failed to get team' }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ success: true });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const access = await verifyTeamAccess(user.id, id, 'admin');
    if (!access) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json();
    const { name, slug } = body;

    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (name !== undefined) updates.name = name;
    if (slug !== undefined) {
      // Validate slug format
      if (!/^[a-z0-9-]+$/.test(slug)) {
        return NextResponse.json({ error: 'Slug must contain only lowercase letters, numbers, and hyphens' }, { status: 400 });
      }

      // Check slug uniqueness (excluding current team)
      const existing = await db.query.teams.findFirst({
        where: eq(teams.slug, slug),
        columns: { id: true },
      });

      if (existing && existing.id !== id) {
        return NextResponse.json({ error: 'A team with this slug already exists' }, { status: 409 });
      }

      updates.slug = slug;
    }

    await db.update(teams).set(updates).where(eq(teams.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Update team error:', error);
    return NextResponse.json({ error: 'Failed to update team' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ success: true });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const access = await verifyTeamAccess(user.id, id, 'owner');
    if (!access) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Check if it's a personal team
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, id),
      columns: { slug: true },
    });

    if (team?.slug.startsWith('personal-')) {
      return NextResponse.json({ error: 'Cannot delete personal team' }, { status: 400 });
    }

    await db.delete(teams).where(eq(teams.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete team error:', error);
    return NextResponse.json({ error: 'Failed to delete team' }, { status: 500 });
  }
}
