/**
 * Signing key service for the cross-app assertion grant.
 *
 * Keys are P-256 (ES256) ECDSA keypairs stored in the `secrets` table with
 * purpose='signing_key'. Only public key material is ever returned to callers
 * outside this module; private keys are kept in memory only long enough to
 * sign an assertion.
 *
 * Key lifecycle per spec §B.2–B.3:
 *   Active (< 30d): appears in JWKS, used for new assertions
 *   Retiring (30–40d): still in JWKS, no new assertions
 *   Revoked (> 40d or tokenExpiresAt expired): removed from DB by rotation cron
 */

import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { eq, and, isNull, or, gt } from 'drizzle-orm';
import { getSecretsProvider } from '@buildd/core/secrets';

/**
 * kid format: 'buildd-YYYY-MM-<suffix>'.
 *
 * The month prefix stays for readability, but a month is not unique: a forced
 * rotation (?force=true skips the 30-day age check) or a concurrent JWKS
 * bootstrap can mint two keys in the same month, and no DB index prevents it.
 * Two JWKS entries sharing one kid make verifier key selection ambiguous, so
 * the suffix distinguishes them: millisecond-of-month (derived from the
 * creation time) plus 4 random chars for same-instant mints.
 *
 * Existing bare 'buildd-YYYY-MM' kids keep working — nothing parses the kid,
 * it is only ever compared by exact value against the stored label.
 */
export function makeKid(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const msOfMonth = now.getTime() - Date.UTC(y, now.getUTCMonth(), 1);
  const stamp = msOfMonth.toString(36);
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 4);
  return `buildd-${y}-${m}-${stamp}${rand}`;
}

export interface KeyPairJwk {
  privateKeyJwk: JsonWebKey;
  publicKeyJwk: JsonWebKey;
}

/** Generate a fresh P-256 keypair and return both components as JWK. */
export async function generateSigningKeypair(kid: string): Promise<KeyPairJwk> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );

  const [privateKeyJwk, publicKeyJwk] = await Promise.all([
    crypto.subtle.exportKey('jwk', keyPair.privateKey),
    crypto.subtle.exportKey('jwk', keyPair.publicKey),
  ]);

  // Annotate with our metadata fields (cast because JsonWebKey TS type lacks kid)
  (privateKeyJwk as Record<string, unknown>).kid = kid;
  privateKeyJwk.alg = 'ES256';
  (publicKeyJwk as Record<string, unknown>).kid = kid;
  publicKeyJwk.alg = 'ES256';
  publicKeyJwk.use = 'sig';

  return { privateKeyJwk, publicKeyJwk };
}

/**
 * Retrieve and decrypt the Active signing key (tokenExpiresAt IS NULL).
 * Returns null if no Active key exists.
 */
export async function getActiveSigningKey(): Promise<{
  id: string;
  kid: string;
  privateKeyJwk: JsonWebKey;
  publicKeyJwk: JsonWebKey;
  createdAt: Date;
} | null> {
  const provider = getSecretsProvider();

  const row = await db.query.secrets.findFirst({
    where: and(
      eq(secrets.purpose, 'signing_key'),
      isNull(secrets.tokenExpiresAt),
    ),
    columns: { id: true, label: true, createdAt: true },
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });

  if (!row || !row.label) return null;

  const raw = await provider.get(row.id);
  if (!raw) return null;

  const kp: KeyPairJwk = JSON.parse(raw);
  return {
    id: row.id,
    kid: row.label,
    privateKeyJwk: kp.privateKeyJwk,
    publicKeyJwk: kp.publicKeyJwk,
    createdAt: row.createdAt,
  };
}

/**
 * Retrieve all public keys (Active + Retiring) for the JWKS endpoint.
 * Returns only public key material — private keys are never included.
 *
 * Publication is gated on expiry here, not just by the rotation cron's delete
 * step: a key is published when tokenExpiresAt IS NULL (Active) or is still in
 * the future (Retiring, so assertions signed before rotation still verify).
 * An expired key is never published even if the deleter has not run.
 */
export async function getAllPublicKeys(): Promise<Array<{
  kid: string;
  publicKeyJwk: JsonWebKey;
}>> {
  const provider = getSecretsProvider();
  const now = new Date();

  const rows = await db.query.secrets.findMany({
    where: and(
      eq(secrets.purpose, 'signing_key'),
      or(
        isNull(secrets.tokenExpiresAt),
        gt(secrets.tokenExpiresAt, now),
      ),
    ),
    columns: { id: true, label: true },
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });

  const results: Array<{ kid: string; publicKeyJwk: JsonWebKey }> = [];
  for (const row of rows) {
    if (!row.label) continue;
    const raw = await provider.get(row.id);
    if (!raw) continue;
    const kp: KeyPairJwk = JSON.parse(raw);
    results.push({ kid: row.label, publicKeyJwk: kp.publicKeyJwk });
  }
  return results;
}

/**
 * The team ID that owns signing keys. Set via BUILDD_SIGNING_KEY_TEAM_ID env
 * var — must be the UUID of the buildd system team in the database.
 */
function getSigningKeyTeamId(): string {
  const teamId = process.env.BUILDD_SIGNING_KEY_TEAM_ID;
  if (!teamId) {
    throw new Error('BUILDD_SIGNING_KEY_TEAM_ID env var must be set to store signing keys');
  }
  return teamId;
}

/**
 * Generate + persist a new Active signing key.
 * Call this when no Active key exists (first boot or after rotation).
 */
export async function createActiveSigningKey(now: Date): Promise<string> {
  const kid = makeKid(now);
  const kp = await generateSigningKeypair(kid);
  const provider = getSecretsProvider();
  const secretId = await provider.set(null, JSON.stringify(kp), {
    teamId: getSigningKeyTeamId(),
    purpose: 'signing_key',
    label: kid,
  });
  return secretId;
}

/** Sign a payload object as a compact JWS (ES256). */
export async function signAssertion(
  payload: Record<string, unknown>,
  privateKeyJwk: JsonWebKey,
  kid: string,
): Promise<string> {
  const header = { alg: 'ES256', kid, typ: 'JWT' };

  const encodeB64Url = (buf: ArrayBuffer | Uint8Array) => {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  };

  const encodeJson = (obj: object) =>
    encodeB64Url(new TextEncoder().encode(JSON.stringify(obj)));

  const headerB64 = encodeJson(header);
  const payloadB64 = encodeJson(payload);
  const signingInput = `${headerB64}.${payloadB64}`;

  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privateKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signingInput).buffer as ArrayBuffer,
  );

  return `${signingInput}.${encodeB64Url(sigBuf)}`;
}
