import { Redis } from '@upstash/redis';

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

// ── Cron due-queues ─────────────────────────────────────────────────────────
//
// key: buildd:due:{job} — a sorted set whose score is the epoch-ms at which a
// row becomes actionable. Written by whatever code path already knows the due
// time (it is inside a DB write anyway), read by the matching cron so a tick
// with nothing due can return without touching Postgres — which is the whole
// point: Neon autosuspends on idle, so an ungated sub-hourly cron bills idle
// compute all day just to ask "anything to do?".
//
// `countDue` returns null — NOT 0 — when Redis is unavailable or erroring, so
// callers can tell "nothing is due" apart from "I could not ask" and fail open
// on the second. Treating them alike is how a monitoring job silently stops
// monitoring while its logs stay green.

const dueKey = (job: string) => `buildd:due:${job}`;

/** True when a client is configured; false means every due-queue op no-ops. */
export function isRedisConfigured(): boolean {
  return redis !== null;
}

/** Upsert one member's due time (ZADD). Called from paths that already write the DB. */
export async function markDue(job: string, member: string, dueAtMs: number): Promise<void> {
  await safe('zadd due', r => r.zadd(dueKey(job), { score: dueAtMs, member }), undefined);
}

/** Drop members that no longer have pending work (ZREM). */
export async function clearDue(job: string, members: string | string[]): Promise<void> {
  const list = Array.isArray(members) ? members : [members];
  if (list.length === 0) return;
  await safe('zrem due', r => r.zrem(dueKey(job), ...list), undefined);
}

/** How many members are due at or before `nowMs`. `null` = Redis unavailable. */
export async function countDue(job: string, nowMs: number = Date.now()): Promise<number | null> {
  return safe<number | null>('zcount due', r => r.zcount(dueKey(job), '-inf', nowMs), null);
}

/**
 * Members due at or before `nowMs`, oldest first, at most `limit`. `[]` when
 * nothing is due or Redis cannot answer — callers that must tell those apart
 * ask `countDue` first (the gate does), and the floor tick re-seeds the set.
 */
export async function listDue(job: string, nowMs: number, limit: number): Promise<string[]> {
  return safe<string[]>(
    'zrange due',
    async r => (await r.zrange<string[]>(dueKey(job), '-inf', nowMs, { byScore: true, offset: 0, count: limit })).map(String),
    [],
  );
}

/**
 * Replace the whole set with `entries` — the self-healing half of the pattern.
 *
 * A dropped ZADD would otherwise hide work forever. Runs only on ticks that
 * already read the DB (the unconditional floor tick), so it costs no extra
 * wake, and it bounds a lost write to one floor interval.
 */
export async function reseedDue(
  job: string,
  entries: Array<{ member: string; dueAtMs: number }>,
): Promise<void> {
  await safe('reseed due', async r => {
    const key = dueKey(job);
    await r.del(key);
    // Destructured rather than spread so the first element types as required —
    // zadd's signature demands at least one score/member pair.
    const [first, ...rest] = entries.map(e => ({ score: e.dueAtMs, member: e.member }));
    if (first) await r.zadd(key, first, ...rest);
  }, undefined);
}

/** Drop every member due at or before `nowMs` (ZREMRANGEBYSCORE). */
export async function clearDueThrough(job: string, nowMs: number): Promise<void> {
  await safe('zremrangebyscore due', r => r.zremrangebyscore(dueKey(job), '-inf', nowMs), undefined);
}

// ── Short-TTL facts (presence, once-per-window flags) ──────────────────────
//
// A read returns `undefined` for "could not ask" (no client, or an error), which
// callers must keep apart from `null` ("asked, no key"). Presence reads both as
// away; see lib/presence.ts.

export async function setWithTtl<T>(key: string, value: T, ttlSec: number): Promise<boolean> {
  return safe('setex ttl', async r => { await r.setex(key, ttlSec, value); return true; }, false);
}

export async function getKey<T>(key: string): Promise<T | null | undefined> {
  return safe<T | null | undefined>('get key', r => r.get<T>(key), undefined);
}

export async function delKey(key: string): Promise<void> {
  await safe('del key', r => r.del(key), undefined);
}

/** SET NX EX: true only for the first caller in the window; false when Redis is unavailable. */
export async function setOnce(key: string, ttlSec: number): Promise<boolean> {
  return safe('set nx', async r => (await r.set(key, 1, { nx: true, ex: ttlSec })) === 'OK', false);
}

/**
 * SET NX EX as a lock: true = acquired, false = someone holds it, null = could
 * not ask (no Redis). Callers decide whether null means proceed.
 */
export async function tryLock(key: string, ttlSec: number): Promise<boolean | null> {
  return safe<boolean | null>('lock', async r => (await r.set(key, 1, { nx: true, ex: ttlSec })) === 'OK', null);
}

// Presence: one sorted set per person, one member per open tab, scored by the
// tab's expiry. A member lives until its score passes; the key itself expires
// with the last beat, so an abandoned set cleans itself up.

/** Upsert one tab's expiry, prune lapsed tabs, refresh the key TTL. */
export async function presenceAdd(key: string, member: string, expiresAtMs: number, ttlSec: number, nowMs: number): Promise<boolean> {
  return safe('presence add', async r => {
    await r.zadd(key, { score: expiresAtMs, member });
    await r.zremrangebyscore(key, '-inf', nowMs);
    await r.expire(key, ttlSec);
    return true;
  }, false);
}

export async function presenceRemove(key: string, member: string): Promise<void> {
  await safe('presence remove', r => r.zrem(key, member), undefined);
}

/** Tabs whose expiry is still in the future. `undefined` = could not ask. */
export async function presenceLive(key: string, nowMs: number): Promise<string[] | undefined> {
  return safe<string[] | undefined>('presence live', r => r.zrange<string[]>(key, `(${nowMs}`, '+inf', { byScore: true }), undefined);
}

// Distinct-member windows: one sorted set per subject, one member per distinct
// thing seen, scored by when it falls out of the window. Same shape as
// presence; used to count "how many different X did this caller touch lately".

/**
 * Add members to a window, prune lapsed ones and return how many distinct
 * members are live. `null` = could not ask (no Redis, or an error).
 */
export async function windowMembersAdd(
  key: string,
  members: readonly string[],
  expiresAtMs: number,
  ttlSec: number,
  nowMs: number,
): Promise<number | null> {
  if (members.length === 0) return safe<number | null>('window count', r => r.zcount(key, `(${nowMs}`, '+inf'), null);
  return safe<number | null>('window add', async r => {
    const [first, ...rest] = members.map(member => ({ score: expiresAtMs, member }));
    await r.zadd(key, first, ...rest);
    await r.zremrangebyscore(key, '-inf', nowMs);
    await r.expire(key, ttlSec);
    return r.zcard(key);
  }, null);
}
