import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { teamMembers, teams } from '@buildd/core/db/schema';
import { and, eq, ne, sql } from 'drizzle-orm';
import { requireSessionUser } from '@/lib/auth-helpers';
import { roleHas } from '@/lib/permissions';
import { isUuid } from '@/lib/uuid';

/**
 * POST /api/teams/[id]/ownership { userId } — hand ownership to an existing
 * member: they become owner, the caller becomes admin. Session only, and only
 * for holders of `assign_team_owner` (locked to owners).
 *
 * Both writes go in one db.batch (one non-interactive transaction on
 * neon-http), promote first. The demote only matches once the target is an
 * owner, so a target who left mid-request leaves the caller an owner and the
 * team never has zero owners.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  const teamId = id;

  const session = await requireSessionUser(req);
  if (session.response) return session.response;
  const user = session.user;

  try {
    const membership = await db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, user.id)),
    });

    if (!membership || !roleHas(membership.role, 'assign_team_owner', null /* locked */)) {
      return NextResponse.json({ error: 'Transferring ownership needs the assign_team_owner permission' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const targetUserId: unknown = body?.userId;

    if (typeof targetUserId !== 'string' || !targetUserId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    }
    if (targetUserId === user.id) {
      return NextResponse.json({ error: 'You already own this team' }, { status: 400 });
    }
    if (!isUuid(targetUserId)) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    const team = await db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      columns: { slug: true },
    });
    if (!team) return NextResponse.json({ error: 'Team not found' }, { status: 404 });
    if (team.slug.startsWith('personal-')) {
      return NextResponse.json({ error: 'A personal team cannot change owner' }, { status: 400 });
    }

    const target = await db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, targetUserId)),
    });
    if (!target) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }
    if (target.role === 'owner') {
      return NextResponse.json({ error: 'That member is already an owner' }, { status: 400 });
    }

    const [promoted] = await db.batch([
      db.update(teamMembers)
        .set({ role: 'owner' })
        .where(and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, targetUserId),
          ne(teamMembers.role, 'owner'),
        ))
        .returning({ userId: teamMembers.userId }),
      db.update(teamMembers)
        .set({ role: 'admin' })
        .where(and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, user.id),
          eq(teamMembers.role, 'owner'),
          sql`exists (select 1 from ${teamMembers} t where t.team_id = ${teamId} and t.user_id = ${targetUserId} and t.role = 'owner')`,
        ))
        .returning({ userId: teamMembers.userId }),
    ]);

    if (promoted.length === 0) {
      return NextResponse.json({ error: 'That member is no longer in the team. Nothing changed.' }, { status: 409 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Transfer team ownership error:', error);
    return NextResponse.json({ error: 'Failed to transfer ownership' }, { status: 500 });
  }
}
