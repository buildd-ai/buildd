// The `state` parameter carried through the GitHub App install flow
// (/api/github/install → github.com → /api/github/callback).
//
// It is HMAC-signed and bound to the session user who started the flow, so the
// callback can tell a flow this user started from an arbitrary callback URL.
// Only a bound state lets the callback record the user as an installation's
// installer. `returnUrl` is always reduced to a same-site relative path.

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

const DEFAULT_RETURN = '/app/workspaces';
/** How long an install flow may take between /install and /callback. */
export const INSTALL_STATE_TTL_MS = 60 * 60 * 1000;

function signingSecret(): string | null {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || process.env.ENCRYPTION_KEY || null;
}

/** Relative in-app path only — never another origin (`//host`, `/\host`, `https:`). */
export function safeReturnUrl(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_RETURN;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return DEFAULT_RETURN;
  if (/[\u0000-\u001f]/.test(raw)) return DEFAULT_RETURN;
  return raw;
}

function hmac(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function signInstallState(input: { userId: string; returnUrl?: string | null }, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({
    uid: input.userId,
    returnUrl: safeReturnUrl(input.returnUrl ?? DEFAULT_RETURN),
    ts: now,
    n: randomBytes(8).toString('hex'),
  })).toString('base64url');
  const secret = signingSecret();
  return secret ? `${body}.${hmac(secret, body)}` : body;
}

/**
 * Decode a callback `state`. `bound` is true only for an unexpired state whose
 * signature verifies and whose user is `sessionUserId`. A missing, legacy or
 * foreign state still yields a safe `returnUrl`.
 */
export function readInstallState(
  state: string | null | undefined,
  sessionUserId: string | null | undefined,
  now = Date.now(),
): { returnUrl: string; bound: boolean } {
  if (!state) return { returnUrl: DEFAULT_RETURN, bound: false };
  const [body, sig] = state.split('.');
  let decoded: { uid?: unknown; returnUrl?: unknown; ts?: unknown } = {};
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return { returnUrl: DEFAULT_RETURN, bound: false };
  }
  const returnUrl = safeReturnUrl(decoded.returnUrl);

  const secret = signingSecret();
  if (!secret || !sig || !sessionUserId) return { returnUrl, bound: false };
  const expected = Buffer.from(hmac(secret, body));
  const provided = Buffer.from(sig);
  const sigOk = expected.length === provided.length && timingSafeEqual(expected, provided);
  const fresh = typeof decoded.ts === 'number' && now - decoded.ts >= 0 && now - decoded.ts <= INSTALL_STATE_TTL_MS;
  return { returnUrl, bound: sigOk && fresh && decoded.uid === sessionUserId };
}
