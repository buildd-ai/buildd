import { createHash } from 'crypto';
import { db } from '@buildd/core/db';
import { accounts, users, teamMembers, workspaces, tasks, workers, missions, initiatives, artifacts, releases, specDiscrepancies, watchedProjects, knowledgeIngestJobs } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { canAccessTokenRoute } from './token-route-policy';
import { TTLCache } from './cache';
import * as tokensModule from './oauth/tokens';
import { levelForTeamRole } from './oauth/session-level';
import { findTeamSessionAccount } from './oauth/session-account';
import { grantPrincipal, resolveTokenGrant } from './mcp-grants';
import { getCachedApiKey, setCachedApiKey, invalidateCachedApiKey } from './redis';
import { isTaskToken } from './task-token';
import { isPresenceToken } from './presence-token';

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
 * OAuth session cache TTLs. A session's level follows the caller's current
 * team role, and a removed member must stop authenticating, so these entries
 * are kept short: 30s in-process (L1) plus 30s in Redis (L2). An L1 refill
 * from L2 can stack the two, so a role change or membership removal takes
 * effect within 60s. (bld_ API keys keep the 5-minute accountCache above.)
 */
const OAUTH_L1_TTL_MS = 30 * 1000;
const OAUTH_L2_TTL_SEC = 30;

const oauthAccountCache = new TTLCache<CachedAccount>({
  maxSize: 500,
  ttlMs: OAUTH_L1_TTL_MS,
});

/**
 * OAuth JWT path — verify the token, resolve what it grants against CURRENT
 * team membership, and act at the level of the caller's team role.
 *
 * Two token shapes (lib/mcp-grants.ts):
 *  - legacy `workspace_id` claim: an implicit single-workspace 'person' grant;
 *    behaviour unchanged from before grants existed.
 *  - `grant_id` claim: the grant's workspaces ∩ the user's current
 *    memberships, resolved on every request (never cached, see resolveApiKey),
 *    so a revoked grant or a removed membership stops authenticating on the
 *    next call. The session is confined to those workspaces (`workspaceIds`).
 *    A grant reaching workspaces in more than one team has no single team
 *    account to act as here and does not authenticate on this path; a
 *    workspace-bound transport resolves it per workspace instead.
 *
 * Account resolution: the `accounts` table has no column linking an account
 * to an individual user (no userId/ownerId/createdBy), so a session resolves
 * to one of its team's `type='user'` accounts, picked deterministically
 * (lib/oauth/session-account.ts). The level, which gates actions, comes from
 * the caller's own membership row; the person, which gates acting as a
 * claimed worker and every person-only action, is sessionUserId
 * (lib/worker-owner.ts, lib/request-person.ts). An 'agent' grant carries no
 * sessionUserId: it is attributed to the user (`oauthUserId`) but is never a
 * person.
 */
async function authenticateOauthJwt(jwt: string) {
  const claims = await tokensModule.verifyAccessTokenAnyAudience(jwt);
  if (!claims) return null;

  const grant = await resolveTokenGrant(claims);
  if (!grant || grant.workspaces.length === 0) return null;

  const teamIds = new Set(grant.workspaces.map((w) => w.teamId));
  if (teamIds.size !== 1) return null;
  const { teamId, role } = grant.workspaces[0];

  // Deterministic: the same token must act as the same account on every
  // request, or a session is refused on the workers it claimed.
  const account = await findTeamSessionAccount(teamId);
  if (!account) return null;

  const principal = grantPrincipal(grant);
  return {
    ...account,
    scopes: null,
    // Legacy tokens keep their historical team-wide reach; a grant token is
    // confined to exactly the workspaces it currently reaches.
    workspaceIds: grant.grantId ? grant.workspaces.map((w) => w.workspaceId) : null,
    expiresAt: null,
    level: levelForTeamRole(role),
    // The person behind this session; absent on an 'agent' grant. The account
    // is shared by the whole team, so this is the only per-person identity a
    // request carries.
    ...(principal.sessionUserId ? { sessionUserId: principal.sessionUserId } : {}),
    oauthUserId: principal.oauthUserId,
    actsAs: principal.actsAs,
    oauthGrantId: grant.grantId,
    grantScopes: grant.scopes,
  };
}

/**
 * A cached account record written before a column that auth decisions read
 * existed lacks that field, and reading it as "absent" would refuse a runner
 * the DB now allows (credential custody reads `hostRunner`, the claim's
 * entitlement gate reads `managedRunner`). Such a record is
 * treated as a miss and re-fetched.
 */
function isCurrentShape(account: CachedAccount): boolean {
  const a = account as { hostRunner?: unknown; managedRunner?: unknown };
  // managedRunner: a managed key read from a stale record would skip its plan's limits.
  return typeof a.hostRunner === 'boolean' && typeof a.managedRunner === 'boolean';
}

/**
 * Authenticate an incoming API key by hashing it and looking up the hash.
 * Returns the account if found, null otherwise.
 *
 * Two paths:
 *  - OAuth JWT (looks like `eyJ...`): verify signature, check team membership,
 *    level from the caller's team role (short-lived cache, see OAUTH_L1_TTL_MS).
 *    The MCP-OAuth route additionally enforces workspace.
 *  - Regular `bld_*` key: hash + DB lookup (cached).
 *
 * Uses an in-memory TTL cache to avoid hitting the DB on every request.
 * Cache is invalidated on key regeneration and account deletion.
 */
