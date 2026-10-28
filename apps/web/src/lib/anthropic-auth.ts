import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { decrypt } from '@buildd/core/secrets';
import { teamCredentialWhere } from '@buildd/core/secrets/team-scope';
import { agentKeyPurposes, agentKeyStorageIndex, isAgentKeyRow } from '@buildd/core/providers/agent-keys';
import { and, eq, or, isNull, sql } from 'drizzle-orm';
import { recordCredentialAuthSuccess, recordCredentialAuthFailure } from './credential-health';
import { sqlWhere } from '@buildd/core/db/relational-sql';

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * Purposes that can authenticate a direct call to the Anthropic API: the
 * team's API key in either storage (canonical `inference_key` / `anthropic`,
 * legacy `anthropic_api_key`). A subscription login is never read here:
 * buildd does not use one server-side.
 */
const ANTHROPIC_KEY_PURPOSES = agentKeyPurposes('anthropic');

export interface AnthropicAuth {
  /** Ready-to-spread request headers, including `anthropic-version`. */
  headers: Record<string, string>;
  /** `inference_key` and `anthropic_api_key` are both the team's API key (x-api-key). */
  purpose: 'inference_key' | 'anthropic_api_key';
  secretId: string;
}

/** Is this resolved auth the team's metered API key (either storage)? Always true for what resolveAnthropicAuth returns. */
export function isAnthropicApiKeyAuth(auth: Pick<AnthropicAuth, 'purpose'>): boolean {
  return auth.purpose === 'inference_key' || auth.purpose === 'anthropic_api_key';
}

/**
 * Resolve headers for a server-side Anthropic API call from the team's stored
 * API key. Any web-app code path that wants to call Anthropic directly should
 * ask here first and treat `null` as "tell the operator to add an API key".
 *
 * Precedence mirrors the claim route:
 * - Workspace-scoped row over team-wide.
 * - Within a scope, a non-revoked row over a revoked one, then the canonical
 *   storage over the legacy alias, then most recently updated — so a stale
 *   leftover can never shadow a healthy credential.
 *
 * A revoked row is still returned when it is the only one: for a read-only call
 * like listing models, trying it and degrading on a non-200 beats refusing.
 */
export async function resolveAnthropicAuth(opts: {
  teamId: string;
  workspaceId?: string | null;
}): Promise<AnthropicAuth | null> {
  // Team rows only (user_id IS NULL): a person's own key is never the team's.
  const rows = (await db.query.secrets.findMany({
    where: sqlWhere(teamCredentialWhere(
      { teamId: opts.teamId, purpose: [...ANTHROPIC_KEY_PURPOSES] },
      or(
        isNull(secrets.workspaceId),
        opts.workspaceId ? eq(secrets.workspaceId, opts.workspaceId) : sql`false`,
      ),
    )),
    columns: {
      id: true, purpose: true, label: true, userId: true, encryptedValue: true,
      workspaceId: true, healthStatus: true, updatedAt: true,
    },
  })) as Array<{
    id: string; purpose: string; label?: string | null; userId?: string | null; encryptedValue: string;
    workspaceId: string | null; healthStatus: string | null; updatedAt: Date | null;
  }>;

  // `inference_key` is shared by every provider: only the `anthropic` label is ours.
  const best = rows
    .filter(r => !r.userId && isAgentKeyRow(r, 'anthropic'))
    .sort((a, b) =>
      // Workspace-specific beats team-wide.
      (b.workspaceId === opts.workspaceId ? 1 : 0) - (a.workspaceId === opts.workspaceId ? 1 : 0) ||
      ((a.healthStatus as string) === 'revoked' ? 1 : 0) - ((b.healthStatus as string) === 'revoked' ? 1 : 0) ||
      agentKeyStorageIndex(a, 'anthropic') - agentKeyStorageIndex(b, 'anthropic') ||
      (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0)
    )[0];

  if (!best) return null;

  let value: string;
  try {
    value = decrypt(best.encryptedValue);
  } catch (e) {
    console.error(`[anthropic-auth] failed to decode secret ${best.id} for Anthropic auth:`, e);
    return null;
  }
  if (!value) return null;

  return {
    headers: { 'anthropic-version': ANTHROPIC_API_VERSION, 'x-api-key': value },
    purpose: best.purpose as AnthropicAuth['purpose'],
    secretId: best.id,
  };
}

export interface AnthropicVerifyResult {
  verified: boolean;
  error: string | null;
}

/**
 * Smoke-test a stored Anthropic API key (either storage) with a lightweight
 * GET /v1/models. Persists the outcome to lastVerifiedAt / lastVerificationError
 * and updates health state. A subscription login is not verified here.
 */
export async function verifyAnthropicApiKey(secretId: string): Promise<AnthropicVerifyResult> {
  const row = await db.query.secrets.findFirst({
    where: sqlWhere(and(eq(secrets.id, secretId), or(...ANTHROPIC_KEY_PURPOSES.map((p) => eq(secrets.purpose, p))))),
    columns: { encryptedValue: true, purpose: true, label: true, userId: true },
  });

  // `inference_key` also holds other providers' keys and personal keys.
  if (!row || row.userId || !isAgentKeyRow(row, 'anthropic')) return { verified: false, error: 'Credential not found' };

  let key: string;
  try {
    key = decrypt(row.encryptedValue);
  } catch {
    return { verified: false, error: 'Failed to decrypt credential' };
  }

  let verified: boolean;
  let error: string | null = null;
  try {
    const res = await fetch(ANTHROPIC_MODELS_URL, {
      headers: { 'anthropic-version': ANTHROPIC_API_VERSION, 'x-api-key': key },
    });
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

  await db
    .update(secrets)
    .set({ lastVerifiedAt: sql`NOW()`, lastVerificationError: error, updatedAt: sql`NOW()` })
    .where(eq(secrets.id, secretId));

  if (verified) await recordCredentialAuthSuccess(secretId);
  else if (error) await recordCredentialAuthFailure(secretId, error);

  return { verified, error };
}
