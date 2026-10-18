/**
 * Per-caller rate limit on read APIs (GET/HEAD under /api), enforced in
 * proxy.ts before a route runs, so a refused call costs one Redis round trip
 * and no database work.
 *
 * Why: nothing else stops a client from polling read APIs as fast as it likes,
 * and every call reads Postgres and keeps compute awake.
 *
 * - One token bucket per caller per class, in Upstash: per API key (any
 *   bearer, hashed) or per user for a browser session.
 * - Two classes: `poll` (list and polling endpoints, POLL_ROUTES) and `read`
 *   (every other counted GET). Each has its own bucket.
 * - The free plan gets READ_RATE_DEFAULTS; paid plans get `paidMultiplier`
 *   times that. Bursts up to `burstMultiplier` times the per-minute rate.
 * - The plan comes from Redis (`buildd:rl:plan:<subject>`), written by the
 *   server when it authenticates the caller (lib/request-tenant.ts). A caller
 *   whose plan is not known yet gets the paid numbers: unknown fails open.
 * - Runner coordination is exempt (claim, queue, heartbeat, a worker's own
 *   routes): runner capacity already bounds it, and limiting it stalls work.
 * - Redis down, unconfigured, or throwing: allowed.
 *
 * The bucket is GCRA (a token bucket kept as one timestamp, the "theoretical
 * arrival time"): `decideBucket` is the reference, and BUCKET_SCRIPT is the
 * same arithmetic run atomically in Redis.
 */
import { createHash } from 'crypto';
import type { TeamPlan } from '@buildd/shared';

export type ReadClass = 'read' | 'poll';

export interface ReadRateConfig {
  freeReadPerMin: number;
  freePollPerMin: number;
  paidMultiplier: number;
  burstMultiplier: number;
  enabled: boolean;
}

/** Public defaults. Each can be replaced by its env var (readRateConfig) without a code change. */
export const READ_RATE_DEFAULTS: ReadRateConfig = {
  freeReadPerMin: 120,
  freePollPerMin: 30,
  paidMultiplier: 4,
  burstMultiplier: 2,
  enabled: true,
};

const ENV_KEYS: Record<Exclude<keyof ReadRateConfig, 'enabled'>, string> = {
  freeReadPerMin: 'RATE_LIMIT_FREE_READ_PER_MIN',
  freePollPerMin: 'RATE_LIMIT_FREE_POLL_PER_MIN',
  paidMultiplier: 'RATE_LIMIT_PAID_MULTIPLIER',
  burstMultiplier: 'RATE_LIMIT_BURST_MULTIPLIER',
};

/** The defaults with any valid env override applied. `RATE_LIMIT_READS=off` switches the limiter off. */
export function readRateConfig(env: Record<string, string | undefined> = process.env): ReadRateConfig {
  const out: ReadRateConfig = { ...READ_RATE_DEFAULTS, enabled: env.RATE_LIMIT_READS !== 'off' };
  for (const [field, name] of Object.entries(ENV_KEYS) as [keyof typeof ENV_KEYS, string][]) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) out[field] = n;
  }
  return out;
}

/** List and polling endpoints: the tighter class. Exact paths, GET only. */
export const POLL_ROUTES: ReadonlySet<string> = new Set([
  '/api/missions/stages',
  '/api/missions/recent',
  '/api/tasks',
]);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Never counted, whatever the method. */
const EXEMPT_RES: readonly RegExp[] = [
  // Runner coordination.
  /^\/api\/workers\/(claim|queue|heartbeat)(\/|$)/,
  new RegExp(`^/api/workers/${UUID}(/|$)`, 'i'),
  // Sign-in, scheduled jobs, inbound webhooks, OAuth handshakes.
  /^\/api\/(auth|cron|webhooks|oauth)(\/|$)/,
];

/** The class a request is counted in, or null when it is not a counted read. */
export function classifyApiRead(method: string, pathname: string): ReadClass | null {
  if (method !== 'GET' && method !== 'HEAD') return null;
  if (pathname !== '/api' && !pathname.startsWith('/api/')) return null;
  if (EXEMPT_RES.some(re => re.test(pathname))) return null;
  return POLL_ROUTES.has(pathname) ? 'poll' : 'read';
}

export interface RateLimits { perMinute: number; burst: number }

export function limitsFor(plan: TeamPlan, cls: ReadClass, c: ReadRateConfig = readRateConfig()): RateLimits {
  const base = cls === 'poll' ? c.freePollPerMin : c.freeReadPerMin;
  const perMinute = plan === 'free' ? base : base * c.paidMultiplier;
  return { perMinute, burst: Math.max(1, Math.round(perMinute * c.burstMultiplier)) };
}

export interface BucketParams { intervalMs: number; burst: number }

