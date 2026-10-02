/**
 * A person's own Pushover channel: where their away-alerts go
 * (knowledge-base: buildd/design/subscriptions-and-notifications.md, Channels; decision 1).
 *
 * Stored as one `secrets` row: purpose `pushover_personal`, `userId` set,
 * team-scoped, account/workspace NULL, value = the Pushover user key. It is a
 * PERSONAL_SECRET_PURPOSES entry (packages/core/secrets/team-scope.ts), so no
 * team list or team read ever returns it.
 *
 * Never the team key. The team's `pushover` row usually reaches a group, and
 * "tell me" must not page everyone, so nothing here reads purpose `pushover`
 * and a person with no key of their own gets no push (the row stays in the
 * inbox). The query shape is pinned by away-delivery.test.ts.
 *
 * Sender: the person supplies only a user key; buildd sends through the
 * platform's own Pushover application (PUSHOVER_TOKEN_PERSONAL, falling back
 * to the platform's task app token). That is Pushover's intended model for a
 * service: one app token, each user's key as the recipient. Unlike team
 * alerts, the content goes to the key's owner, about subjects they could see.
 */

import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { decrypt, getSecretsProvider } from '@buildd/core/secrets';
import { sanitizePushoverUserKey } from './pushover-key-shape';

export { sanitizePushoverUserKey } from './pushover-key-shape';

export const PERSONAL_PUSHOVER_PURPOSE = 'pushover_personal' as const;

const PUSHOVER_MESSAGES = 'https://api.pushover.net/1/messages.json';
const PUSHOVER_VALIDATE = 'https://api.pushover.net/1/users/validate.json';

type Fetch = typeof fetch;

/** The platform app token personal alerts are sent with, or null when none is configured. */
export function personalSenderToken(env: Record<string, string | undefined> = process.env): string | null {
  return env.PUSHOVER_TOKEN_PERSONAL || env.PUSHOVER_TOKEN_TASK || env.PUSHOVER_TOKEN || null;
}

// ── Pushover API ────────────────────────────────────────────────────────────

export type SendOutcome = 'sent' | 'rejected' | 'failed';

export interface PushoverMessage {
  token: string;
  user: string;
  title: string;
  message: string;
  priority?: -2 | -1 | 0 | 1;
  url?: string;
  urlTitle?: string;
}

