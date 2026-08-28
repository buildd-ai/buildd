/**
 * Connector credential health — single source of truth.
 *
 * `deriveConnectorStatus` was previously private to /api/connectors, so the
 * Connections page was the only surface that knew a connector had gone stale.
 * Home (action queue) and the proactive expiry cron both need the same rule, so
 * it lives here.
 */

import { sweepLookaheadMinutes } from './cron-cadence';

export type ConnectorStatus = 'connected' | 'expired' | 'not_connected';

export interface ConnectorCredentialSnapshot {
  tokenExpiresAt: Date | null;
  lastVerificationError?: string | null;
  /** When the team was last alerted about this credential's expiry (dedup). */
  expiryNotifiedAt?: Date | null;
}

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
 * A credential is only a *human* problem once it can no longer heal itself.
 *
 * The first cut of this warned whenever a token was within 24h of expiry, which
 * turned out to be permanently true: Cue issues 24h access tokens, so the card
 * never cleared and the alert fired after every reconnect. Approaching expiry is
 * not a signal — the refresh sweep handles it. Two conditions are:
 *
 *   1. refresh has definitively failed (`lastVerificationError` set — the sweep's
 *      failure path records this and nulls the expiry), or
 *   2. the token has been expired for a full sweep cycle and still is, meaning
 *      nothing is renewing it. That is the failure that actually bit: the sweep
 *      sat on a Vercel cron that never fired, so a credential holding a valid
 *      refresh token stayed dead until someone reconnected by hand.
 */
export function reconnectGraceMs(): number {
  return sweepLookaheadMinutes() * 60_000;
}

export function needsReconnect(
  secret: ConnectorCredentialSnapshot | undefined | null,
  now: Date = new Date(),
  graceMs: number = reconnectGraceMs(),
): boolean {
  if (!secret) return false; // never connected — nothing to reconnect
  if (secret.lastVerificationError != null) return true;
  if (!secret.tokenExpiresAt) return false;
  return secret.tokenExpiresAt.getTime() < now.getTime() - graceMs;
}

/**
 * Whether to send a push about this credential right now.
 *
 * Dedup is by `expiryNotifiedAt`, which the reconnect and refresh-success paths
 * clear — so one alert per broken episode, and a fresh episode after a re-auth.
 */
export function shouldNotifyExpiry(
  secret: ConnectorCredentialSnapshot | undefined | null,
  now: Date = new Date(),
  graceMs: number = reconnectGraceMs(),
): boolean {
  if (secret?.expiryNotifiedAt) return false;
  return needsReconnect(secret, now, graceMs);
}