/** One token per `intervalMs` (whole ms, so Redis PX gets an integer), holding at most `burst`. */
export function bucketParams(l: RateLimits): BucketParams {
  return { intervalMs: Math.max(1, Math.round(60_000 / l.perMinute)), burst: l.burst };
}

export interface BucketDecision { allowed: boolean; tat: number; retryAfterMs: number }

/**
 * GCRA. `tat` is when the bucket would be full again (null: never used).
 * A request moves it one interval later; it is allowed while that stays
 * within `burst` intervals of now. A refused request leaves it alone.
 */
export function decideBucket(tat: number | null, nowMs: number, p: BucketParams): BucketDecision {
  const start = tat !== null && tat > nowMs ? tat : nowMs;
  const next = start + p.intervalMs;
  const over = next - nowMs - p.intervalMs * p.burst;
  if (over > 0) return { allowed: false, tat: tat ?? nowMs, retryAfterMs: over };
  return { allowed: true, tat: next, retryAfterMs: 0 };
}

/**
 * decideBucket, atomic in Redis, with the plan read in the same round trip.
 * KEYS: bucket, plan. ARGV: now, free interval, free burst, paid interval,
 * paid burst. Returns { allowed 0|1, retryAfterMs, plan or '' }.
 */
export const BUCKET_SCRIPT = `
local plan = redis.call('GET', KEYS[2])
local now = tonumber(ARGV[1])
local interval, burst
if plan == 'free' then
  interval = tonumber(ARGV[2]); burst = tonumber(ARGV[3])
else
  interval = tonumber(ARGV[4]); burst = tonumber(ARGV[5])
end
local tat = tonumber(redis.call('GET', KEYS[1]) or '0')
if tat < now then tat = now end
local nxt = tat + interval
local over = nxt - now - interval * burst
if over > 0 then return {0, over, plan or ''} end
redis.call('SET', KEYS[1], nxt, 'PX', nxt - now)
return {1, 0, plan or ''}
`;

export interface BucketCall {
  bucketKey: string;
  planKey: string;
  nowMs: number;
  free: BucketParams;
  paid: BucketParams;
}

export interface BucketReply { allowed: boolean; retryAfterMs: number; plan: string }

export type ReadVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterSec: number; cls: ReadClass; limitPerMin: number };

export const planCacheKey = (subject: string) => `buildd:rl:plan:${subject}`;

/** Bucket subject for a bearer credential: a hash, so no key ever lands in Redis. */
export function readSubjectForKey(bearer: string): string {
  return `key:${createHash('sha256').update(bearer).digest('hex').slice(0, 32)}`;
}

export function readSubjectForUser(userId: string): string {
  return `user:${userId}`;
}

export interface GateDeps {
  /** Null when Redis is not configured or the call failed. */
  bucket?: (call: BucketCall) => Promise<BucketReply | null>;
  now?: () => number;
  config?: ReadRateConfig;
}

/** Decide one request. Never throws: any failure allows it. */
export async function gateApiRead(
  req: { method: string; pathname: string },
  subject: string | null,
  deps: GateDeps = {},
): Promise<ReadVerdict> {
  const config = deps.config ?? readRateConfig();
  if (!config.enabled || !subject) return { allowed: true };
  const cls = classifyApiRead(req.method, req.pathname);
  if (!cls) return { allowed: true };
  try {
    const bucket = deps.bucket ?? (await import('./redis')).evalReadBucket;
    const reply = await bucket({
      bucketKey: `buildd:rl:${cls}:${subject}`,
      planKey: planCacheKey(subject),
      nowMs: (deps.now ?? Date.now)(),
      free: bucketParams(limitsFor('free', cls, config)),
      paid: bucketParams(limitsFor('team', cls, config)),
    });
    if (!reply || reply.allowed) return { allowed: true };
    const plan: TeamPlan = reply.plan === 'free' ? 'free' : 'team';
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil(reply.retryAfterMs / 1000)),
      cls,
      limitPerMin: limitsFor(plan, cls, config).perMinute,
    };
  } catch {
    return { allowed: true };
  }
}

/** A plain Response (no next/server import: auth-helpers reaches this module, and its tests stub react). */
export function rateLimitedResponse(v: Extract<ReadVerdict, { allowed: false }>): Response {
  return Response.json(
    {
      error: `Rate limited: at most ${v.limitPerMin} requests per minute here. Retry after ${v.retryAfterSec}s.`,
      code: 'rate_limited',
      retryAfterSec: v.retryAfterSec,
      limitPerMin: v.limitPerMin,
    },
    { status: 429, headers: { 'Retry-After': String(v.retryAfterSec), 'Cache-Control': 'no-store' } },
  );
}
