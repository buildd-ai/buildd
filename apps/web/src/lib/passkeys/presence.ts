import { randomBytes } from 'node:crypto';
import { db } from '@buildd/core/db';
import { teams, userPasskeys, users } from '@buildd/core/db/schema';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isUuid } from '@/lib/uuid';
import { getUserTeamRole } from '@/lib/team-access';
import { roleHas } from '@/lib/permission-registry';
import { appBaseUrl } from '@/lib/app-url';
import { challengeOf, presenceBinding, PASSKEY_SETTINGS_PATH, type PresenceAsk, type PresencePin } from './binding';
import { MAX_LIVE_CHALLENGES, MAX_PASSKEYS, PASSKEY_CHALLENGE_TTL_MS, passkeyRelyingParty } from './config';

/**
 * Passkeys and the presence check (Living Spec b7fc9316 R-20, AC-19).
 *
 * A team owner may require a passkey for spec approve, retire and restore.
 * Then every write of those acts from a dashboard session (an inbox row, a
 * confirm page, the spec page's own buttons, an import confirm) asks for one
 * WebAuthn assertion with user presence, over a challenge issued for exactly
 * that act (binding.ts), and changes nothing without it. Verification is
 * @simplewebauthn/server's; this module only stores credentials and challenges.
 *
 * The check runs last, after every other check of the act has passed, so a
 * stale pin or a gate refusal is reported before a passkey is asked for and
 * never spends one. A challenge is consumed by one UPDATE whether or not the
 * assertion then verifies: one challenge, one try.
 *
 * Adding or removing a passkey needs an assertion from one of the person's
 * passkeys once they have one and belong to a team that requires them, so an
 * agent driving their browser cannot swap in an authenticator of its own.
 * Changing the team switch, either way, needs the owner's own assertion.
 */

export type PresenceRefusal = {
  ok: false; status: 400 | 403 | 409; error: string;
  code: 'passkey_missing' | 'presence_required' | 'presence_failed' | 'passkey_limit' | 'passkey_invalid';
  presence?: PresenceAsk;
};

const rowsOf = <T>(r: unknown) => ((r as { rows?: T[] }).rows ?? []);
const addUrl = () => `${appBaseUrl()}${PASSKEY_SETTINGS_PATH}`;
const ask = (pin: PresencePin): PresenceAsk => ({ pin, addUrl: addUrl() });

const refuse = (code: PresenceRefusal['code'], error: string, pin?: PresencePin, status: PresenceRefusal['status'] = 403): PresenceRefusal =>
  ({ ok: false, status, error, code, ...(pin ? { presence: ask(pin) } : {}) });

const WHAT: Record<PresencePin['op'], string> = {
  approve: 'approve a spec', retire: 'retire a spec', restore: 'restore a spec', confirm_import: 'confirm imported specs',
  team_passkey: 'change whether this team requires a passkey', add_passkey: 'add another passkey', remove_passkey: 'remove a passkey',
};

/** The team rule for one workspace, and how many passkeys the person has, in one round trip. */
async function workspaceRule(userId: string, workspaceId: string): Promise<{ required: boolean; keys: number }> {
  const [r] = rowsOf<{ required: boolean; keys: number }>(await db.execute(sql`
    SELECT t.spec_passkey_required AS required, (SELECT count(*)::int FROM user_passkeys WHERE user_id = ${userId}::uuid) AS keys
    FROM workspaces w JOIN teams t ON t.id = w.team_id WHERE w.id = ${workspaceId}::uuid`));
  return { required: r?.required === true, keys: Number(r?.keys ?? 0) };
}

/** Whether specs in this workspace need a passkey to approve, retire or restore. */
export async function specPasskeyRequired(workspaceId: string): Promise<boolean> {
  if (!isUuid(workspaceId)) return false;
  const [r] = rowsOf<{ required: boolean }>(await db.execute(sql`
    SELECT t.spec_passkey_required AS required FROM workspaces w JOIN teams t ON t.id = w.team_id WHERE w.id = ${workspaceId}::uuid`));
  return r?.required === true;
}

/**
 * The guard on a spec act. Null: go ahead (the team does not require a
 * passkey, or the assertion verified for exactly `pin` and is now spent).
 * Otherwise the refusal, and the caller writes nothing.
 */
export async function checkSpecPresence(userId: string, workspaceId: string, pin: PresencePin, proof: unknown): Promise<PresenceRefusal | null> {
  const rule = await workspaceRule(userId, workspaceId);
  if (!rule.required) return null;
  return requirePresence(userId, pin, proof, rule.keys, 'This team requires a passkey to');
}

