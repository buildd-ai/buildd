/**
 * Claude credential verification.
 *
 * Smoke-tests a stored oauth_token or anthropic_api_key against the Anthropic
 * models endpoint. Outcome is persisted to lastVerifiedAt / lastVerificationError
 * and updates the credential's health state via credential-health.ts.
 */

import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { and, eq, or } from 'drizzle-orm';
import { decrypt } from '@buildd/core/secrets';
import { sql } from 'drizzle-orm';
import { recordCredentialAuthSuccess, recordCredentialAuthFailure } from './credential-health';

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_API_VERSION = '2023-06-01';

export interface ClaudeVerifyResult {
  verified: boolean;
  error: string | null;
}

/**
 * Smoke-test a stored Claude credential (oauth_token or anthropic_api_key).
 *
 * Makes a lightweight authenticated call to GET /v1/models, persists the
 * outcome to lastVerifiedAt / lastVerificationError, and updates health state.
 */
export async function verifyClaudeCredential(secretId: string): Promise<ClaudeVerifyResult> {
  const row = await db.query.secrets.findFirst({
    where: and(
      eq(secrets.id, secretId),
      or(eq(secrets.purpose, 'oauth_token'), eq(secrets.purpose, 'anthropic_api_key')),
    ),
    columns: { encryptedValue: true, purpose: true },
  });

  if (!row) return { verified: false, error: 'Credential not found' };

  let credentialValue: string;
  try {
    credentialValue = decrypt(row.encryptedValue);
  } catch {
    return { verified: false, error: 'Failed to decrypt credential' };
  }

  let verified: boolean;
  let error: string | null = null;

  try {
    const headers: Record<string, string> = {
      'anthropic-version': ANTHROPIC_API_VERSION,
    };

    if (row.purpose === 'anthropic_api_key') {
      headers['x-api-key'] = credentialValue;
    } else {
      // oauth_token uses Bearer authorization
      headers['Authorization'] = `Bearer ${credentialValue}`;
    }

    const res = await fetch(ANTHROPIC_MODELS_URL, { headers });

    if (res.ok) {
      verified = true;
    } else {
      verified = false;
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json() as Record<string, unknown>;
        const errObj = body.error as Record<string, unknown> | undefined;
        const msg = errObj?.message ?? errObj?.type;
        if (typeof msg === 'string') detail += `: ${msg}`;
      } catch {
        // ignore JSON parse error
      }
      error = detail;
    }
  } catch (err) {
    verified = false;
    error = err instanceof Error ? err.message : 'Network error';
  }

  // Persist verification outcome
  await db
    .update(secrets)
    .set({
      lastVerifiedAt: sql`NOW()`,
      lastVerificationError: error,
      updatedAt: sql`NOW()`,
    })
    .where(eq(secrets.id, secretId));

  // Update health state based on verification outcome
  if (verified) {
    await recordCredentialAuthSuccess(secretId);
  } else if (error) {
    await recordCredentialAuthFailure(secretId, error);
  }

  return { verified, error };
}
