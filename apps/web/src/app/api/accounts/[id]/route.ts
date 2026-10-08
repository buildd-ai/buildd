import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds, getUserTeamRole } from '@/lib/team-access';
import { canAdministerTeamKeys } from '@/lib/key-level-policy';
import { invalidateAccountCacheByHash } from '@/lib/api-auth';
import { invalidateAccountWorkspaceCache } from '@/lib/account-workspace-cache';
import { isUuid } from '@/lib/uuid';
import { getTeamPermissionOverrides } from '@/lib/permissions';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid account id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }

  if (process.env.NODE_ENV === 'development' && (!process.env.DATABASE_URL || !process.env.DEV_USER_EMAIL)) {
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
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid account id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }

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

    // Deleting a key is a manage_team_keys act, like editing or regenerating it.
    const role = await getUserTeamRole(user.id, account.teamId);
    if (!canAdministerTeamKeys(role, await getTeamPermissionOverrides(account.teamId))) {
      return NextResponse.json(
        { error: 'Only team members holding manage_team_keys can delete API keys' },
        { status: 403 },
      );
    }

    // Invalidate caches before deleting
    invalidateAccountCacheByHash(account.apiKey);
    invalidateAccountWorkspaceCache(account.id);

    // Delete the account (cascade will handle accountWorkspaces)
    await db.delete(accounts).where(eq(accounts.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete account error:', error);
    return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: `Invalid account id: expected a UUID, got "${id}". Pass the full UUID.` }, { status: 404 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { maxConcurrentWorkers } = body;

    if (maxConcurrentWorkers === undefined) {
      return NextResponse.json({ error: 'Missing maxConcurrentWorkers' }, { status: 400 });
    }

    if (!Number.isInteger(maxConcurrentWorkers) || maxConcurrentWorkers < 1 || maxConcurrentWorkers > 50) {
      return NextResponse.json({ error: 'maxConcurrentWorkers must be an integer between 1 and 50' }, { status: 400 });
    }

    const teamIds = await getUserTeamIds(user.id);
    const account = teamIds.length > 0
      ? await db.query.accounts.findFirst({
          where: and(eq(accounts.id, id), inArray(accounts.teamId, teamIds)),
        })
      : null;

    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const role = await getUserTeamRole(user.id, account.teamId);
    if (!canAdministerTeamKeys(role, await getTeamPermissionOverrides(account.teamId))) {
      return NextResponse.json(
        { error: 'Only team owners and admins can edit runner tokens' },
        { status: 403 },
      );
    }

    const updated = await db
      .update(accounts)
      .set({ maxConcurrentWorkers })
      .where(eq(accounts.id, id))
      .returning();

    invalidateAccountCacheByHash(account.apiKey);

    return NextResponse.json({
      maxConcurrentWorkers: updated[0]?.maxConcurrentWorkers || maxConcurrentWorkers,
    });
  } catch (error) {
    console.error('Update account error:', error);
    return NextResponse.json({ error: 'Failed to update account' }, { status: 500 });
  }
}