async function requirePresence(userId: string, pin: PresencePin, proof: unknown, keys: number, lead: string): Promise<PresenceRefusal | null> {
  if (keys === 0) {
    return refuse('passkey_missing', `${lead} ${WHAT[pin.op]}, and you have no passkey. Add one in Settings › Profile › Passkeys, then try again. Nothing changed.`, pin);
  }
  if (proof === undefined || proof === null) {
    return refuse('presence_required', `${lead} ${WHAT[pin.op]}. Confirm with your passkey; nothing changes until you do.`, pin);
  }
  if (!(await verifyPresence(userId, pin, proof))) {
    return refuse('presence_failed', 'The passkey check did not pass: it was for something else, expired, or was already used. Nothing changed. Try again.', pin);
  }
  return null;
}

async function passkeyCount(userId: string): Promise<number> {
  const [r] = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM user_passkeys WHERE user_id = ${userId}::uuid`));
  return Number(r?.n ?? 0);
}

/** Store one challenge for `binding`, after clearing the person's expired ones. Null when they hold too many live ones. */
async function storeChallenge(userId: string, purpose: 'presence' | 'register', binding: string): Promise<string | null> {
  const challenge = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + PASSKEY_CHALLENGE_TTL_MS).toISOString();
  const rows = rowsOf<{ id: string }>(await db.execute(sql`
    WITH swept AS (
      DELETE FROM passkey_challenges WHERE user_id = ${userId}::uuid AND (expires_at < now() OR consumed_at IS NOT NULL)
    )
    INSERT INTO passkey_challenges (user_id, purpose, binding, challenge, expires_at)
    SELECT ${userId}::uuid, ${purpose}, ${binding}, ${challenge}, ${expires}::timestamptz
    WHERE (SELECT count(*) FROM passkey_challenges WHERE user_id = ${userId}::uuid AND consumed_at IS NULL AND expires_at >= now()) < ${MAX_LIVE_CHALLENGES}
    RETURNING id`));
  return rows.length ? challenge : null;
}

/** Spend the challenge a response answers, only if it was issued to this person for this binding and is live. */
async function consumeChallenge(userId: string, purpose: 'presence' | 'register', binding: string, response: unknown): Promise<string | null> {
  const challenge = challengeOf(response);
  if (!challenge) return null;
  const rows = rowsOf<{ challenge: string }>(await db.execute(sql`
    UPDATE passkey_challenges SET consumed_at = now()
    WHERE challenge = ${challenge} AND user_id = ${userId}::uuid AND purpose = ${purpose} AND binding = ${binding}
      AND consumed_at IS NULL AND expires_at > now()
    RETURNING challenge`));
  return rows[0]?.challenge ?? null;
}

/** A WebAuthn response's outer shape; the library checks everything inside it. */
function isCredentialResponse(r: unknown): r is { id: string; rawId: string; type: 'public-key'; response: Record<string, unknown> } {
  const o = r as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && typeof o.id === 'string' && o.id.length <= 1024 && typeof o.rawId === 'string'
    && o.type === 'public-key' && !!o.response && typeof o.response === 'object';
}

/** The browser's options for a presence assertion over `pin`. */
export async function issuePresenceChallenge(userId: string, pin: PresencePin): Promise<{ ok: true; options: PublicKeyCredentialRequestOptionsJSON } | PresenceRefusal> {
  const keys = await db.select({ credentialId: userPasskeys.credentialId, transports: userPasskeys.transports })
    .from(userPasskeys).where(eq(userPasskeys.userId, userId));
  if (!keys.length) return refuse('passkey_missing', 'You have no passkey. Add one in Settings › Profile › Passkeys.', pin);
  const challenge = await storeChallenge(userId, 'presence', presenceBinding(userId, 'presence', pin));
  if (!challenge) return refuse('passkey_limit', 'Too many passkey checks are open. Wait a few minutes, then try again.', undefined, 409);
  const { rpID } = passkeyRelyingParty();
  const options = await generateAuthenticationOptions({
    rpID, challenge: Buffer.from(challenge, 'base64url'), timeout: 120_000, userVerification: 'preferred',
    allowCredentials: keys.map((k) => ({ id: k.credentialId, transports: k.transports ?? undefined })),
  });
  return { ok: true, options };
}

/**
 * True when `proof` is an assertion, by one of this person's passkeys with the
 * user present, over a live challenge issued to them for exactly `pin`. The
 * challenge is spent first, so a response is counted at most once.
 */
export async function verifyPresence(userId: string, pin: PresencePin, proof: unknown): Promise<boolean> {
  if (!isCredentialResponse(proof)) return false;
  const challenge = await consumeChallenge(userId, 'presence', presenceBinding(userId, 'presence', pin), proof);
  if (!challenge) return false;
  const [key] = await db.select().from(userPasskeys)
    .where(and(eq(userPasskeys.userId, userId), eq(userPasskeys.credentialId, proof.id))).limit(1);
  if (!key) return false;
  const { rpID, origin } = passkeyRelyingParty();
  try {
    const v = await verifyAuthenticationResponse({
      response: proof as unknown as AuthenticationResponseJSON, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID,
      credential: { id: key.credentialId, publicKey: new Uint8Array(Buffer.from(key.publicKey, 'base64url')), counter: key.counter, transports: key.transports ?? undefined },
      requireUserVerification: false,
    });
    if (!v.verified) return false;
    await db.execute(sql`UPDATE user_passkeys SET counter = GREATEST(counter, ${v.authenticationInfo.newCounter}), last_used_at = now() WHERE id = ${key.id}::uuid`);
    return true;
  } catch {
    return false;
  }
}

// ── A person's passkeys ─────────────────────────────────────────────────────

export interface PasskeyView { id: string; name: string; createdAt: string; lastUsedAt: string | null }

export async function listPasskeys(userId: string): Promise<PasskeyView[]> {
  const rows = await db.select({ id: userPasskeys.id, name: userPasskeys.name, createdAt: userPasskeys.createdAt, lastUsedAt: userPasskeys.lastUsedAt })
    .from(userPasskeys).where(eq(userPasskeys.userId, userId)).orderBy(asc(userPasskeys.createdAt));
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt.toISOString(), lastUsedAt: r.lastUsedAt?.toISOString() ?? null }));
}

/** Whether changing this person's passkeys needs one of them: they have one, and a team of theirs requires passkeys. */
async function keysGuarded(userId: string): Promise<{ guarded: boolean; keys: number }> {
  const [r] = rowsOf<{ keys: number; guarded: boolean }>(await db.execute(sql`
    SELECT (SELECT count(*)::int FROM user_passkeys WHERE user_id = ${userId}::uuid) AS keys,
      EXISTS (
        SELECT 1 FROM teams t WHERE t.spec_passkey_required
          AND (t.personal_user_id = ${userId}::uuid OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = ${userId}::uuid))
      ) AS guarded`));
  const keys = Number(r?.keys ?? 0);
  return { keys, guarded: keys > 0 && r?.guarded === true };
}

/** The browser's options to create a passkey. */
export async function issueRegistrationChallenge(userId: string): Promise<{ ok: true; options: PublicKeyCredentialCreationOptionsJSON } | PresenceRefusal> {
  const [[user], existing] = await Promise.all([
    db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, userId)).limit(1),
    db.select({ credentialId: userPasskeys.credentialId, transports: userPasskeys.transports }).from(userPasskeys).where(eq(userPasskeys.userId, userId)),
  ]);
  if (!user) return refuse('passkey_invalid', 'Sign in again, then add the passkey.', undefined, 400);
  if (existing.length >= MAX_PASSKEYS) return refuse('passkey_limit', `You have ${MAX_PASSKEYS} passkeys, the most one person may add. Remove one first.`, undefined, 409);
  const challenge = await storeChallenge(userId, 'register', presenceBinding(userId, 'register', { op: 'add_passkey' }));
  if (!challenge) return refuse('passkey_limit', 'Too many passkey checks are open. Wait a few minutes, then try again.', undefined, 409);
  const { rpID, rpName } = passkeyRelyingParty();
  const options = await generateRegistrationOptions({
    rpName, rpID, userName: user.email ?? userId, userDisplayName: user.name?.trim() || user.email || 'buildd',
    userID: new Uint8Array(Buffer.from(userId, 'utf8')), challenge: Buffer.from(challenge, 'base64url'), timeout: 120_000,
    attestationType: 'none', authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    excludeCredentials: existing.map((k) => ({ id: k.credentialId, transports: k.transports ?? undefined })),
  });
  return { ok: true, options };
}

const NAME_MAX = 60;

/**
 * Store the passkey a registration response creates. When the person already
 * has one and a team of theirs requires passkeys, `presence` must be an
 * assertion by an existing one over `add_passkey`, checked before the
 * registration challenge is spent (so the browser can retry with it).
 */
export async function registerPasskey(userId: string, input: { response: unknown; name?: unknown; presence?: unknown }): Promise<{ ok: true; passkey: PasskeyView } | PresenceRefusal> {
  if (!isCredentialResponse(input.response)) return refuse('passkey_invalid', 'That passkey could not be read. Try again.', undefined, 400);
  const gate = await keysGuarded(userId);
  if (gate.keys >= MAX_PASSKEYS) return refuse('passkey_limit', `You have ${MAX_PASSKEYS} passkeys, the most one person may add. Remove one first.`, undefined, 409);
  if (gate.guarded) {
    const refused = await requirePresence(userId, { op: 'add_passkey' }, input.presence, gate.keys, 'Your team requires a passkey, so use one you already have to');
    if (refused) return refused;
  }
  const challenge = await consumeChallenge(userId, 'register', presenceBinding(userId, 'register', { op: 'add_passkey' }), input.response);
  if (!challenge) return refuse('passkey_invalid', 'That passkey request expired or was already used. Start again.', undefined, 400);
  const { rpID, origin } = passkeyRelyingParty();
  let info;
  try {
    const v = await verifyRegistrationResponse({
      response: input.response as unknown as RegistrationResponseJSON, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID,
      requireUserVerification: false,
    });
    if (!v.verified) return refuse('passkey_invalid', 'That passkey could not be verified. Try again.', undefined, 400);
    info = v.registrationInfo;
  } catch {
    return refuse('passkey_invalid', 'That passkey could not be verified. Try again.', undefined, 400);
  }
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, NAME_MAX) : 'Passkey';
  const [row] = await db.insert(userPasskeys).values({
    userId, name, credentialId: info.credential.id, publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
    counter: info.credential.counter, transports: info.credential.transports ?? null,
  }).onConflictDoNothing().returning();
  if (!row) return refuse('passkey_invalid', 'That passkey is already added.', undefined, 409);
  return { ok: true, passkey: { id: row.id, name: row.name, createdAt: row.createdAt.toISOString(), lastUsedAt: null } };
}

/** Remove one of the person's passkeys; guarded like adding one. */
export async function removePasskey(userId: string, passkeyId: string, presence: unknown): Promise<{ ok: true } | PresenceRefusal | { ok: false; status: 404; error: string }> {
  if (!isUuid(passkeyId)) return { ok: false, status: 404, error: 'Passkey not found' };
  const [key] = await db.select({ id: userPasskeys.id }).from(userPasskeys)
    .where(and(eq(userPasskeys.id, passkeyId), eq(userPasskeys.userId, userId))).limit(1);
  if (!key) return { ok: false, status: 404, error: 'Passkey not found' };
  const gate = await keysGuarded(userId);
  if (gate.guarded) {
    const refused = await requirePresence(userId, { op: 'remove_passkey', passkeyId }, presence, gate.keys, 'Your team requires a passkey, so use one to');
    if (refused) return refused;
  }
  await db.delete(userPasskeys).where(and(eq(userPasskeys.id, passkeyId), eq(userPasskeys.userId, userId)));
  return { ok: true };
}

// ── The team switch ─────────────────────────────────────────────────────────

/**
 * Turn the team's passkey requirement on or off. A team owner only, from a
 * dashboard session, with their own passkey either way: turning it on proves
 * the owner can pass it, and turning it off is the act an agent driving the
 * owner's browser would want most.
 */
export async function setTeamPasskeyRequired(userId: string, teamId: string, required: unknown, presence: unknown): Promise<{ ok: true; required: boolean } | PresenceRefusal | { ok: false; status: 400 | 403 | 404; error: string }> {
  if (!isUuid(teamId)) return { ok: false, status: 404, error: 'Team not found' };
  if (typeof required !== 'boolean') return { ok: false, status: 400, error: 'required (true or false) is required' };
  const role = await getUserTeamRole(userId, teamId);
  if (!role) return { ok: false, status: 404, error: 'Team not found' };
  if (!roleHas(role, 'require_spec_passkey')) return { ok: false, status: 403, error: 'Only a team owner can change whether a passkey is required.' };
  const [team] = await db.select({ required: teams.specPasskeyRequired }).from(teams).where(eq(teams.id, teamId)).limit(1);
  if (!team) return { ok: false, status: 404, error: 'Team not found' };
  if (team.required === required) return { ok: true, required };
  const refused = await requirePresence(userId, { op: 'team_passkey', teamId, required }, presence, await passkeyCount(userId), 'You need your own passkey to');
  if (refused) return refused;
  await db.update(teams).set({ specPasskeyRequired: required, updatedAt: new Date() }).where(eq(teams.id, teamId));
  return { ok: true, required };
}
