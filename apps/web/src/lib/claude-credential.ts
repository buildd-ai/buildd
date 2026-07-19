import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { encrypt, decrypt } from '@buildd/core/secrets';
import { eq, and, or, isNull, lt, sql } from 'drizzle-orm';
import { recordCredentialAuthSuccess, recordCredentialAuthFailure } from './credential-health';

const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_API_VERSION = '2023-06-01';
// Claude Code OAuth client ID (from sdk.mjs sC.CLIENT_ID)
const CLAUDE_OAUTH_CLIENT_ID = process.env.CLAUDE_OAUTH_CLIENT_ID ?? '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const PURPOSE = 'claude_credential' as const;

// ── Input type ────────────────────────────────────────────────────────────────

/**
 * Shape of ~/.claude/.credentials.json written by the Claude Code SDK.
 * Users paste this to connect a managed Claude OAuth credential.
 */
export interface ClaudeCredentialsJson {
  type?: string;       // "oauth_token"
  access_token: string;
  refresh_token: string;
  /** Epoch seconds when the access_token expires. */
  expires_at?: number;
  version?: number;
}

/** Encrypted-at-rest payload in secrets.encryptedValue. */
interface ClaudeBlob {
  access_token: string;
  refresh_token: string;
}

// ── Scope ─────────────────────────────────────────────────────────────────────

export interface ClaudeScope {
  teamId: string;
  workspaceId?: string | null;
}

// ── Status ────────────────────────────────────────────────────────────────────

export interface ClaudeStatus {
  connected: boolean;
  expired: boolean;
  lastRefreshedAt: string | null;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  scope: 'team' | 'workspace' | null;
}

// ── Resolved credential (returned at claim time) ──────────────────────────────

export interface ClaudeCredential {
  accessToken: string;
  tokenExpiresAt: Date | null;
  lastRefreshedAt: Date | null;
}

export type RefreshResult = 'refreshed' | 'locked' | 'no_credential' | 'error';

// ── Verify result ─────────────────────────────────────────────────────────────

export interface ClaudeVerifyResult {
  verified: boolean;
  error: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function encodeBlob(blob: ClaudeBlob): string {
  return encrypt(JSON.stringify(blob));
}

function decodeBlob(encryptedValue: string): ClaudeBlob {
  return JSON.parse(decrypt(encryptedValue)) as ClaudeBlob;
}

function expiresAtToDate(expiresAt: number | undefined): Date | null {
  if (expiresAt == null) return null;
  return new Date(expiresAt * 1000);
}

/** Exact-scope match (NULL-aware) for workspaceId. */
function scopeMatch(scope: ClaudeScope) {
  return and(
    eq(secrets.teamId, scope.teamId),
    eq(secrets.purpose, PURPOSE),
    scope.workspaceId ? eq(secrets.workspaceId, scope.workspaceId) : isNull(secrets.workspaceId),
  );
}

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Normalize whatever the user pasted into a ClaudeCredentialsJson.
 * Accepts the raw ~/.claude/.credentials.json content.
 */
export function normalizeClaudeCredentialsJson(
  parsed: unknown,
): { ok: true; value: ClaudeCredentialsJson } | { ok: false; error: string } {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Must be a JSON object' };
  }
  const root = parsed as Record<string, unknown>;
  const access_token = root.access_token;
  const refresh_token = root.refresh_token;
  if (typeof access_token !== 'string' || access_token.length === 0) {
    return { ok: false, error: 'Must contain access_token' };
  }
  if (typeof refresh_token !== 'string' || refresh_token.length === 0) {
    return { ok: false, error: 'Must contain refresh_token' };
  }
  const value: ClaudeCredentialsJson = { access_token, refresh_token };
  if (typeof root.type === 'string') value.type = root.type;
  if (typeof root.expires_at === 'number') value.expires_at = root.expires_at;
  if (typeof root.version === 'number') value.version = root.version;
  return { ok: true, value };
}

// ── Storage ───────────────────────────────────────────────────────────────────

