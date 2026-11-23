/**
 * The assertion grant (RFC 7523), server side.
 *
 * An assertion-mode connector's provider trusts buildd's signing key: buildd
 * signs a short-lived assertion naming one worker on one task, and the
 * provider's token endpoint exchanges it for an access token.
 *
 * Two callers share the claims defined here:
 *   - POST /api/connectors/[id]/assertion: a runner mints, then exchanges
 *     itself (the direct mount, when the gateway does not broker the connector).
 *   - the connector gateway (connector-gateway-store.ts): buildd mints and
 *     exchanges, and the access token never leaves the server.
 *
 * Design: docs/design/cross-app-assertion-grant.md
 */
import { getActiveSigningKey, signAssertion } from '@/lib/signing-keys';
import { getIssuer } from '@/lib/oauth/config';

/** How long a minted assertion is valid. */
export const ASSERTION_TTL_SEC = 300;
const EXCHANGE_TIMEOUT_MS = 30_000;
/** When the provider omits `expires_in`. Matches the runner's exchange. */
const DEFAULT_TOKEN_TTL_SEC = 600;

export interface AssertionSubject {
  /** The runner account that claimed the worker. */
  accountId: string;
  /** That account's team: the tenant the provider sees. */
  accountTeamId: string | null;
  workerId: string;
  taskId: string;
  /** The connector's configured audience (the resource server). */
  audience: string;
}

// A type alias, not an interface: signAssertion takes a Record<string, unknown>.
export type AssertionClaims = {
  iss: string;
  sub: string;
  act: { sub: string; tid: string };
  aud: string;
  jti: string;
  iat: number;
  exp: number;
};

/** sub = the tenant (account:team); act = the worker acting on one task. */
export function buildAssertionClaims(s: AssertionSubject, now: Date = new Date()): AssertionClaims {
  const iat = Math.floor(now.getTime() / 1000);
  const jti = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
  return {
    // Derived, never a literal: a preview deployment must not claim the
    // production issuer (getIssuer() returns the canonical host in production).
    iss: getIssuer(),
    sub: `${s.accountId}:${s.accountTeamId}`,
    act: { sub: `worker:${s.workerId}`, tid: s.taskId },
    aud: s.audience,
    jti,
    iat,
    exp: iat + ASSERTION_TTL_SEC,
  };
}

/** Sign an assertion with the active key. Null when no key is active (an operator error). */
export async function mintConnectorAssertion(s: AssertionSubject, now: Date = new Date()): Promise<{ assertion: string; expiresAt: Date } | null> {
  const key = await getActiveSigningKey();
  if (!key) return null;
  const claims = buildAssertionClaims(s, now);
  const assertion = await signAssertion(claims, key.privateKeyJwk, key.kid);
  return { assertion, expiresAt: new Date(claims.exp * 1000) };
}

/** An https URL (http only in development). An assertion is never sent anywhere else. */
export function tokenEndpointAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (process.env.NODE_ENV === 'development' && u.protocol === 'http:');
  } catch {
    return false;
  }
}

/**
 * Exchange an assertion at the provider's token endpoint for an access token.
 * Throws on any failure; the message carries the status, never the assertion
 * or a token.
 */
export async function exchangeAssertion(tokenEndpoint: string, assertion: string): Promise<{ accessToken: string; expiresAt: number }> {
  if (!tokenEndpointAllowed(tokenEndpoint)) throw new Error('Token endpoint must be https');
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Token exchange failed: ${res.status}`);
  }
  const body = await res.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown } | null;
  const accessToken = typeof body?.access_token === 'string' && body.access_token ? body.access_token : null;
  if (!accessToken) throw new Error('Token exchange answered without an access_token');
  const ttl = typeof body?.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : DEFAULT_TOKEN_TTL_SEC;
  return { accessToken, expiresAt: Date.now() + ttl * 1000 };
}
