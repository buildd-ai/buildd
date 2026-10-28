import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { decrypt } from '@buildd/core/secrets';
import { and, eq, or, isNull, sql } from 'drizzle-orm';
import { recordCredentialAuthSuccess, recordCredentialAuthFailure } from './credential-health';
import { sqlWhere } from '@buildd/core/db/relational-sql';

// A Codex API key lives in a `codex_credential` row as a `{ api_key }` blob
// (docs/credentials-architecture.md). A row holding a ChatGPT login is never
// read: buildd does not store, refresh or serve one.
const PURPOSE = 'codex_credential' as const;
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

function apiKeyOf(encryptedValue: string): string | null {
  const blob = JSON.parse(decrypt(encryptedValue)) as { api_key?: unknown };
  return typeof blob.api_key === 'string' && blob.api_key.length > 0 ? blob.api_key : null;
}

/**
 * Resolve the most-specific Codex API key visible to a task: workspace-scoped
 * beats account-scoped beats team-wide. Used at claim time.
 *
 * Revoked rows, rows that do not decrypt and rows with no `api_key` are
 * skipped, so a login row never hides a less specific API-key row.
 */
export async function resolveCodexApiKey(opts: {
  teamId: string;
  /**
   * `'any'` ignores account scoping: "could ANY runner in this team be handed
   * an API key?". Read-only readiness reporting (backend failover) asks that
   * form; a claim always passes its own account.
   */
  accountId?: string | null | 'any';
  workspaceId?: string | null;
}): Promise<{ apiKey: string } | null> {
  const anyAccount = opts.accountId === 'any';
  const rows = await db.query.secrets.findMany({
    where: sqlWhere(and(
      eq(secrets.teamId, opts.teamId),
      eq(secrets.purpose, PURPOSE),
      ...(anyAccount
        ? []
        : [or(isNull(secrets.accountId), opts.accountId ? eq(secrets.accountId, opts.accountId) : sql`false`)]),
      or(isNull(secrets.workspaceId), opts.workspaceId ? eq(secrets.workspaceId, opts.workspaceId) : sql`false`),
    )),
    columns: { encryptedValue: true, accountId: true, workspaceId: true, healthStatus: true },
  });

  // Specificity: workspace match (2) outranks account match (1) outranks team-wide (0).
  const score = (r: { accountId: string | null; workspaceId: string | null }) =>
    (r.workspaceId && r.workspaceId === opts.workspaceId ? 2 : 0) +
    (r.accountId && r.accountId === opts.accountId ? 1 : 0);
  const ranked = rows
    .filter((r) => (r.healthStatus as string) !== 'revoked')
    .sort((a, b) => score(b) - score(a));

  for (const row of ranked) {
    try {
      const apiKey = apiKeyOf(row.encryptedValue);
      if (apiKey) return { apiKey };
    } catch (err) {
      console.warn('[Codex] Failed to decrypt credential in resolveCodexApiKey:', err instanceof Error ? err.message : 'unknown');
    }
  }
  return null;
}

export interface CodexVerifyResult {
  verified: boolean;
  error: string | null;
}

/**
 * Smoke-test a stored Codex API key with GET /v1/models. A row holding a
 * ChatGPT login is reported as unverifiable: buildd does not exercise one.
 * Persists lastVerifiedAt / lastVerificationError. Never logs the key.
 */
export async function verifyCodexApiKey(secretId: string): Promise<CodexVerifyResult> {
  const row = await db.query.secrets.findFirst({
    where: sqlWhere(and(eq(secrets.id, secretId), eq(secrets.purpose, PURPOSE))),
    columns: { encryptedValue: true },
  });
  if (!row) return { verified: false, error: 'Credential not found' };

  let apiKey: string | null;
  try {
    apiKey = apiKeyOf(row.encryptedValue);
  } catch {
    return { verified: false, error: 'Failed to decrypt credential' };
  }
  if (!apiKey) return { verified: false, error: 'Only an API key can be verified. Run `codex login` on the runner instead.' };

  let verified: boolean;
  let error: string | null = null;
  try {
    const res = await fetch(OPENAI_MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (res.ok) {
      verified = true;
    } else {
      verified = false;
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json() as Record<string, unknown>;
        const msg = (body.error as Record<string, unknown> | undefined)?.message;
        if (typeof msg === 'string') detail += `: ${msg}`;
      } catch {
        // ignore json parse error
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
    .where(and(eq(secrets.id, secretId), eq(secrets.purpose, PURPOSE)));

  if (verified) await recordCredentialAuthSuccess(secretId);
  else if (error) await recordCredentialAuthFailure(secretId, error);

  return { verified, error };
}
