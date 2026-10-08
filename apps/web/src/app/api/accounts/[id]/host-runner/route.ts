import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { invalidateAccountCacheByHash } from '@/lib/api-auth';
import { getUserTeamIds, getUserTeamRole } from '@/lib/team-access';
import { canAdministerTeamKeys } from '@/lib/key-level-policy';
import { isUuid } from '@/lib/uuid';
import { getTeamPermissionOverrides } from '@/lib/permissions';

/**
 * PUT /api/accounts/[id]/host-runner  { hostRunner: boolean }
 *
 * Flags (or unflags) a key as a long-lived host runner key, the only kind the
 * credential lease / refresh routes and the secrets list accept
 * (lib/credential-custody.ts). Session only, team owners and admins only:
 * the flag grants reach into the team's stored credentials.
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

  const body = await req.json().catch(() => ({})) as { hostRunner?: unknown };
  if (typeof body.hostRunner !== 'boolean') {
    return NextResponse.json({ error: 'hostRunner (boolean) is required' }, { status: 400 });
  }

  const teamIds = await getUserTeamIds(user.id);
  const account = teamIds.length > 0
    ? await db.query.accounts.findFirst({
        where: and(eq(accounts.id, id), inArray(accounts.teamId, teamIds)),
        columns: { id: true, teamId: true, apiKey: true },
      })
    : null;
  if (!account) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  }

  const role = await getUserTeamRole(user.id, account.teamId);
  if (!canAdministerTeamKeys(role, await getTeamPermissionOverrides(account.teamId))) {
    return NextResponse.json(
      { error: 'Only team owners and admins can flag a host runner key' },
      { status: 403 },
    );
  }

  await db.update(accounts).set({ hostRunner: body.hostRunner }).where(eq(accounts.id, id));
  // The auth cache holds the account row, flag included.
  invalidateAccountCacheByHash(account.apiKey);

  return NextResponse.json({ id, hostRunner: body.hostRunner });
}
