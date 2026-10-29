import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { invalidateAccountCacheByHash } from '@/lib/api-auth';
import { clearTeamCache } from '@/lib/team-cache';
import { getUserTeamIds, getUserTeamRole } from '@/lib/team-access';
import { canAdministerTeamKeys } from '@/lib/key-level-policy';
import { isUuid } from '@/lib/uuid';
import { sqlWhere } from '@buildd/core/db/relational-sql';


/**
 * PUT /api/accounts/[id]/reach-all  { reachAll: boolean }
 *
 * Turns "all current and future workspaces its creator can reach" on or off
 * for a runner key (accounts.reach_all_workspaces, resolved at claim time in
 * lib/claim-order.ts). Turning it on also clears the key's own workspace
 * list, which would otherwise keep cutting the reach. Session only, team
 * owners and admins only. The key needs a recorded creator: reach is theirs.
 */
export async function PUT(
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

  const body = await req.json().catch(() => ({})) as { reachAll?: unknown };
  if (typeof body.reachAll !== 'boolean') {
    return NextResponse.json({ error: 'reachAll (boolean) is required' }, { status: 400 });
  }

  const teamIds = await getUserTeamIds(user.id);
  const account = teamIds.length > 0
    ? await db.query.accounts.findFirst({
        where: sqlWhere(and(eq(accounts.id, id), inArray(accounts.teamId, teamIds))),
        columns: { id: true, teamId: true, apiKey: true, createdByUserId: true },
      })
    : null;
  if (!account) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  }

  const role = await getUserTeamRole(user.id, account.teamId);
  if (!canAdministerTeamKeys(role)) {
    return NextResponse.json(
      { error: 'Only team owners and admins can change which workspaces a key reaches' },
      { status: 403 },
    );
  }

  if (body.reachAll && !account.createdByUserId) {
    return NextResponse.json({ error: 'This key has no recorded creator, so it has no reach to follow' }, { status: 409 });
  }

  await db.update(accounts)
    .set(body.reachAll ? { reachAllWorkspaces: true, workspaceIds: null } : { reachAllWorkspaces: false }).where(eq(accounts.id, id));
  // The auth cache holds the account row, flag included.
  await invalidateAccountCacheByHash(account.apiKey);
  await clearTeamCache(account.teamId, 'runners');

  return NextResponse.json({ id, reachAll: body.reachAll });
}
