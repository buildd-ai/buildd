import { createHash } from 'crypto';
import { db } from '@buildd/core/db';
import { accounts, users, teamMembers, workspaces, tasks, workers, missions, initiatives, artifacts, releases, specDiscrepancies, watchedProjects, knowledgeIngestJobs } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { canAccessTokenRoute } from './token-route-policy';
import { TTLCache } from './cache';
import * as tokensModule from './oauth/tokens';
import { levelForTeamRole } from './oauth/session-level';
import { findTeamSessionAccount } from './oauth/session-account';
import { grantPrincipal, grantTokenScopes, grantedWorkspace, resolveTokenGrant, type ResolvedGrant } from './mcp-grants';
import { isGrantClaims, type AnyAccessTokenClaims } from './oauth/tokens';
import { cachedCaller, clearCallerCache, callerDep, CALLER_CACHE_MAX_TTL_SEC } from './caller-cache';
import { isTaskToken } from './task-token';
import { isPresenceToken } from './presence-token';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { noteBearerTenant } from './request-tenant';
import { isUuid } from '@/lib/uuid';

/**
 * Negative cache: hashed bld_ keys that matched no account, and JWTs whose
 * signature did not verify. Neither can start to match later (a new key is a
 * new hash), so this is the one refusal kept, and only in process. A JWT
 * refused for any other reason (membership, grant) is never kept here.
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
    where: sqlWhere(eq(accounts.apiKey, hashedKey)),
  });
}

type CachedAccount = NonNullable<Awaited<ReturnType<typeof dbLookupAccount>>>;

/**
 * What a verified OAuth access token grants, cached (lib/caller-cache.ts) for
 * at most 60 s, or until the grant, the user's memberships, a granted
 * workspace, or the set of workspaces in a team the grant covers as a whole
 * changes (each has a clear hook), or the grant expires, whichever comes
 * first. A grant reaching no workspace is a refusal and never cached.
 */
export async function resolveCallerGrant(claims: AnyAccessTokenClaims): Promise<ResolvedGrant | null> {
  const key = isGrantClaims(claims)
    ? `grant:${claims.grant_id}:${claims.sub}:${claims.client_id}`
    : `legacy-grant:${claims.sub}:${claims.workspace_id}:${claims.client_id}`;
  const known = isGrantClaims(claims)
    ? [callerDep.grant(claims.grant_id), callerDep.user(claims.sub)]
    : [callerDep.user(claims.sub), callerDep.workspace(claims.workspace_id)];
  return cachedCaller(key, async () => {
    const grant = await resolveTokenGrant(claims);
    return grant && grant.workspaces.length > 0 ? grant : null;
  }, {
    known,
    depsOf: (g) => [
      ...g.workspaces.map((w) => callerDep.workspace(w.workspaceId)),
      // A workspace created in or moved into a whole-team grant is reached on the next call.
      ...(g.teamIds ?? []).map((t) => callerDep.teamWorkspaces(t)),
    ],
    ttlSec: (g) => (g.expiresAt ? (new Date(g.expiresAt).getTime() - Date.now()) / 1000 : CALLER_CACHE_MAX_TTL_SEC),
  });
}

/**
 * The account a team's OAuth sessions act as (lib/oauth/session-account.ts),
 * cached until that account changes (every account hook clears by its key
 * hash or id). No account is a refusal and never cached, so one provisioned
 * after connecting is found on the next call.
 */
async function cachedTeamSessionAccount(teamId: string): Promise<CachedAccount | null> {
  return cachedCaller(`session-account:${teamId}`, () => findTeamSessionAccount(teamId), {
    known: [callerDep.team(teamId)],
    depsOf: (a) => [callerDep.account(a.id), callerDep.keyHash(a.apiKey)],
    valid: isCurrentShape,
  });
}