async function resolveApiKey(apiKey: string | null) {
  if (!apiKey) return null;

  // A per-task token is never an account key. Only the routes that opt in
  // through lib/task-token-auth.ts accept one, confined to its own task.
  if (isTaskToken(apiKey)) return null;
  // Nor is a person's presence token: only the presence routes accept one
  // (lib/presence-token.ts).
  if (isPresenceToken(apiKey)) return null;

  // OAuth bearer path — verify the JWT before any DB work.
  if (tokensModule.looksLikeJwt(apiKey)) {
    const hashed = hashApiKey(apiKey);
    if (negativeCache.get(hashed)) return null;

    // A grant token is resolved on every request, never from a cache, so a
    // revoked grant or a removed membership takes effect on the next call.
    if (tokensModule.looksLikeGrantToken(apiKey)) return authenticateOauthJwt(apiKey);

    const cached = oauthAccountCache.get(hashed);
    if (cached) return cached;

    // L1 miss — check Redis (L2) before expensive JWT verify + DB round-trips
    const redisAccount = await getCachedApiKey<CachedAccount>(hashed);
    if (redisAccount) {
      oauthAccountCache.set(hashed, redisAccount);
      return redisAccount;
    }

    const account = await authenticateOauthJwt(apiKey);
    if (account) {
      oauthAccountCache.set(hashed, account);
      await setCachedApiKey(hashed, account, OAUTH_L2_TTL_SEC);
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
  if (cached && isCurrentShape(cached)) {
    return cached;
  }

  // L1 miss — check Redis (L2) before hitting the DB
  const redisAccount = await getCachedApiKey<CachedAccount>(hashed);
  if (redisAccount && isCurrentShape(redisAccount)) {
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
  oauthAccountCache.deleteWhere((key) => {
    const entry = oauthAccountCache.get(key);
    return entry?.id === accountId;
  });
}

/**
 * Invalidate auth cache by hashed API key.
 * Use this when you know the old hashed key (e.g., during key regeneration).
 */
export function invalidateAccountCacheByHash(hashedKey: string): void {
  accountCache.delete(hashedKey);
  oauthAccountCache.delete(hashedKey);
  negativeCache.delete(hashedKey);
  void invalidateCachedApiKey(hashedKey);
}

/**
 * Clear the entire auth cache. Use sparingly — mainly for testing.
 */
export function clearAccountCache(): void {
  accountCache.clear();
  oauthAccountCache.clear();
  negativeCache.clear();
}

/** Capability and expiry checks also apply to cached accounts. */
export async function authenticateApiKey(apiKey: string | null, request?: { url: string; method: string }) {
  const account = await resolveApiKey(apiKey);
  if (!account) return null;
  if (account.expiresAt && new Date(account.expiresAt).getTime() <= Date.now()) return null;
  if (account.scopes != null && !request) return null;
  if (request && !canAccessTokenRoute(account, request)) return null;
  if (account.workspaceIds != null && request) {
    const match = /^\/api\/(tasks|workers|missions|initiatives|artifacts|releases|discrepancies|watched-projects|knowledge\/ingest-jobs)\/([0-9a-f-]{36})(?:\/|$)/i.exec(new URL(request.url).pathname);
    if (match) {
      const id = match[2];
      const lookups: Record<string, () => Promise<{workspaceId: string | null} | undefined>> = {
        'knowledge/ingest-jobs': () => db.query.knowledgeIngestJobs.findFirst({where:eq(knowledgeIngestJobs.id,id),columns:{workspaceId:true}}),
        tasks: () => db.query.tasks.findFirst({where:eq(tasks.id,id),columns:{workspaceId:true}}),
        workers: () => db.query.workers.findFirst({where:eq(workers.id,id),columns:{workspaceId:true}}),
        missions: () => db.query.missions.findFirst({where:eq(missions.id,id),columns:{workspaceId:true}}),
        initiatives: () => db.query.initiatives.findFirst({where:eq(initiatives.id,id),columns:{workspaceId:true}}),
        artifacts: () => db.query.artifacts.findFirst({where:eq(artifacts.id,id),columns:{workspaceId:true}}),
        releases: () => db.query.releases.findFirst({where:eq(releases.id,id),columns:{workspaceId:true}}),
        discrepancies: () => db.query.specDiscrepancies.findFirst({where:eq(specDiscrepancies.id,id),columns:{workspaceId:true}}),
        'watched-projects': () => db.query.watchedProjects.findFirst({where:eq(watchedProjects.id,id),columns:{workspaceId:true}}),
      };
      const resource = await lookups[match[1]]();
      if (!resource?.workspaceId || !account.workspaceIds.includes(resource.workspaceId)) return null;
    }
  }
  if (account.workspaceIds != null && request && 'clone' in request && !['GET', 'HEAD'].includes(request.method)) {
    try {
      const body = await (request as Request).clone().json();
      // Creates that default to team-wide scope must name one of the token's workspaces.
      if (['/api/releases/trigger', '/api/missions', '/api/initiatives'].includes(new URL(request.url).pathname) && !body.workspaceId) return null;
      if (body.workspaceId && !account.workspaceIds.includes(body.workspaceId)) return null;
      if (Array.isArray(body.workspaceIds) && body.workspaceIds.some((id: string) => !account.workspaceIds!.includes(id))) return null;
    } catch { /* Non-JSON calls still use route resource checks. */ }
  }
  if (!lastUseWrites.get(account.id)) {
    lastUseWrites.set(account.id, true);
    try { await db.update(accounts).set({ lastUsedAt: new Date() }).where(eq(accounts.id, account.id)); } catch { /* Telemetry is best effort. */ }
  }
  return account;
}
const lastUseWrites = new TTLCache<true>({ maxSize: 500, ttlMs: 60_000 });
