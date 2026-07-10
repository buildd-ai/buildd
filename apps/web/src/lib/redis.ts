import { Redis } from '@upstash/redis';

// Cache open workspace IDs for 5 minutes
const CACHE_KEY = 'buildd:open_workspaces';
const CACHE_TTL = 5 * 60; // 5 minutes in seconds

/**
 * Resolve Upstash/Vercel-KV connection config from an env-like object.
 *
 * Precedence mirrors historical behavior: Vercel KV var names win over the
 * Upstash-native names. Exported (and pure) so the resolution — including the
 * host we'll actually connect to — is unit-testable without a live client.
 *
 * `status`:
 *   - 'ok'      → both url and token present
 *   - 'partial' → exactly one present (a silent-no-op footgun: e.g. KV url set
 *                 but its token stored under the wrong name, so it pairs with a
 *                 different DB's token — the exact bug that let the DB go idle)
 *   - 'none'    → neither present; caching intentionally disabled
 */
export function resolveRedisConfig(env: Record<string, string | undefined>): {
  url?: string;
  token?: string;
  host: string | null;
  status: 'ok' | 'partial' | 'none';
} {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  const host = url ? parseHost(url) : null;
  if (url && token) return { url, token, host, status: 'ok' };
  if (url || token) return { url, token, host, status: 'partial' };
  return { host: null, status: 'none' };
}

function parseHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Upstash Redis client (optional - gracefully degrades if not configured)
let redis: Redis | null = null;

const config = resolveRedisConfig(process.env);
if (config.status === 'ok') {
  redis = new Redis({ url: config.url!, token: config.token! });
  console.log(`[Redis] Configured → ${config.host}`);
} else if (config.status === 'partial') {
  // Don't construct a client from a half-configured pair — it connects but
  // every op auth-fails, which the old code swallowed silently.
  console.warn(
    `[Redis] Partial config (${config.url ? 'URL' : 'token'} present, other missing) — caching DISABLED. ` +
      `Check that URL and token come from the same DB and use matching var names ` +
      `(KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN).`,
  );
} else {
  console.log('[Redis] Not configured - caching disabled');
}

// Warn once (not per-op) when a configured client keeps failing at runtime —
// e.g. crossed URL/token from different DBs, or a disabled DB. Surfaces the
// misconfiguration instead of silently no-op'ing forever.
let failureWarned = false;
function noteFailure(op: string, err: unknown): void {
  if (failureWarned) return;
  failureWarned = true;
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(
    `[Redis] Operation "${op}" failed against ${config.host ?? 'configured DB'} — caching is now effectively disabled. ` +
      `Verify the URL/token belong to the same, active DB. First error: ${msg}`,
  );
}

/** Run a Redis op, degrading to `fallback` on any failure (surfaced once via noteFailure). */
async function safe<T>(op: string, fn: (r: Redis) => Promise<T>, fallback: T): Promise<T> {
  if (!redis) return fallback;
  try {
    return await fn(redis);
  } catch (err) {
    noteFailure(op, err);
    return fallback;
  }
}

export async function getCachedOpenWorkspaceIds(): Promise<string[] | null> {
  return safe('get open_workspaces', r => r.get<string[]>(CACHE_KEY), null);
}

export async function setCachedOpenWorkspaceIds(ids: string[]): Promise<void> {
  await safe('set open_workspaces', r => r.setex(CACHE_KEY, CACHE_TTL, ids), undefined);
}

export async function invalidateOpenWorkspacesCache(): Promise<void> {
  await safe('del open_workspaces', r => r.del(CACHE_KEY), undefined);
}

// API key cache — key: buildd:api_key:{hash}, 5-min TTL
const API_KEY_TTL = 5 * 60;

export async function getCachedApiKey<T>(hash: string): Promise<T | null> {
  return safe('get api_key', r => r.get<T>(`buildd:api_key:${hash}`), null);
}

export async function setCachedApiKey<T>(hash: string, account: T, ttlSec = API_KEY_TTL): Promise<void> {
  await safe('set api_key', r => r.setex(`buildd:api_key:${hash}`, ttlSec, account), undefined);
}

export async function invalidateCachedApiKey(hash: string): Promise<void> {
  await safe('del api_key', r => r.del(`buildd:api_key:${hash}`), undefined);
}

// Account-workspace permissions cache — key: buildd:acct_ws:{accountId}, 5-min TTL
const ACCT_WS_TTL = 5 * 60;

export async function getCachedAccountWorkspaces<T>(accountId: string): Promise<T | null> {
  return safe('get acct_ws', r => r.get<T>(`buildd:acct_ws:${accountId}`), null);
}

export async function setCachedAccountWorkspaces<T>(accountId: string, perms: T, ttlSec = ACCT_WS_TTL): Promise<void> {
  await safe('set acct_ws', r => r.setex(`buildd:acct_ws:${accountId}`, ttlSec, perms), undefined);
}

export async function invalidateCachedAccountWorkspaces(accountId: string): Promise<void> {
  await safe('del acct_ws', r => r.del(`buildd:acct_ws:${accountId}`), undefined);
}
