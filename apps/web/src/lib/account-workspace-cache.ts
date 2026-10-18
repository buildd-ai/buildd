import { db } from '@buildd/core/db';
import { accountWorkspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { cachedCaller, clearCallerCache, callerDep } from './caller-cache';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { liveGrantedWorkspaceIds } from './granted-links';

/**
 * Cached account workspace permission entry.
 */
export interface AccountWorkspacePermission {
  workspaceId: string;
  canClaim: boolean;
  canCreate: boolean;
  /**
   * The person who picked this workspace on the runner consent page
   * (lib/granted-links.ts). Absent/null = an ordinary link.
   */
  grantedByUserId?: string | null;
  /**
   * Only with `includeRevoked`: a granted row whose grant no longer holds
   * (the person left the team, lost the role, or the workspace turned
   * restricted). It reaches nothing; canClaim and canCreate are false.
   */
  revoked?: boolean;
}

/**
 * Account → workspace permissions, cached in Redis for at most 60 s
 * (lib/caller-cache.ts). Queried on every claim, active workers check, task
 * list and workspace list.
 *
 * Cleared on every instance at once when a link is created, updated or
 * deleted (invalidateAccountWorkspaceCache) or a linked workspace's access
 * mode changes (invalidateWorkspacePermissionsCache). An account with no
 * links is cached too; every link write clears it, so a new link is seen on
 * the next call.
 */
/**
 * Get workspace permissions for an account, with caching.
 *
 * The rows are cached; the re-check on person-granted rows is not. When the
 * account has any granted row, every call asks the database which of them
 * still hold (lib/granted-links.ts), so leaving a team or losing a role drops
 * the workspace on the very next call. A row that no longer holds is left out,
 * or, with `includeRevoked`, returned marked `revoked` with no permission (the
 * claim route uses that to keep it out even where open-mode would reach it).
 */
export async function getAccountWorkspacePermissions(
  accountId: string,
  opts: { includeRevoked?: boolean } = {},
): Promise<AccountWorkspacePermission[]> {
  const rows = await loadAccountWorkspacePermissions(accountId);
  if (!rows.some((r) => r.grantedByUserId)) return rows;
  const live = await liveGrantedWorkspaceIds(accountId);
  const out: AccountWorkspacePermission[] = [];
  for (const r of rows) {
    if (!r.grantedByUserId || live.has(r.workspaceId)) out.push(r);
    else if (opts.includeRevoked) out.push({ ...r, canClaim: false, canCreate: false, revoked: true });
  }
  return out;
}

async function loadAccountWorkspacePermissions(accountId: string): Promise<AccountWorkspacePermission[]> {
  const hit = await cachedCaller(`acct-ws:${accountId}`, async () => {
    const rows = await db.query.accountWorkspaces.findMany({
      where: sqlWhere(eq(accountWorkspaces.accountId, accountId)),
    });
    const permissions: AccountWorkspacePermission[] = rows.map((r) => ({
      workspaceId: r.workspaceId,
      canClaim: r.canClaim,
      canCreate: r.canCreate,
      ...(r.grantedByUserId ? { grantedByUserId: r.grantedByUserId } : {}),
    }));
    // Wrapped: an empty list is an answer, not a miss.
    return { permissions };
  }, {
    known: [callerDep.account(accountId), callerDep.accountLinks(accountId)],
    depsOf: (v) => v.permissions.map((p) => callerDep.workspace(p.workspaceId)),
  });
  return hit?.permissions ?? [];
}

/**
 * Invalidate permissions for a specific account, on every instance.
 * Call when account-workspace links are created, updated, or deleted.
 */
export async function invalidateAccountWorkspaceCache(accountId: string): Promise<void> {
  await clearCallerCache(callerDep.accountLinks(accountId));
}

/**
 * Invalidate permissions for all accounts linked to a workspace.
 * Call when a workspace's accessMode changes (since it affects claim routing).
 */
export async function invalidateWorkspacePermissionsCache(workspaceId: string): Promise<void> {
  await clearCallerCache(callerDep.workspace(workspaceId));
}

/**
 * Nothing is held in process any more (every entry lives in Redis and is
 * cleared by the hooks above); kept so tests can still reset between cases.
 */
export function clearAccountWorkspaceCache(): void {}
