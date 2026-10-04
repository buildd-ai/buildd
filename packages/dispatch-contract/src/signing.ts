// Request signing for both directions (producer → Dispatch, Dispatch →
// producer callbacks). Each direction has its own secret. Web Crypto only, so
// the same code runs in Workers, Bun and Node.
//
//   signature = hex(HMAC-SHA256(secret, `${timestamp}.${METHOD}.${path}.${hex(sha256(body))}`))
//
// `path` is the URL pathname plus search. Two key ids may be active at once,
// for rotation. Replay inside the skew window is harmless by construction:
// publish is idempotent on id, resolve is idempotent, receipts are upserts.

export const SIGNATURE_HEADERS = {
  keyId: 'Dispatch-Key-Id',
  timestamp: 'Dispatch-Timestamp',
  signature: 'Dispatch-Signature',
} as const;

export const MAX_SKEW_SECONDS = 300;

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

function canonical(timestamp: string, method: string, path: string, bodyHash: string): string {
  return `${timestamp}.${method.toUpperCase()}.${path}.${bodyHash}`;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface SignInput {
  keyId: string;
  secret: string;
  method: string;
  /** Pathname plus search, e.g. `/v1/envelopes`. */
  path: string;
  body: string;
  /** Unix seconds; defaults to now. */
  now?: number;
}

/** Headers to attach to a signed request. */
export async function signRequest(input: SignInput): Promise<Record<string, string>> {
  const ts = String(input.now ?? Math.floor(Date.now() / 1000));
  const bodyHash = hex(await crypto.subtle.digest('SHA-256', enc.encode(input.body)));
  const sig = await hmacHex(input.secret, canonical(ts, input.method, input.path, bodyHash));
  return {
    [SIGNATURE_HEADERS.keyId]: input.keyId,
    [SIGNATURE_HEADERS.timestamp]: ts,
    [SIGNATURE_HEADERS.signature]: sig,
  };
}

export type VerifyResult = { ok: true; keyId: string } | { ok: false; why: 'missing' | 'unknown_key' | 'skew' | 'bad_signature' };

export interface VerifyInput {
  /** Active secrets by key id. An empty map rejects everything. */
  keys: Record<string, string>;
  method: string;
  path: string;
  body: string;
  headers: { get(name: string): string | null };
  now?: number;
}

export async function verifyRequest(input: VerifyInput): Promise<VerifyResult> {
  const keyId = input.headers.get(SIGNATURE_HEADERS.keyId);
  const ts = input.headers.get(SIGNATURE_HEADERS.timestamp);
  const sig = input.headers.get(SIGNATURE_HEADERS.signature);
  if (!keyId || !ts || !sig) return { ok: false, why: 'missing' };
  const secret = Object.prototype.hasOwnProperty.call(input.keys, keyId) ? input.keys[keyId] : undefined;
  if (!secret) return { ok: false, why: 'unknown_key' };
  const tsNum = Number(ts);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!/^\d+$/.test(ts) || Math.abs(now - tsNum) > MAX_SKEW_SECONDS) return { ok: false, why: 'skew' };
  const bodyHash = hex(await crypto.subtle.digest('SHA-256', enc.encode(input.body)));
  const expected = await hmacHex(secret, canonical(ts, input.method, input.path, bodyHash));
  return timingSafeEqual(expected, sig.toLowerCase()) ? { ok: true, keyId } : { ok: false, why: 'bad_signature' };
}

/**
 * Parse a key ring from an env value: `keyId:secret[,keyId:secret]`. A bare
 * secret with no colon gets the key id `k1`. Blank → empty ring (fail closed).
 */
export function parseKeyRing(value: string | undefined | null): Record<string, string> {
  const ring: Record<string, string> = {};
  for (const part of (value ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i === -1) ring.k1 = part;
    else if (i > 0 && i < part.length - 1) ring[part.slice(0, i)] = part.slice(i + 1);
  }
  return ring;
}

/** The key used to sign outbound requests: the first entry of the ring. */
export function signingKey(ring: Record<string, string>): { keyId: string; secret: string } | null {
  const first = Object.entries(ring)[0];
  return first ? { keyId: first[0], secret: first[1] } : null;
}
