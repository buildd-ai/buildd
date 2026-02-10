import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({ account: null });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const teamIds = await getUserTeamIds(user.id);
    const account = teamIds.length > 0
      ? await db.query.accounts.findFirst({
          where: and(eq(accounts.id, id), inArray(accounts.teamId, teamIds)),
        })
      : null;

    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    return NextResponse.json({ account });
  } catch (error) {
    console.error('Get account error:', error);
    return NextResponse.json({ error: 'Failed to get account' }, { status: 500 });
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
    const teamIds = await getUserTeamIds(user.id);
    const account = teamIds.length > 0
      ? await db.query.accounts.findFirst({
          where: and(eq(accounts.id, id), inArray(accounts.teamId, teamIds)),
        })
      : null;

    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // Delete the account (cascade will handle accountWorkspaces)
    await db.delete(accounts).where(eq(accounts.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete account error:', error);
    return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 });
  }
}