/**
 * Store (replace) the Claude credential at an exact scope. One credential per
 * scope — any existing row is removed first.
 */
export async function storeClaudeCredential(
  scope: ClaudeScope,
  credential: ClaudeCredentialsJson,
): Promise<void> {
  const encryptedValue = encodeBlob({
    access_token: credential.access_token,
    refresh_token: credential.refresh_token,
  });
  const tokenExpiresAt = expiresAtToDate(credential.expires_at);
  const now = new Date();

  await db.delete(secrets).where(scopeMatch(scope));
  await db.insert(secrets).values({
    teamId: scope.teamId,
    workspaceId: scope.workspaceId ?? null,
    accountId: null,
    purpose: PURPOSE,
    encryptedValue,
    tokenExpiresAt,
    lastRefreshedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * Resolve the most-specific Claude credential: workspace-scoped beats team-wide.
 * Returns null when no credential exists. Used at claim time.
 */
export async function resolveClaudeCredential(opts: {
  teamId: string;
  workspaceId?: string | null;
}): Promise<ClaudeCredential | null> {
  const rows = await db.query.secrets.findMany({
    where: and(
      eq(secrets.teamId, opts.teamId),
      eq(secrets.purpose, PURPOSE),
      or(isNull(secrets.workspaceId), opts.workspaceId ? eq(secrets.workspaceId, opts.workspaceId) : sql`false`),
    ),
    columns: { encryptedValue: true, workspaceId: true, tokenExpiresAt: true, lastRefreshedAt: true },
  });
  if (rows.length === 0) return null;

  // Workspace-specific row wins over team-wide.
  const score = (r: { workspaceId: string | null }) =>
    r.workspaceId && r.workspaceId === opts.workspaceId ? 1 : 0;
  const best = rows.reduce((a, b) => (score(b) > score(a) ? b : a));

  const blob = decodeBlob(best.encryptedValue);
  return {
    accessToken: blob.access_token,
    tokenExpiresAt: best.tokenExpiresAt ?? null,
    lastRefreshedAt: best.lastRefreshedAt ?? null,
  };
}

/** True when a Claude credential exists for this scope. */
export async function hasClaudeCredential(opts: {
  teamId: string;
  workspaceId?: string | null;
}): Promise<boolean> {
  const rows = await db.query.secrets.findMany({
    where: and(
      eq(secrets.teamId, opts.teamId),
      eq(secrets.purpose, PURPOSE),
      or(isNull(secrets.workspaceId), opts.workspaceId ? eq(secrets.workspaceId, opts.workspaceId) : sql`false`),
    ),
    columns: { id: true },
  });
  return rows.length > 0;
}

/** Connection status (no token values) for an exact scope. */
export async function getClaudeStatus(scope: ClaudeScope): Promise<ClaudeStatus> {
  const row = await db.query.secrets.findFirst({
    where: scopeMatch(scope),
    columns: {
      workspaceId: true,
      tokenExpiresAt: true,
      lastRefreshedAt: true,
      lastVerifiedAt: true,
      lastVerificationError: true,
    },
  });

  if (!row) {
    return {
      connected: false,
      expired: false,
      lastRefreshedAt: null,
      lastVerifiedAt: null,
      lastVerificationError: null,
      scope: null,
    };
  }

  const expired = row.tokenExpiresAt != null && row.tokenExpiresAt < new Date();
  return {
    connected: true,
    expired,
    lastRefreshedAt: row.lastRefreshedAt ? row.lastRefreshedAt.toISOString() : null,
    lastVerifiedAt: row.lastVerifiedAt ? row.lastVerifiedAt.toISOString() : null,
    lastVerificationError: row.lastVerificationError ?? null,
    scope: row.workspaceId ? 'workspace' : 'team',
  };
}

/** Remove the Claude credential at an exact scope. */
export async function deleteClaudeCredential(scope: ClaudeScope): Promise<void> {
  await db.delete(secrets).where(scopeMatch(scope));
}

/** Secret id of the Claude credential at an exact scope, or null. Used by the refresh route. */
export async function getClaudeSecretId(scope: ClaudeScope): Promise<string | null> {
  const row = await db.query.secrets.findFirst({
    where: scopeMatch(scope),
    columns: { id: true },
  });
  return row?.id ?? null;
}

// ── Refresh ───────────────────────────────────────────────────────────────────

/**
 * Server-side refresh of the Claude OAuth tokens for one secret row.
 *
 * Uses a DB-level optimistic lock on `lastRefreshedAt` so only one caller
 * refreshes per 60-minute window. Anthropic ROTATES the refresh token on each
 * use — the new refresh token is always persisted.
 *
 * Must NOT be called from worker processes — server-only. Workers receive only
 * the access_token (via claudeAccessToken on the claim response) and never
 * have a refresh_token to rotate.
 */
export async function refreshClaudeCredential(secretId: string): Promise<RefreshResult> {
  // Atomically claim the refresh lock.
  const [claimed] = await db
    .update(secrets)
    .set({ lastRefreshedAt: sql`NOW()`, updatedAt: sql`NOW()` })
    .where(
      and(
        eq(secrets.id, secretId),
        eq(secrets.purpose, PURPOSE),
        or(
          isNull(secrets.lastRefreshedAt),
          lt(secrets.lastRefreshedAt, sql`NOW() - INTERVAL '60 minutes'`),
        ),
      ),
    )
    .returning();

  if (!claimed) {
    const exists = await db.query.secrets.findFirst({
      where: and(eq(secrets.id, secretId), eq(secrets.purpose, PURPOSE)),
      columns: { id: true },
    });
    return exists ? 'locked' : 'no_credential';
  }

  const blob = decodeBlob(claimed.encryptedValue);
  if (!blob.refresh_token) return 'no_credential';

  try {
    const res = await fetch(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: blob.refresh_token,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
      }),
    });

    if (!res.ok) {
      const detail = `HTTP ${res.status}`;
      console.warn(`[Claude] Token refresh failed for secret ${secretId}: ${detail}`);
      if (res.status === 400 || res.status === 401) {
        await db
          .update(secrets)
          .set({ tokenExpiresAt: null, lastVerificationError: detail, updatedAt: sql`NOW()` })
          .where(and(eq(secrets.id, secretId), eq(secrets.purpose, PURPOSE)));
        await recordCredentialAuthFailure(secretId, detail);
      }
      return 'error';
    }

    const tokens = await res.json() as Record<string, unknown>;
    const newAccessToken = typeof tokens.access_token === 'string' ? tokens.access_token : blob.access_token;
    // CRITICAL: always persist the rotated refresh token.
    const newRefreshToken = typeof tokens.refresh_token === 'string'
      ? tokens.refresh_token
      : blob.refresh_token;

    // Claude SDK returns expires_at (epoch seconds), not expires_in
    let tokenExpiresAt: Date | null = null;
    if (typeof tokens.expires_at === 'number') {
      tokenExpiresAt = new Date(tokens.expires_at * 1000);
    } else if (typeof tokens.expires_in === 'number') {
      tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    }

    await db
      .update(secrets)
      .set({
        encryptedValue: encodeBlob({ access_token: newAccessToken, refresh_token: newRefreshToken }),
        tokenExpiresAt,
        lastVerificationError: null,
        updatedAt: sql`NOW()`,
      })
      .where(eq(secrets.id, secretId));

    await recordCredentialAuthSuccess(secretId);
    console.log(`[Claude] Token refreshed for secret ${secretId}`);
    return 'refreshed';
  } catch (err) {
    console.warn(`[Claude] Token refresh error for secret ${secretId}:`, err instanceof Error ? err.message : 'unknown');
    return 'error';
  }
}

// ── Verify (smoke-test existing oauth_token / anthropic_api_key) ──────────────

/**
 * Smoke-test a stored Claude credential (oauth_token or anthropic_api_key).
 *
 * Makes a lightweight authenticated call to GET /v1/models, persists the
 * outcome to lastVerifiedAt / lastVerificationError, and updates health state.
 * Used by the cron job to catch out-of-band revocations between worker spawns.
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