/**
 * OAuth JWT path — verify the token, resolve what it grants against CURRENT
 * team membership, and act at the level of the caller's team role.
 *
 * Two token shapes (lib/mcp-grants.ts):
 *  - legacy `workspace_id` claim: an implicit single-workspace 'person' grant;
 *    behaviour unchanged from before grants existed.
 *  - `grant_id` claim: the grant's workspaces ∩ the user's current
 *    memberships (resolveCallerGrant: cached at most 60 s, cleared when the
 *    grant or a membership changes, so a revoked grant or a removed
 *    membership stops authenticating on the next call). The session is confined to those workspaces (`workspaceIds`).
 *    A grant reaching workspaces in more than one team has no single team
 *    account to act as, so with no bound workspace it does not authenticate.
 *    A request that names one (GRANT_WORKSPACE_HEADER: the canonical /api/mcp
 *    transport sends it on every self-call) acts in that workspace's team and
 *    is confined to that one workspace; a workspace outside the grant is no
 *    session at all. The header can only narrow a grant, never widen it, and
 *    is ignored for every other kind of credential.
 *    A read-only grant is a scoped session (grantTokenScopes): read routes
 *    and read actions only.
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
async function authenticateOauthJwt(jwt: string, boundWorkspaceId: string | null = null) {
  const claims = await tokensModule.verifyAccessTokenAnyAudience(jwt);
  if (!claims) {
    negativeCache.set(hashApiKey(jwt), true);
    return null;
  }

  const grant = await resolveCallerGrant(claims);
  if (!grant || grant.workspaces.length === 0) return null;

  // A bound workspace applies to a grant token only; a legacy token keeps its
  // historical reach and ignores it.
  const bound = grant.grantId && boundWorkspaceId ? grantedWorkspace(grant, boundWorkspaceId) : null;
  if (grant.grantId && boundWorkspaceId && !bound) return null;

  const teamIds = new Set(grant.workspaces.map((w) => w.teamId));
  if (!bound && teamIds.size !== 1) return null;
  const { teamId, role } = bound ?? grant.workspaces[0];

  // Deterministic: the same token must act as the same account on every
  // request, or a session is refused on the workers it claimed.
  const account = await cachedTeamSessionAccount(teamId);
  if (!account) return null;

  const principal = grantPrincipal(grant);
  return {
    ...account,
    // A read-only grant reads only; legacy tokens and write grants keep the
    // user's role-level permissions.
    scopes: grant.grantId ? grantTokenScopes(grant.scopes) : null,
    // Legacy tokens keep their historical team-wide reach; a grant token is
    // confined to exactly the workspaces it currently reaches, or to the one
    // workspace the request is bound to.
    workspaceIds: bound ? [bound.workspaceId] : grant.grantId ? grant.workspaces.map((w) => w.workspaceId) : null,
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
 *  - OAuth JWT (looks like `eyJ...`): verify signature, then what it grants and
 *    the team account it acts as (resolveCallerGrant, cachedTeamSessionAccount);
 *    level from the caller's team role. The MCP-OAuth route additionally
 *    enforces workspace.
 *  - Regular `bld_*` key: hash + DB lookup.
 *
 * Both are cached in Redis for at most 60 s (lib/caller-cache.ts) and cleared
 * by invalidateAccountCache / invalidateAccountCacheByHash and the membership
 * and grant hooks.
 */
async function resolveApiKey(apiKey: string | null, boundWorkspaceId: string | null = null) {
  if (!apiKey) return null;

  // A per-task token is never an account key. Only the routes that opt in
  // through lib/task-token-auth.ts accept one, confined to its own task.
  if (isTaskToken(apiKey)) return null;
  // Nor is a person's presence token: only the presence routes accept one
  // (lib/presence-token.ts).
  if (isPresenceToken(apiKey)) return null;

  const hashed = hashApiKey(apiKey);
  if (negativeCache.get(hashed)) return null;

  // OAuth bearer path — verify the JWT before any DB work. What it grants
  // and the account it acts as are cached; the token itself is verified on
  // every call.
  if (tokensModule.looksLikeJwt(apiKey)) return authenticateOauthJwt(apiKey, boundWorkspaceId);

  const account = await cachedCaller(`key:${hashed}`, () => dbLookupAccount(hashed), {
    known: [callerDep.keyHash(hashed)],
    depsOf: (a) => [callerDep.account(a.id)],
    valid: isCurrentShape,
    localWithoutRedis: true,
  });
  if (!account) negativeCache.set(hashed, true);
  return account;
}

/**
 * An account changed: its key, level, scopes, workspace list, flags, links,
 * or it was deleted. Every cached caller resting on it (its key, a task
 * token it minted, an OAuth session acting as it) is re-read on the next
 * call, on every instance. Await it after the write that changed the row.
 */
