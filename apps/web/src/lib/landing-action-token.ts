// The signed, expiring token behind a landing page's tap URL
// (knowledge-base: buildd/design/pr-landing-guarantee.md §H).
//
// The token only SELECTS an action for one (workspace, PR, head, reason): it
// never acts. Confirming it still needs a signed-in session in the workspace's
// team, and the nonce is consumed once (see pr-landing-alert-deps.ts), so a
// forwarded or leaked notification cannot merge or dispatch anything.
//
// Same HMAC + TTL shape as github-install-state.ts and the same secret, domain
// separated so a token minted for one purpose never verifies as the other.

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { signingSecret } from '@/lib/github-install-state';

export const LANDING_ACTION_TTL_MS = 24 * 60 * 60 * 1000;

export type LandingAction =
  | 'ci_fix'
  | 'conflict'
  | 're_review'
  | 'retry_landing'
  | 'merge_anyway'
  | 'close_superseded';

export const LANDING_ACTIONS: readonly LandingAction[] = [
  'ci_fix',
  'conflict',
  're_review',
  'retry_landing',
  'merge_anyway',
  'close_superseded',
];

export interface LandingActionPayload {
  workspaceId: string;
  prNumber: number;
  headSha: string;
  /** The default action the page proposes. */
  action: LandingAction;
  /** The page reason (see `PageReason`); bounds which alternatives the page may offer. */
  reason: string;
  /** Epoch ms. */
  exp: number;
  nonce: string;
}

export type LandingTokenVerdict =
  | { ok: true; payload: LandingActionPayload }
  | { ok: false; reason: 'malformed' | 'unsigned' | 'bad_signature' | 'expired' };

const DOMAIN = 'landing-action.v1.';

const hmac = (secret: string, body: string) => createHmac('sha256', secret).update(DOMAIN + body).digest('base64url');

/** A signed token, or null when the deployment has no signing secret (the page then links the PR instead). */
export function signLandingActionToken(
  input: Omit<LandingActionPayload, 'exp' | 'nonce'>,
  now = Date.now(),
): string | null {
  const secret = signingSecret();
  if (!secret) return null;
  const payload: LandingActionPayload = { ...input, exp: now + LANDING_ACTION_TTL_MS, nonce: randomBytes(12).toString('hex') };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(secret, body)}`;
}

function isPayload(v: unknown): v is LandingActionPayload {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.workspaceId === 'string' &&
    typeof p.prNumber === 'number' &&
    Number.isSafeInteger(p.prNumber) &&
    typeof p.headSha === 'string' &&
    typeof p.reason === 'string' &&
    typeof p.exp === 'number' &&
    typeof p.nonce === 'string' &&
    p.nonce.length > 0 &&
    typeof p.action === 'string' &&
    (LANDING_ACTIONS as readonly string[]).includes(p.action)
  );
}

/** Verify signature first, then shape and expiry, so an unsigned or forged body never reaches the caller. */
export function verifyLandingActionToken(token: string | null | undefined, now = Date.now()): LandingTokenVerdict {
  if (!token) return { ok: false, reason: 'malformed' };
  const secret = signingSecret();
  if (!secret) return { ok: false, reason: 'unsigned' };
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [body, sig] = parts;
  const expected = Buffer.from(hmac(secret, body));
  const provided = Buffer.from(sig);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: 'bad_signature' };
  }
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
