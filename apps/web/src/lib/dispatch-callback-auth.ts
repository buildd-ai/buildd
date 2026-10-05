/**
 * Authentication for Dispatch → Buildd callbacks (/api/dispatch/v1/*).
 *
 * HMAC-SHA256 over `timestamp.METHOD.path.sha256(body)` with the
 * DISPATCH_CALLBACK_SECRET key ring (`keyId:secret[,keyId:secret]`, two ids
 * live during rotation), a separate secret from the publish direction.
 * `path` is the request's pathname plus search, as Dispatch signed it.
 *
 * Fails closed: an unset or empty ring answers 503 to everything, a missing,
 * stale (±300 s) or wrong signature 401. Replay inside the skew window is
 * harmless: resolve is idempotent (and a grant mints once per window),
 * relay re-sends a wake the claim dedupes, receipts are upserts.
 *
 * Rate limit: a verified caller gets CALLBACK_RATE_LIMIT per key id (about
 * 10 rps) across all three routes, counted in Redis, so a leaked callback
 * secret cannot keep Neon awake. Over it: 429 with Retry-After, before any
 * database read. The Worker treats any non-2xx as retryable (a resolve or
 * relay attempt backs off; receipts stay queued in the Worker). Checked after
 * the signature, so a forger cannot spend a real key's budget. Fails open,
 * with a throttled warning, when Redis is unconfigured or erroring — the same
 * stance as the grant-once check (lib/dispatch-resolve.ts).
 */
import { NextResponse } from 'next/server';
import { parseKeyRing, verifyRequest } from '@buildd/dispatch-contract';
import { incrWindow } from '@/lib/redis';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function callbackError(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export function callbackJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Per key id, shared by resolve, relay and receipts: 100 per 10 s ≈ 10 rps, with room for a burst. */
export const CALLBACK_RATE_LIMIT = { limit: 100, windowSec: 10 } as const;

export type RateVerdict = { allowed: true } | { allowed: false; retryAfterSec: number };

let lastUnavailableWarnMs = -Infinity;

/** Fixed-window count for one key id. Allows (and warns at most once a minute) when Redis cannot answer. */
export async function callbackRateLimit(
  keyId: string,
  deps: { incr?: (key: string, ttlSec: number) => Promise<number | null>; now?: () => number } = {},
): Promise<RateVerdict> {
  const { limit, windowSec } = CALLBACK_RATE_LIMIT;
  const nowMs = (deps.now ?? Date.now)();
  const window = Math.floor(nowMs / 1000 / windowSec);
  const n = await (deps.incr ?? incrWindow)(`buildd:dispatch:rl:${keyId}:${window}`, windowSec + 5);
  if (n === null) {
    if (nowMs - lastUnavailableWarnMs >= 60_000) {
      lastUnavailableWarnMs = nowMs;
      console.warn('[dispatch-callback] rate limit unavailable (Redis); allowing callbacks');
    }
    return { allowed: true };
  }
  if (n <= limit) return { allowed: true };
  const left = (window + 1) * windowSec - nowMs / 1000;
  return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(left)) };
}

/** The verified JSON body, or the response to send instead. */
export async function verifyDispatchCallback(
  req: Request,
  opts: { limit?: (keyId: string) => Promise<RateVerdict> } = {},
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  const keys = parseKeyRing(process.env.DISPATCH_CALLBACK_SECRET);
  if (Object.keys(keys).length === 0) return { ok: false, response: callbackError(503, 'dispatch callbacks are not configured') };
  const raw = await req.text();
  const url = new URL(req.url);
  const v = await verifyRequest({ keys, method: req.method, path: url.pathname + url.search, body: raw, headers: req.headers });
  if (!v.ok) return { ok: false, response: callbackError(401, `signature ${v.why}`) };
  const verdict = await (opts.limit ?? callbackRateLimit)(v.keyId);
  if (!verdict.allowed) {
    console.warn(`[dispatch-callback] rate limited key ${v.keyId} on ${url.pathname}`);
    return {
      ok: false,
      response: NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { ...NO_STORE, 'Retry-After': String(verdict.retryAfterSec) } }),
    };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, response: callbackError(400, 'invalid JSON body') };
  }
}
