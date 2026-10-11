// The signed, expiring request behind a spec approval made over MCP or chat
// (decision D-4; owner decision 2026-10-11).
//
// An OAuth bearer session is the person's own, but an agent may be the one
// driving it, so an approve from it never approves. It mints this token for
// exactly one (spec, head revision, version, content hash) and returns a link;
// the approval happens only when a person confirms the link from their
// dashboard session (approval.ts confirmSpecApproval). The token only SELECTS
// what to approve: it is not a credential, and confirming re-checks the
// person's rights. It needs no row: the approval stamps a revision once and
// moves the spec's version, so a used or outdated token reads as stale.
//
// Same HMAC + TTL shape and secret as landing-action-token.ts, domain separated.

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { signingSecret } from '@/lib/github-install-state';

export const SPEC_APPROVAL_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export interface SpecApprovalRequest {
  specId: string;
  workspaceId: string;
  revision: number;
  /** The spec version the request was made at; any later change makes it stale. */
  expectedVersion: number;
  /** sha256 of the revision body the requester read. */
  contentHash: string;
  /** The person whose session asked. */
  requestedBy: string;
  /** Epoch ms. */
  exp: number;
  nonce: string;
}

export type SpecApprovalRequestVerdict =
  | { ok: true; payload: SpecApprovalRequest }
  | { ok: false; reason: 'malformed' | 'unsigned' | 'bad_signature' | 'expired' };

const DOMAIN = 'spec-approval-request.v1.';
const hmac = (secret: string, body: string) => createHmac('sha256', secret).update(DOMAIN + body).digest('base64url');

/** A signed token, or null when the deployment has no signing secret. `now` is the minting time. */
export function signSpecApprovalRequest(input: Omit<SpecApprovalRequest, 'exp' | 'nonce'>, now = Date.now()): string | null {
  const secret = signingSecret();
  if (!secret) return null;
  const payload: SpecApprovalRequest = { ...input, exp: now + SPEC_APPROVAL_REQUEST_TTL_MS, nonce: randomBytes(12).toString('hex') };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(secret, body)}`;
}

function isPayload(v: unknown): v is SpecApprovalRequest {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.specId === 'string' &&
    typeof p.workspaceId === 'string' &&
    Number.isSafeInteger(p.revision) &&
    Number.isSafeInteger(p.expectedVersion) &&
    typeof p.contentHash === 'string' &&
    typeof p.requestedBy === 'string' &&
    typeof p.exp === 'number' &&
    typeof p.nonce === 'string' &&
    p.nonce.length > 0
  );
}

/** Signature first, then shape and expiry, so a forged body never reaches the caller. */
export function verifySpecApprovalRequest(token: string | null | undefined, now = Date.now()): SpecApprovalRequestVerdict {
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
export const specApprovalConfirmPath = (specId: string, token: string) =>
  `/app/specs/${encodeURIComponent(specId)}/approve?request=${encodeURIComponent(token)}`;
