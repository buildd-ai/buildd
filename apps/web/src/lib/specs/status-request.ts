// The signed, expiring request behind a retire or restore asked for from an
// OAuth session (Living Spec b7fc9316, R-11, R-12): the same model as an
// approval request (approval-request.ts). The session is the person's own, but
// an agent may be the one driving it, so it changes nothing; it gets a link,
// and the change happens only when the person confirms it from their dashboard
// session (retire.ts confirmSpecStatusChange).
//
// The token pins the spec, its version, its status and the stated reason. It
// only SELECTS what to do: it is not a credential, confirming re-checks the
// person's rights, and any change to the spec's version or status since makes
// it stale. Domain separated from every other token signed with this secret.

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { signingSecret } from '@/lib/github-install-state';

export const SPEC_STATUS_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export interface SpecStatusRequest {
  op: 'retire' | 'restore';
  specId: string;
  workspaceId: string;
  /** The spec version and status the request was made at. */
  expectedVersion: number;
  status: string;
  reason: string;
  /** retire only: the live spec that replaces it. */
  supersededBy: string | null;
  /** The person whose session asked. */
  requestedBy: string;
  /** Epoch ms. */
  exp: number;
  nonce: string;
}

export type SpecStatusRequestVerdict =
  | { ok: true; payload: SpecStatusRequest }
  | { ok: false; reason: 'malformed' | 'unsigned' | 'bad_signature' | 'expired' };

const DOMAIN = 'spec-status-request.v1.';
const hmac = (secret: string, body: string) => createHmac('sha256', secret).update(DOMAIN + body).digest('base64url');

/** A signed token, or null when the deployment has no signing secret. */
export function signSpecStatusRequest(input: Omit<SpecStatusRequest, 'exp' | 'nonce'>, now = Date.now()): string | null {
  const secret = signingSecret();
  if (!secret) return null;
  const payload: SpecStatusRequest = { ...input, exp: now + SPEC_STATUS_REQUEST_TTL_MS, nonce: randomBytes(12).toString('hex') };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(secret, body)}`;
}

function isPayload(v: unknown): v is SpecStatusRequest {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    (p.op === 'retire' || p.op === 'restore') &&
    typeof p.specId === 'string' &&
    typeof p.workspaceId === 'string' &&
    Number.isSafeInteger(p.expectedVersion) &&
    typeof p.status === 'string' &&
    typeof p.reason === 'string' &&
    (p.supersededBy === null || typeof p.supersededBy === 'string') &&
    typeof p.requestedBy === 'string' &&
    typeof p.exp === 'number' &&
    typeof p.nonce === 'string' &&
    p.nonce.length > 0
  );
}

/** Signature first, then shape and expiry, so a forged body never reaches the caller. */
export function verifySpecStatusRequest(token: string | null | undefined, now = Date.now()): SpecStatusRequestVerdict {
  if (!token) return { ok: false, reason: 'malformed' };
  const secret = signingSecret();
  if (!secret) return { ok: false, reason: 'unsigned' };
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [body, sig] = parts;
  const expected = Buffer.from(hmac(secret, body));
  const provided = Buffer.from(sig);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return { ok: false, reason: 'bad_signature' };
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isPayload(decoded)) return { ok: false, reason: 'malformed' };
  if (now >= decoded.exp) return { ok: false, reason: 'expired' };
  return { ok: true, payload: decoded };
}

/** The page a person opens to confirm. */
export const specStatusConfirmPath = (specId: string, token: string) =>
  `/app/specs/${encodeURIComponent(specId)}/retire?request=${encodeURIComponent(token)}`;
