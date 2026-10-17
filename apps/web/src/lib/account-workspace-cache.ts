import { db } from '@buildd/core/db';
import { accountWorkspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { TTLCache } from './cache';
import {
  getCachedAccountWorkspaces,
  setCachedAccountWorkspaces,
  invalidateCachedAccountWorkspaces,
} from './redis';
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
 * Cache account → workspace permissions.
 *
 * Keyed by accountId, returns the list of workspace permissions for that account.
 * This is queried on every claim, active workers check, task list, and workspace list.
 *
 * 5-minute TTL — permission changes (linking/unlinking accounts from workspaces)
 * are rare admin actions that can tolerate brief staleness.
 */
const permissionsCache = new TTLCache<AccountWorkspacePermission[]>({
  maxSize: 500,
  ttlMs: 5 * 60 * 1000, // 5 minutes
});

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
  // L1: in-memory TTL cache
  const cached = permissionsCache.get(accountId);
  if (cached) return cached;

  // L2: Redis (survives cold starts across serverless instances)
  const redisPerms = await getCachedAccountWorkspaces<AccountWorkspacePermission[]>(accountId);
  if (redisPerms) {
    permissionsCache.set(accountId, redisPerms);
    return redisPerms;
  }

  // L3: DB
  const rows = await db.query.accountWorkspaces.findMany({
    where: sqlWhere(eq(accountWorkspaces.accountId, accountId)),
  });

  const permissions: AccountWorkspacePermission[] = rows.map((r) => ({
    workspaceId: r.workspaceId,
    canClaim: r.canClaim,
    canCreate: r.canCreate,
    ...(r.grantedByUserId ? { grantedByUserId: r.grantedByUserId } : {}),
  }));

  permissionsCache.set(accountId, permissions);
  await setCachedAccountWorkspaces(accountId, permissions);
  return permissions;
}

/**
 * Invalidate permissions cache for a specific account.
 * Call when account-workspace links are created, updated, or deleted.
 */
export function invalidateAccountWorkspaceCache(accountId: string): void {
  permissionsCache.delete(accountId);
  void invalidateCachedAccountWorkspaces(accountId);
}

/**
 * Invalidate permissions cache for all accounts linked to a workspace.
 * Call when a workspace's accessMode changes (since it affects claim routing).
 */
export function invalidateWorkspacePermissionsCache(workspaceId: string): void {
  permissionsCache.deleteWhere((key) => {
    const perms = permissionsCache.get(key);
    return perms?.some((p) => p.workspaceId === workspaceId) ?? false;
  });
}

/**
 * Clear the entire permissions cache. Mainly for testing.
 */
export function clearAccountWorkspaceCache(): void {
  permissionsCache.clear();
}
