import { createHash } from 'node:crypto';
import { isUuid } from '@/lib/uuid';

/**
 * What a passkey assertion is for (Living Spec b7fc9316 R-20). A challenge is
 * issued for one pin and stored with its binding, the sha256 of the pin and the
 * person; the act that consumes it recomputes the pin from what it is about to
 * write and asks for that binding. An assertion made for revision 3 at version
 * 5 is therefore refused on revision 4, on version 6, on another spec, by
 * another person, or for another act.
 */
export type PresencePin =
  | { op: 'approve'; specId: string; revision: number; version: number; contentHash: string }
  | { op: 'retire'; specId: string; version: number; status: string; supersededBy: string | null }
  | { op: 'restore'; specId: string; version: number; status: string }
  | { op: 'confirm_import'; workspaceId: string; specIds: string[] }
  | { op: 'team_passkey'; teamId: string; required: boolean }
  | { op: 'add_passkey' }
  | { op: 'remove_passkey'; passkeyId: string };

/** What a refusal hands the browser: the pin to ask a passkey for, and where to add one. */
export interface PresenceAsk {
  pin: PresencePin;
  addUrl: string;
}

export const PASSKEY_SETTINGS_PATH = '/app/settings/account#passkeys';

const HASH = /^[0-9a-f]{64}$/;
const STATUS = /^[a-z_]{1,32}$/;
const isVersion = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1;
const MAX_IMPORT_IDS = 100;

/** The pin, in one fixed field order, so equal pins hash equal whatever order they arrived in. */
function canonical(pin: PresencePin): unknown[] {
  switch (pin.op) {
    case 'approve': return [pin.op, pin.specId, pin.revision, pin.version, pin.contentHash];
    case 'retire': return [pin.op, pin.specId, pin.version, pin.status, pin.supersededBy];
    case 'restore': return [pin.op, pin.specId, pin.version, pin.status];
    case 'confirm_import': return [pin.op, pin.workspaceId, [...new Set(pin.specIds)].sort()];
    case 'team_passkey': return [pin.op, pin.teamId, pin.required];
    case 'add_passkey': return [pin.op];
    case 'remove_passkey': return [pin.op, pin.passkeyId];
  }
}

/** The binding a challenge is stored with: one person, one act. */
export function presenceBinding(userId: string, purpose: 'presence' | 'register', pin: PresencePin): string {
  return createHash('sha256').update(JSON.stringify(['buildd-passkey/1', purpose, userId, canonical(pin)])).digest('hex');
}

/**
 * A pin as the browser sends it back, checked field by field. Anything that is
 * not exactly one of the shapes above is null: the browser never chooses what
 * a challenge binds beyond naming the act it is shown.
 */
export function parsePresencePin(input: unknown): PresencePin | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const p = input as Record<string, unknown>;
  switch (p.op) {
    case 'approve':
      return isUuid(p.specId) && isVersion(p.revision) && isVersion(p.version) && typeof p.contentHash === 'string' && HASH.test(p.contentHash)
        ? { op: 'approve', specId: p.specId, revision: p.revision, version: p.version, contentHash: p.contentHash } : null;
    case 'retire':
      return isUuid(p.specId) && isVersion(p.version) && typeof p.status === 'string' && STATUS.test(p.status) && (p.supersededBy === null || isUuid(p.supersededBy))
        ? { op: 'retire', specId: p.specId, version: p.version, status: p.status, supersededBy: p.supersededBy as string | null } : null;
    case 'restore':
      return isUuid(p.specId) && isVersion(p.version) && typeof p.status === 'string' && STATUS.test(p.status)
        ? { op: 'restore', specId: p.specId, version: p.version, status: p.status } : null;
    case 'confirm_import':
      return isUuid(p.workspaceId) && Array.isArray(p.specIds) && p.specIds.length >= 1 && p.specIds.length <= MAX_IMPORT_IDS && p.specIds.every(isUuid)
        ? { op: 'confirm_import', workspaceId: p.workspaceId, specIds: p.specIds as string[] } : null;
    case 'team_passkey':
      return isUuid(p.teamId) && typeof p.required === 'boolean' ? { op: 'team_passkey', teamId: p.teamId, required: p.required } : null;
    case 'add_passkey':
      return { op: 'add_passkey' };
    case 'remove_passkey':
      return isUuid(p.passkeyId) ? { op: 'remove_passkey', passkeyId: p.passkeyId } : null;
    default:
      return null;
  }
}

/** The challenge a WebAuthn response answers, read from its clientDataJSON; null when unreadable. */
export function challengeOf(response: unknown): string | null {
  const data = (response as { response?: { clientDataJSON?: unknown } } | null)?.response?.clientDataJSON;
  if (typeof data !== 'string' || data.length > 4096) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as { challenge?: unknown };
    return typeof parsed.challenge === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(parsed.challenge) ? parsed.challenge : null;
  } catch {
    return null;
  }
}
