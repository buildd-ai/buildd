import { appBaseUrl } from '@/lib/app-url';

/**
 * The WebAuthn relying party: the app's own public origin (app-url.ts), never
 * a request's Host header. A passkey is scoped to this host, so one registered
 * on buildd.dev answers only on buildd.dev.
 */
export function passkeyRelyingParty(): { rpID: string; rpName: string; origin: string } {
  const base = new URL(appBaseUrl());
  return { rpID: base.hostname, rpName: 'buildd', origin: base.origin };
}

/** How long a challenge may be answered. */
export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Live (unanswered, unexpired) challenges one person may hold at once. */
export const MAX_LIVE_CHALLENGES = 20;
/** Passkeys one person may register. */
export const MAX_PASSKEYS = 10;
