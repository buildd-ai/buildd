import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { teamInvitations, teamMembers, users } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { requireSessionUser } from '@/lib/auth-helpers';
import crypto from 'crypto';
import { roleHas, getTeamPermissionOverrides } from '@/lib/permissions';
import { checkSeatForNewMember, seatsExhaustedResponse } from '@/lib/billing/seats';

// GET /api/teams/[id]/invitations — list pending invitations
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: teamId } = await params;

  const session = await requireSessionUser(req);
  if (session.response) return session.response;
  const user = session.user;

  // Verify user is owner or admin of this team
  const membership = await db.query.teamMembers.findFirst({
    where: and(
      eq(teamMembers.teamId, teamId),
      eq(teamMembers.userId, user.id)
    ),
  });

  if (!membership || !roleHas(membership.role, 'manage_team_members', await getTeamPermissionOverrides(teamId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const invitations = await db.query.teamInvitations.findMany({
      where: and(
        eq(teamInvitations.teamId, teamId),
        eq(teamInvitations.status, 'pending')
      ),
      with: {
        inviter: {
          columns: { id: true, name: true, email: true },
        },
      },
      orderBy: (ti, { desc }) => [desc(ti.createdAt)],
    });

    return NextResponse.json({ invitations });
  } catch (error) {
    console.error('List invitations error:', error);
    return NextResponse.json({ error: 'Failed to list invitations' }, { status: 500 });
  }
}

// POST /api/teams/[id]/invitations — create invitation
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: teamId } = await params;

  const session = await requireSessionUser(req);
  if (session.response) return session.response;
  const user = session.user;

  // Verify user is owner or admin of this team
  const membership = await db.query.teamMembers.findFirst({
    where: and(
      eq(teamMembers.teamId, teamId),
      eq(teamMembers.userId, user.id)
    ),
  });

  const overrides = await getTeamPermissionOverrides(teamId);
  if (!membership || !roleHas(membership.role, 'manage_team_members', overrides)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { email, role } = body;

    if (!email || !role) {
      return NextResponse.json({ error: 'email and role are required' }, { status: 400 });
    }

    if (role !== 'admin' && role !== 'member') {
      return NextResponse.json({ error: 'role must be admin or member' }, { status: 400 });
    }

    // Widening manage_team_members must not let its holders mint admins.
    if (role === 'admin' && !roleHas(membership.role, 'assign_team_roles', overrides)) {
      return NextResponse.json({ error: 'Inviting an admin needs the assign_team_roles permission' }, { status: 403 });
    }

    // Check if email is already a team member
    const existingMember = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (existingMember) {
      const alreadyMember = await db.query.teamMembers.findFirst({
        where: and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, existingMember.id)
        ),
      });

      if (alreadyMember) {
        return NextResponse.json({ error: 'User is already a team member' }, { status: 409 });
      }
    }

    // Check for duplicate pending invitation
    const existingInvite = await db.query.teamInvitations.findFirst({
      where: and(
        eq(teamInvitations.teamId, teamId),
        eq(teamInvitations.email, email),
        eq(teamInvitations.status, 'pending')
      ),
    });

    if (existingInvite) {
      return NextResponse.json({ error: 'A pending invitation already exists for this email' }, { status: 409 });
    }

    // A pending invite holds a seat. Past the paid seats: refuse and point the
    // owner at Billing to add seats, never charge silently.
    const seat = await checkSeatForNewMember(teamId, { countPending: true });
    if (!seat.ok) return seatsExhaustedResponse(seat, 'manager');

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const [invitation] = await db
      .insert(teamInvitations)
      .values({
        teamId,
        email,
        role,
        token,
        invitedBy: user.id,
        expiresAt,
      })
      .returning();

    // Build invite URL
    const baseUrl = process.env.NEXTAUTH_URL || process.env.VERCEL_URL || 'http://localhost:3000';
    const inviteUrl = `${baseUrl}/app/invitations/${token}`;

    return NextResponse.json({ invitation, inviteUrl });
  } catch (error) {
    console.error('Create invitation error:', error);
    return NextResponse.json({ error: 'Failed to create invitation' }, { status: 500 });
  }
}