/** `rejected` = Pushover answered 4xx (bad key, bad token): retrying will not help. */
export async function sendPushoverMessage(m: PushoverMessage, f: Fetch = fetch): Promise<SendOutcome> {
  try {
    const res = await f(PUSHOVER_MESSAGES, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: m.token, user: m.user, title: m.title, message: m.message, priority: m.priority ?? -1,
        ...(m.url ? { url: m.url, url_title: m.urlTitle } : {}),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return 'sent';
    return res.status >= 400 && res.status < 500 ? 'rejected' : 'failed';
  } catch {
    return 'failed';
  }
}

export type KeyCheck = { health: 'healthy' | 'revoked' | 'unknown'; error: string | null };

/** Ask Pushover whether this user key exists, without sending anything. */
export async function validatePushoverUser(token: string, user: string, f: Fetch = fetch): Promise<KeyCheck> {
  try {
    const res = await f(PUSHOVER_VALIDATE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, user }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return { health: 'healthy', error: null };
    if (res.status >= 400 && res.status < 500) {
      const body = await res.json().catch(() => ({})) as { errors?: unknown };
      const first = Array.isArray(body.errors) && typeof body.errors[0] === 'string' ? body.errors[0] : null;
      return { health: 'revoked', error: first ? `Pushover: ${first}` : 'Pushover did not recognise this key.' };
    }
    return { health: 'unknown', error: `Pushover answered HTTP ${res.status}.` };
  } catch {
    return { health: 'unknown', error: 'Could not reach Pushover.' };
  }
}

// ── Delivery-side lookup ────────────────────────────────────────────────────

/**
 * The one query delivery uses to find where a person's alert goes. Personal
 * purpose, this person, this team; a key Pushover rejected is skipped until
 * it is replaced.
 */
export function personalPushoverKeySql(userId: string, teamId: string): SQL {
  return sql`
    select s."encrypted_value" as "encryptedValue"
    from "secrets" s
    where s."purpose" = ${PERSONAL_PUSHOVER_PURPOSE}
      and s."user_id" = ${userId}::uuid
      and s."team_id" = ${teamId}::uuid
      and s."account_id" is null
      and s."workspace_id" is null
      and s."health_status" <> 'revoked'
    order by s."updated_at" desc
    limit 1
  `;
}

type Exec = (q: SQL) => Promise<{ rows?: unknown[] }>;
const dbExec: Exec = q => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

export async function loadPersonalPushoverKey(userId: string, teamId: string, exec: Exec = dbExec): Promise<string | null> {
  const r = await exec(personalPushoverKeySql(userId, teamId));
  const row = r.rows?.[0] as { encryptedValue?: string } | undefined;
  if (!row?.encryptedValue) return null;
  try {
    return decrypt(row.encryptedValue);
  } catch {
    console.error('[personal-pushover] failed to decrypt a personal key');
    return null;
  }
}

/** Flag the key after Pushover refused it, so delivery stops trying until it is replaced. */
export async function markPersonalPushoverRejected(userId: string, teamId: string, error: string): Promise<void> {
  const now = new Date();
  await db.update(secrets)
    .set({ healthStatus: 'revoked', lastFailureAt: now, lastFailureMessage: error, updatedAt: now })
    .where(ownScope(userId, teamId));
}

// ── Settings (the person's own row only) ────────────────────────────────────

export interface PersonalPushoverStatus {
  id: string;
  last4: string | null;
  health: 'healthy' | 'degraded' | 'revoked' | 'unknown';
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
}

/**
 * The caller's own row and nothing else: used by get, delete, test and
 * mark-rejected. Rendered-SQL test in personal-pushover.test.ts.
 */
export function ownScope(userId: string, teamId: string) {
  return and(
    eq(secrets.teamId, teamId),
    eq(secrets.purpose, PERSONAL_PUSHOVER_PURPOSE),
    eq(secrets.userId, userId),
    isNull(secrets.accountId),
    isNull(secrets.workspaceId),
  );
}

export async function getPersonalPushover(userId: string, teamId: string): Promise<PersonalPushoverStatus | null> {
  const row = await db.query.secrets.findFirst({
    where: ownScope(userId, teamId),
    columns: { id: true, encryptedValue: true, healthStatus: true, lastVerifiedAt: true, lastVerificationError: true, lastFailureMessage: true },
  });
  if (!row) return null;
  let last4: string | null = null;
  try { last4 = decrypt(row.encryptedValue).slice(-4); } catch { /* shown as "set" */ }
  return {
    id: row.id,
    last4,
    health: row.healthStatus,
    lastVerifiedAt: row.lastVerifiedAt ? new Date(row.lastVerifiedAt).toISOString() : null,
    lastVerificationError: row.healthStatus === 'revoked' ? (row.lastVerificationError ?? row.lastFailureMessage) : row.lastVerificationError,
  };
}

export type SetResult = { ok: true; key: PersonalPushoverStatus } | { ok: false; status: number; error: string };

/** Check the key with Pushover, then store it as this person's own (replacing any earlier one). */
export async function setPersonalPushover(
  input: { userId: string; teamId: string; value: string },
  deps: { fetch?: Fetch; token?: string | null } = {},
): Promise<SetResult> {
  const shape = sanitizePushoverUserKey(input.value);
  if (!shape.ok) return { ok: false, status: 400, error: shape.error };
  const token = deps.token !== undefined ? deps.token : personalSenderToken();
  if (!token) return { ok: false, status: 503, error: 'Pushover sending is not set up on this server.' };

  const check = await validatePushoverUser(token, shape.value, deps.fetch);
  if (check.health === 'revoked') return { ok: false, status: 400, error: check.error ?? 'Pushover did not recognise this key.' };

  const id = await getSecretsProvider().replaceScoped(shape.value, {
    teamId: input.teamId,
    purpose: PERSONAL_PUSHOVER_PURPOSE,
    userId: input.userId,
  });
  const now = new Date();
  await db.update(secrets)
    .set({
      healthStatus: check.health,
      lastVerifiedAt: now,
      lastVerificationError: check.error,
      ...(check.health === 'healthy' ? { lastSuccessAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(secrets.id, id));
  const key = await getPersonalPushover(input.userId, input.teamId);
  return key ? { ok: true, key } : { ok: false, status: 500, error: 'Saved, but could not read it back.' };
}

export async function deletePersonalPushover(userId: string, teamId: string): Promise<boolean> {
  const deleted = await db.delete(secrets).where(ownScope(userId, teamId)).returning({ id: secrets.id });
  return deleted.length > 0;
}

/** Send one real test push to the person's own key and record the outcome. */
export async function testPersonalPushover(
  userId: string, teamId: string, deps: { fetch?: Fetch; token?: string | null } = {},
): Promise<{ ok: boolean; error: string | null }> {
  const row = await db.query.secrets.findFirst({ where: ownScope(userId, teamId), columns: { id: true, encryptedValue: true } });
  if (!row) return { ok: false, error: 'No Pushover key is set.' };
  const token = deps.token !== undefined ? deps.token : personalSenderToken();
  if (!token) return { ok: false, error: 'Pushover sending is not set up on this server.' };
  let user: string;
  try { user = decrypt(row.encryptedValue); } catch { return { ok: false, error: 'Could not read the stored key. Replace it.' }; }

  const outcome = await sendPushoverMessage({
    token, user, title: 'buildd', message: 'Test from buildd. Alerts for things you watch arrive here when you are away.', priority: -1,
  }, deps.fetch);
  const now = new Date();
  const error = outcome === 'sent' ? null : outcome === 'rejected' ? 'Pushover rejected this key.' : 'Could not reach Pushover.';
  await db.update(secrets)
    .set({
      healthStatus: outcome === 'sent' ? 'healthy' : outcome === 'rejected' ? 'revoked' : 'degraded',
      lastVerifiedAt: now,
      lastVerificationError: error,
      ...(outcome === 'sent' ? { lastSuccessAt: now } : { lastFailureAt: now, lastFailureMessage: error }),
      updatedAt: now,
    })
    .where(eq(secrets.id, row.id));
  return { ok: outcome === 'sent', error };
}
