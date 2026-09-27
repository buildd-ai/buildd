/**
 * Client-safe Pushover key helpers, shared by the Settings card and the server
 * (lib/personal-pushover.ts). No DB, no secrets.
 */

import type { KeyShapeResult, ProviderKeyStatus } from './provider-keys-client';

/** Pushover user and group keys are 30 letters and digits. */
export function sanitizePushoverUserKey(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  let v = raw.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1).trim();
  if (!v) return { ok: false, error: 'Paste your user key first.' };
  if (!/^[A-Za-z0-9]{30}$/.test(v)) return { ok: false, error: 'A Pushover user key is 30 letters and digits.' };
  return { ok: true, value: v };
}

/** The same check in the shape the key card expects. */
export function checkPushoverKeyShape(raw: string): KeyShapeResult {
  const r = sanitizePushoverUserKey(raw);
  return r.ok ? { ok: true, value: r.value } : { ok: false, value: raw.trim(), message: r.error };
}

/** Wire shape of GET/PUT /api/me/pushover `key`. */
export interface PersonalPushoverWire {
  id: string;
  last4: string | null;
  health: 'healthy' | 'degraded' | 'revoked' | 'unknown';
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
}

export function pushoverKeyStatus(k: PersonalPushoverWire | null | undefined): ProviderKeyStatus | null {
  if (!k) return null;
  return {
    id: k.id,
    masked: k.last4 ? `…${k.last4}` : 'set',
    health: k.health === 'healthy' ? 'ok' : k.health === 'revoked' ? 'failing' : k.health === 'degraded' ? 'degraded' : 'unknown',
    lastVerifiedAt: k.lastVerifiedAt,
    error: k.lastVerificationError,
    managedHere: true,
    sourceNote: null,
  };
}