export async function invalidateAccountCache(accountId: string): Promise<void> {
  await clearCallerCache(callerDep.account(accountId));
}

/**
 * As invalidateAccountCache, by the account's stored key hash: what most
 * account routes have at hand. Call after the write.
 */
export async function invalidateAccountCacheByHash(hashedKey: string): Promise<void> {
  negativeCache.delete(hashedKey);
  await clearCallerCache(callerDep.keyHash(hashedKey));
}

/** Clear the in-process negative cache. Mainly for testing. */
export function clearAccountCache(): void {
  negativeCache.clear();
}

/**
 * Names the one workspace a grant-token request acts in (see
 * authenticateOauthJwt). Read only from a real Request; meaningless for any
 * credential but a grant token.
 */
export const GRANT_WORKSPACE_HEADER = 'x-buildd-workspace';

function boundWorkspaceOf(request: { url: string; method: string } | undefined): string | null {
  const headers = (request as { headers?: unknown } | undefined)?.headers;
  if (!headers || typeof (headers as Headers).get !== 'function') return null;
  const v = (headers as Headers).get(GRANT_WORKSPACE_HEADER);
  return v && isUuid(v.trim()) ? v.trim().toLowerCase() : v ? 'invalid' : null;
}

/**
 * The session a grant token acts as in one named workspace: that workspace's
 * team account, at the user's role there, confined to that workspace. Null
 * when the token is not a grant token or the workspace is outside the grant.
 */
export async function authenticateGrantSession(jwt: string, workspaceId: string) {
  if (!tokensModule.looksLikeGrantToken(jwt)) return null;
  return authenticateOauthJwt(jwt, workspaceId);
}

/** Capability and expiry checks also apply to cached accounts. */
export async function authenticateApiKey(apiKey: string | null, request?: { url: string; method: string }) {
  const account = await resolveApiKey(apiKey, boundWorkspaceOf(request));
  if (!account) return null;
  if (account.expiresAt && new Date(account.expiresAt).getTime() <= Date.now()) return null;
  if (account.scopes != null && !request) return null;
  if (request && !canAccessTokenRoute(account, request)) return null;
  if (account.workspaceIds != null && request) {
    const match = /^\/api\/(tasks|workers|missions|initiatives|artifacts|releases|discrepancies|watched-projects|knowledge\/ingest-jobs)\/([0-9a-f-]{36})(?:\/|$)/i.exec(new URL(request.url).pathname);
    if (match) {
      const id = match[2];
      const lookups: Record<string, () => Promise<{workspaceId: string | null} | undefined>> = {
        'knowledge/ingest-jobs': () => db.query.knowledgeIngestJobs.findFirst({where:sqlWhere(eq(knowledgeIngestJobs.id,id)),columns:{workspaceId:true}}),
        tasks: () => db.query.tasks.findFirst({where:sqlWhere(eq(tasks.id,id)),columns:{workspaceId:true}}),
        workers: () => db.query.workers.findFirst({where:sqlWhere(eq(workers.id,id)),columns:{workspaceId:true}}),
        missions: () => db.query.missions.findFirst({where:sqlWhere(eq(missions.id,id)),columns:{workspaceId:true}}),
        initiatives: () => db.query.initiatives.findFirst({where:sqlWhere(eq(initiatives.id,id)),columns:{workspaceId:true}}),
        artifacts: () => db.query.artifacts.findFirst({where:sqlWhere(eq(artifacts.id,id)),columns:{workspaceId:true}}),
        releases: () => db.query.releases.findFirst({where:sqlWhere(eq(releases.id,id)),columns:{workspaceId:true}}),
        discrepancies: () => db.query.specDiscrepancies.findFirst({where:sqlWhere(eq(specDiscrepancies.id,id)),columns:{workspaceId:true}}),
        'watched-projects': () => db.query.watchedProjects.findFirst({where:sqlWhere(eq(watchedProjects.id,id)),columns:{workspaceId:true}}),
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
  // Team and plan on the request's spans, and the plan for the read limiter (proxy.ts).
  await noteBearerTenant(apiKey, account.teamId);
  return account;
}
const lastUseWrites = new TTLCache<true>({ maxSize: 500, ttlMs: 60_000 });
