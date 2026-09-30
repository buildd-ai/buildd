/**
 * DB half of the Cloudflare credential (purpose `cloudflare_token`). The pure
 * parse / mask / verify logic lives in ./cloudflare-credential-shared.ts.
 */
import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { decrypt } from '@buildd/core/secrets';
import { and, eq, isNull, desc } from 'drizzle-orm';
import { recordCredentialAuthSuccess } from './credential-health';
import {
  CLOUDFLARE_PURPOSE,
  parseCloudflareCredential,
  verifyCloudflareToken,
  type CloudflareCredential,
  type CloudflareVerifyResult,
  type FetchLike,
} from './cloudflare-credential-shared';

export * from './cloudflare-credential-shared';

// ── DB ────────────────────────────────────────────────────────────────────────

/** The team's team-wide Cloudflare credential row, newest first. */
export async function findCloudflareSecret(teamId: string) {
  return db.query.secrets.findFirst({
    where: and(
      eq(secrets.teamId, teamId),
      eq(secrets.purpose, CLOUDFLARE_PURPOSE),
      isNull(secrets.workspaceId),
      isNull(secrets.userId),
    ),
    orderBy: desc(secrets.updatedAt),
    columns: {
      id: true, teamId: true, encryptedValue: true, healthStatus: true,
      lastVerifiedAt: true, lastVerificationError: true, createdAt: true, updatedAt: true,
    },
  });
}

/** Decrypt and parse a stored value. Null when it cannot be read. */
export function decodeCloudflareValue(encryptedValue: string): CloudflareCredential | null {
  try {
    const parsed = parseCloudflareCredential(decrypt(encryptedValue));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

/**
 * Verify a stored credential and record the outcome on the row
 * (lastVerifiedAt / lastVerificationError, and health). A rejection marks the
 * row revoked; a network error leaves health alone.
 */
export async function verifyCloudflareCredential(secretId: string, fetchImpl: FetchLike = fetch): Promise<CloudflareVerifyResult> {
  const row = await db.query.secrets.findFirst({
    where: and(eq(secrets.id, secretId), eq(secrets.purpose, CLOUDFLARE_PURPOSE)),
    columns: { encryptedValue: true },
  });
  if (!row) return { verified: false, error: 'Credential not found' };
  const cred = decodeCloudflareValue(row.encryptedValue);
  if (!cred) return { verified: false, error: 'Failed to decrypt credential' };

  const result = await verifyCloudflareToken(cred, fetchImpl);
  const now = new Date();
  await db
    .update(secrets)
    .set({ lastVerifiedAt: now, lastVerificationError: result.error, updatedAt: now })
    .where(eq(secrets.id, secretId));

  if (result.verified) {
    await recordCredentialAuthSuccess(secretId);
  } else if (result.rejected) {
    await db
      .update(secrets)
      .set({
        healthStatus: 'revoked',
        lastFailureAt: now,
        lastFailureMessage: (result.error ?? 'rejected').slice(0, 500),
        updatedAt: now,
      })
      .where(eq(secrets.id, secretId));
  }
  return result;
}
