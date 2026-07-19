/**
 * Auth-error classification for credential health tracking.
 *
 * Lives in packages/core so it can be used by both the web app (when
 * processing worker failures) and any future runner-side health reporting.
 *
 * Two severity classes:
 *   'revoked'  — the token was explicitly invalidated server-side (logout,
 *                account switch, invalid_grant). Immediately marks the
 *                credential as revoked on first occurrence.
 *   'degraded' — auth failed but the cause might be transient or fixable
 *                without re-authing (wrong key, expired session, network
 *                hiccup). Transitions to 'revoked' after N consecutive hits.
 *   'none'     — not an auth error (rate limit, budget, network, etc.).
 */

export type AuthErrorSeverity = 'none' | 'degraded' | 'revoked';

/** Patterns that indicate the credential was explicitly revoked server-side. */
const REVOCATION_PATTERNS: string[] = [
  'could not be refreshed',
  'please sign in again',
  'invalid_grant',
  'signed in to another account',
  'refresh token is invalid',
  'token has been revoked',
  'account has been deactivated',
];

/** Patterns that indicate an auth failure (may be transient). */
const DEGRADED_PATTERNS: string[] = [
  'invalid api key',
  'invalid authentication',
  'authentication failed',
  '401 unauthorized',
  'api key is required',
  'oauth token has expired',
  'credential expired',
  'credentials expired',
  'no codex auth',
  'agent authentication failed',
];

export function classifyAuthErrorSeverity(message: string): AuthErrorSeverity {
  const lower = message.toLowerCase();

  for (const pattern of REVOCATION_PATTERNS) {
    if (lower.includes(pattern)) return 'revoked';
  }

  for (const pattern of DEGRADED_PATTERNS) {
    if (lower.includes(pattern)) return 'degraded';
  }

  return 'none';
}

/** True only for revocation-class errors (explicit server-side invalidation). */
export function isRevocationClass(message: string): boolean {
  return classifyAuthErrorSeverity(message) === 'revoked';
}
