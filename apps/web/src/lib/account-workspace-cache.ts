import { db } from '@buildd/core/db';
import { accountWorkspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { TTLCache } from './cache';
import {
  getCachedAccountWorkspaces,
  setCachedAccountWorkspaces,
  invalidateCachedAccountWorkspaces,
} from './redis';

/**
 * Cached account workspace permission entry.
 */
export interface AccountWorkspacePermission {
  workspaceId: string;
  canClaim: boolean;
  canCreate: boolean;
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
 */
export async function getAccountWorkspacePermissions(
  accountId: string,
): Promise<AccountWorkspacePermission[]> {
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
    where: eq(accountWorkspaces.accountId, accountId),
  });

  const permissions: AccountWorkspacePermission[] = rows.map((r) => ({
    workspaceId: r.workspaceId,
    canClaim: r.canClaim,
    canCreate: r.canCreate,
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
