import { createHash } from 'crypto';
import { db } from '@buildd/core/db';
import { accounts, users, teamMembers, workspaces } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { TTLCache } from './cache';
import * as tokensModule from './oauth/tokens';
import { getCachedApiKey, setCachedApiKey, invalidateCachedApiKey } from './redis';

/**
 * Cache API key hash → account record.
 *
 * API keys are immutable after creation (only regeneration replaces them),
 * so a 5-minute TTL gives a good balance between DB savings and freshness.
 *
 * Max 500 entries covers all active accounts with room to spare.
 * Each entry is ~1-2 KB (account record), so worst case ~1 MB memory.
 */
const accountCache = new TTLCache<NonNullable<Awaited<ReturnType<typeof dbLookupAccount>>>>({
  maxSize: 500,
  ttlMs: 5 * 60 * 1000, // 5 minutes
});

/**
 * Negative cache: track hashed keys that returned no result.
 * Prevents repeated DB lookups for invalid keys (e.g., scanners, typos).
 * Shorter TTL (1 min) so newly created keys are found quickly.
 */
const negativeCache = new TTLCache<true>({
  maxSize: 1000,
  ttlMs: 60 * 1000, // 1 minute
});

/**
 * SHA-256 hash of an API key (hex encoded).
 * Used to store hashed keys in the DB instead of plaintext.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Extract the display prefix from a plaintext key (first 12 chars).
 * e.g. "bld_abc12345..." -> "bld_abc12345"
 */
export function extractApiKeyPrefix(key: string): string {
  return key.substring(0, 12);
}

/** Raw DB lookup, separated for testability and cache-miss path. */
async function dbLookupAccount(hashedKey: string) {
  return db.query.accounts.findFirst({
    where: eq(accounts.apiKey, hashedKey),
  });
}

type CachedAccount = NonNullable<Awaited<ReturnType<typeof dbLookupAccount>>>;

/**
 * OAuth JWT path — verify, resolve to the user's primary account, override
 * the level to 'admin' since the token represents a real human authorising
 * claude.ai (or any MCP client) against their own resources.
 *
 * Cached by the JWT itself (full token string) so we don't re-verify on every
 * call within the 5-minute TTL. Tokens have a 1-hour lifetime so the cache
 * never outlives the token.
 */
async function authenticateOauthJwt(jwt: string) {
  const claims = await tokensModule.verifyAccessTokenAnyAudience(jwt);
  if (!claims) return null;

  const userId = claims.sub;

  // The JWT is scoped to a specific workspace. Use that workspace's team
  // rather than the user's first team membership, which is wrong for
  // multi-team users (the first membership may not match the requested workspace).
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, claims.workspace_id),
    columns: { teamId: true },
  });
  if (!workspace) return null;

  // Verify the requesting user still has membership in the workspace's team.
  const membership = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, workspace.teamId), eq(teamMembers.userId, userId)),
    columns: { teamId: true },
  });
  if (!membership) return null;

  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.teamId, workspace.teamId), eq(accounts.type, 'user')),
  });
  if (!account) return null;

  // Force admin level for OAuth-authenticated humans.
  return { ...account, level: 'admin' as const };
}

/**
 * Authenticate an incoming API key by hashing it and looking up the hash.
 * Returns the account if found, null otherwise.
 *
 * Two paths:
 *  - OAuth JWT (looks like `eyJ...`): verify signature, resolve user → account,
 *    force admin level. The MCP-OAuth route additionally enforces workspace.
 *  - Regular `bld_*` key: hash + DB lookup (cached).
 *
 * Uses an in-memory TTL cache to avoid hitting the DB on every request.
 * Cache is invalidated on key regeneration and account deletion.
 */
export async function authenticateApiKey(apiKey: string | null) {
  if (!apiKey) return null;

  // OAuth bearer path — verify the JWT before any DB work.
  if (tokensModule.looksLikeJwt(apiKey)) {
    const hashed = hashApiKey(apiKey);
    if (negativeCache.get(hashed)) return null;
    const cached = accountCache.get(hashed);
    if (cached) return cached;

    // L1 miss — check Redis (L2) before expensive JWT verify + DB round-trips
    const redisAccount = await getCachedApiKey<CachedAccount>(hashed);
    if (redisAccount) {
      accountCache.set(hashed, redisAccount);
      return redisAccount;
    }

    const account = await authenticateOauthJwt(apiKey);
    if (account) {
      accountCache.set(hashed, account);
      await setCachedApiKey(hashed, account);
    } else {
      negativeCache.set(hashed, true);
    }
    return account;
  }

  const hashed = hashApiKey(apiKey);

  // Check negative cache first (invalid keys)
  if (negativeCache.get(hashed)) {
    return null;
  }

  // Check positive cache (L1)
  const cached = accountCache.get(hashed);
  if (cached) {
    return cached;
  }

  // L1 miss — check Redis (L2) before hitting the DB
  const redisAccount = await getCachedApiKey<CachedAccount>(hashed);
  if (redisAccount) {
    accountCache.set(hashed, redisAccount);
    return redisAccount;
  }

  // L2 miss — query DB
  const account = await dbLookupAccount(hashed);

  if (account) {
    accountCache.set(hashed, account);
    await setCachedApiKey(hashed, account);
  } else {
    negativeCache.set(hashed, true);
  }

  return account || null;
}

/**
 * Invalidate the auth cache for a specific account.
 * Call this when:
 * - An API key is regenerated (old hash removed, new hash not yet cached)
 * - An account is deleted
 * - Account fields used in auth decisions change (e.g., maxConcurrentWorkers, level)
 */
export function invalidateAccountCache(accountId: string): void {
  // We can't look up by account ID directly since the cache is keyed by hashed API key.
  // Delete all entries where the cached account matches the given ID.
  accountCache.deleteWhere((key) => {
    const entry = accountCache.get(key);
    return entry?.id === accountId;
  });
}

/**
 * Invalidate auth cache by hashed API key.
 * Use this when you know the old hashed key (e.g., during key regeneration).
 */
export function invalidateAccountCacheByHash(hashedKey: string): void {
  accountCache.delete(hashedKey);
  negativeCache.delete(hashedKey);
  void invalidateCachedApiKey(hashedKey);
}

/**
 * Clear the entire auth cache. Use sparingly — mainly for testing.
 */
export function clearAccountCache(): void {
  accountCache.clear();
  negativeCache.clear();
}
