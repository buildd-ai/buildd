/**
 * Connector credential health — single source of truth.
 *
 * `deriveConnectorStatus` was previously private to /api/connectors, so the
 * Connections page was the only surface that knew a connector had gone stale.
 * Home (action queue) and the proactive expiry cron both need the same rule, so
 * it lives here.
 */

export type ConnectorStatus = 'connected' | 'expired' | 'not_connected';

export interface ConnectorCredentialSnapshot {
  tokenExpiresAt: Date | null;
  lastVerificationError?: string | null;
  /** When the team was last alerted about this credential's expiry (dedup). */
  expiryNotifiedAt?: Date | null;
}

/** How far ahead of expiry we warn, so a reconnect can happen before work stalls. */
export const CONNECTOR_EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000;

export function deriveConnectorStatus(
  secret: ConnectorCredentialSnapshot | undefined | null,
  now: Date = new Date(),
): ConnectorStatus {
  if (!secret) return 'not_connected';
  // Expired if the token has a past expiry, OR the refresher marked the credential
  // dead by nulling tokenExpiresAt and recording a verification error (spec §1b /
  // Ground truth #4). Without the latter, a dead credential renders green.
  if (secret.tokenExpiresAt && secret.tokenExpiresAt.getTime() <= now.getTime()) return 'expired';
  if (secret.tokenExpiresAt == null && secret.lastVerificationError != null) return 'expired';
  return 'connected';
}

/**
 * Still usable, but expiry is close enough that the team should reconnect now.
 * A credential with no expiry at all (non-expiring header keys) never qualifies.
 */
export function isExpiringSoon(
  secret: ConnectorCredentialSnapshot | undefined | null,
  now: Date = new Date(),
  withinMs: number = CONNECTOR_EXPIRY_WARNING_MS,
): boolean {
  if (!secret?.tokenExpiresAt) return false;
  if (deriveConnectorStatus(secret, now) !== 'connected') return false;
  return secret.tokenExpiresAt.getTime() - now.getTime() <= withinMs;
}

/**
 * Whether the proactive cron should alert about this credential right now.
 *
 * Dedup is by `expiryNotifiedAt`, which the reconnect/refresh success paths clear
 * — so one alert per expiry episode, and a fresh episode after a re-auth.
 * `not_connected` is deliberately silent: nobody ever connected it, so there is
 * nothing to have broken.
 */
export function shouldNotifyExpiry(
  secret: ConnectorCredentialSnapshot | undefined | null,
  now: Date = new Date(),
  withinMs: number = CONNECTOR_EXPIRY_WARNING_MS,
): boolean {
  if (!secret) return false;
  if (secret.expiryNotifiedAt) return false;
  return deriveConnectorStatus(secret, now) === 'expired' || isExpiringSoon(secret, now, withinMs);
}
