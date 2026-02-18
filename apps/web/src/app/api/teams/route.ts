import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { teams, teamMembers } from '@buildd/core/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth-helpers';

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Get all teams the user is a member of, with their role and member count
    const memberships = await db.query.teamMembers.findMany({
      where: eq(teamMembers.userId, user.id),
      with: {
        team: true,
      },
    });

    // Get member counts for each team
    const teamIds = memberships.map(m => m.teamId);
    const memberCounts = teamIds.length > 0
      ? await db
          .select({
            teamId: teamMembers.teamId,
            count: sql<number>`count(*)::int`,
          })
          .from(teamMembers)
          .where(inArray(teamMembers.teamId, teamIds))
          .groupBy(teamMembers.teamId)
      : [];

    const countMap = new Map(memberCounts.map(mc => [mc.teamId, mc.count]));

    const result = memberships.map(m => ({
      ...m.team,
      role: m.role,
      memberCount: countMap.get(m.teamId) || 1,
    }));

    return NextResponse.json({ teams: result });
  } catch (error) {
    console.error('Get teams error:', error);
    return NextResponse.json({ error: 'Failed to get teams' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { name, slug } = body;

    if (!name || !slug) {
      return NextResponse.json({ error: 'Name and slug are required' }, { status: 400 });
    }

    // Validate slug format
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return NextResponse.json({ error: 'Slug must contain only lowercase letters, numbers, and hyphens' }, { status: 400 });
    }

    // Check slug uniqueness
    const existing = await db.query.teams.findFirst({
      where: eq(teams.slug, slug),
      columns: { id: true },
    });

    if (existing) {
      return NextResponse.json({ error: 'A team with this slug already exists' }, { status: 409 });
    }

    // Create team
    const [team] = await db
      .insert(teams)
      .values({ name, slug })
      .returning();

    // Add current user as owner
    await db
      .insert(teamMembers)
      .values({
        teamId: team.id,
        userId: user.id,
        role: 'owner',
      });

    return NextResponse.json(team);
  } catch (error) {
    console.error('Create team error:', error);
    return NextResponse.json({ error: 'Failed to create team' }, { status: 500 });
  }
}
