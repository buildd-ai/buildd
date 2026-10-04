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
 */
import { NextResponse } from 'next/server';
import { parseKeyRing, verifyRequest } from '@buildd/dispatch-contract';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function callbackError(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export function callbackJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** The verified JSON body, or the response to send instead. */
export async function verifyDispatchCallback(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  const keys = parseKeyRing(process.env.DISPATCH_CALLBACK_SECRET);
  if (Object.keys(keys).length === 0) return { ok: false, response: callbackError(503, 'dispatch callbacks are not configured') };
  const raw = await req.text();
  const url = new URL(req.url);
  const v = await verifyRequest({ keys, method: req.method, path: url.pathname + url.search, body: raw, headers: req.headers });
  if (!v.ok) return { ok: false, response: callbackError(401, `signature ${v.why}`) };
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, response: callbackError(400, 'invalid JSON body') };
  }
}
