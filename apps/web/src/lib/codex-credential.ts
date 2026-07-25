import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { encrypt, decrypt } from '@buildd/core/secrets';
import { eq, and, or, isNull, lt, sql } from 'drizzle-orm';
import { recordCredentialAuthSuccess, recordCredentialAuthFailure } from './credential-health';

const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const PURPOSE = 'codex_credential' as const;

export interface CodexAuthJson {
  /** OAuth fields (required for OAuth credentials) */
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
  /** id_token — REQUIRED by codex-cli 0.144's auth.json parser (verified live). */
  id_token?: string;
  /** API key (alternative to OAuth — simpler rotation, recommended for CI/automation) */
  api_key?: string;
  /** seconds until expiry (Codex device-code flow) */
  expires_in?: number;
  /** ISO timestamp expiry (alternative to expires_in) */
  expiry?: string;
}

export interface CodexStatus {
  connected: boolean;
  expired: boolean;
  accountId: string | null;
  lastRefreshedAt: string | null;
  /** Last time the credential was smoke-tested against the provider API. */
  lastVerifiedAt: string | null;
  /** Error from the last verification attempt, or null if it passed. */
  lastVerificationError: string | null;
  /** Where the connected credential is scoped: 'team' (all workspaces) or 'workspace'. */
  scope: 'team' | 'workspace' | null;
}

/** Decode a JWT's `exp` (epoch seconds) without verifying the signature. */
function jwtExpSeconds(token: unknown): number | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Normalize whatever the user pasted into a CodexAuthJson. Accepts:
 *   - the raw `~/.codex/auth.json` (fields nested under a `tokens` object), or
 *   - an already-flat object with top-level fields (OAuth), or
 *   - `{"api_key": "sk-..."}` for API-key auth (recommended for CI/automation).
 *
 * Expiry is resolved in priority order: explicit `expires_in` / `expiry`, then the
 * access-token JWT `exp` claim. If none can be derived, the credential is still
 * accepted with no expiry (it works until it 401s; the refresh cron skips it).
 *
 * Returns the normalized value or a human-readable error — never throws.
 */
export function normalizeCodexAuthJson(parsed: unknown): { ok: true; value: CodexAuthJson } | { ok: false; error: string } {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Must be a JSON object' };
  }
  const root = parsed as Record<string, unknown>;

  // API key path: `{"api_key": "sk-..."}` — no OAuth fields required.
  // API keys are the recommended path for CI/automation (stable, explicit rotation).
  if (typeof root.api_key === 'string' && root.api_key.length > 0) {
    return { ok: true, value: { api_key: root.api_key } };
  }

  // Codex CLI nests credentials under `tokens`; fall back to top-level (flat) shape.
  const src = (root.tokens && typeof root.tokens === 'object' ? root.tokens : root) as Record<string, unknown>;

  const access_token = src.access_token;
  const refresh_token = src.refresh_token;
  const account_id = src.account_id;
  if (typeof access_token !== 'string' || typeof refresh_token !== 'string' || typeof account_id !== 'string') {
    return { ok: false, error: 'Must be either {"api_key": "sk-..."} or an OAuth blob with access_token, refresh_token, and account_id (top-level or under "tokens")' };
  }

  const value: CodexAuthJson = { access_token, refresh_token, account_id };
  // id_token is REQUIRED by codex-cli 0.144's auth.json parser — reject blobs that omit it.
  const id_token = src.id_token ?? root.id_token;
  if (typeof id_token !== 'string' || id_token.length === 0) {
    return {
      ok: false,
      error:
        "OAuth credential is missing required field 'id_token'. " +
        "Copy the complete ~/.codex/auth.json — the ChatGPT login writes all required fields.",
    };
  }
  value.id_token = id_token;

  // Explicit lifetime fields can live at the root or alongside the tokens.
  const expiresIn = root.expires_in ?? src.expires_in;
  const expiry = root.expiry ?? src.expiry;
  if (typeof expiresIn === 'number') {
    value.expires_in = expiresIn;
  } else if (typeof expiry === 'string') {
    value.expiry = expiry;
  } else {
    const exp = jwtExpSeconds(access_token);
    if (exp != null) value.expires_in = Math.max(0, exp - Math.floor(Date.now() / 1000));
  }

  return { ok: true, value };
}

export interface CodexCredential {
  credentialType: 'oauth' | 'api_key';
  // OAuth fields — present when credentialType === 'oauth'
  accessToken?: string;
  refreshToken?: string;
  accountId?: string;
  // id_token — REQUIRED by codex-cli's auth.json parser (delivered to the runner).
  idToken?: string;
  // API key — present when credentialType === 'api_key'
  apiKey?: string;
  tokenExpiresAt: Date | null;
  lastRefreshedAt: Date | null;
}

/**
 * Identifies where a Codex credential is stored. `accountId`/`workspaceId` left
 * undefined (or null) means team-wide — shared by every workspace in the team.
 * See docs/credentials-architecture.md.
 */
export interface CodexScope {
  teamId: string;
  accountId?: string | null;
  workspaceId?: string | null;
}

/** The encrypted-at-rest payload stored in secrets.encryptedValue. */
interface CodexBlob {
  // OAuth fields
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
  id_token?: string;
  // API key (alternative to OAuth)
  api_key?: string;
}

function encodeBlob(blob: CodexBlob): string {
  return encrypt(JSON.stringify(blob));
}

function decodeBlob(encryptedValue: string): CodexBlob {
  return JSON.parse(decrypt(encryptedValue)) as CodexBlob;
}

function expiryFromAuthJson(authJson: CodexAuthJson): Date | null {
  if (authJson.expires_in != null) return new Date(Date.now() + authJson.expires_in * 1000);
  if (authJson.expiry) return new Date(authJson.expiry);
  return null;
}

function codexOAuthClientId(): string {
  const clientId = process.env.CODEX_OAUTH_CLIENT_ID;
  if (!clientId || clientId === 'app_client_id') {
    throw new Error('CODEX_OAUTH_CLIENT_ID is not configured');
  }
  return clientId;
}

function credentialUsable(row: { tokenExpiresAt: Date | string | null }): boolean {
  if (!row.tokenExpiresAt) return true;
  return new Date(row.tokenExpiresAt).getTime() > Date.now();
}

/** Exact-scope match (NULL-aware) for accountId + workspaceId. */
function scopeMatch(scope: CodexScope) {
  return and(
    eq(secrets.teamId, scope.teamId),
    eq(secrets.purpose, PURPOSE),
    scope.accountId ? eq(secrets.accountId, scope.accountId) : isNull(secrets.accountId),
    scope.workspaceId ? eq(secrets.workspaceId, scope.workspaceId) : isNull(secrets.workspaceId),
  );
}

/**
 * Store (replace) the Codex credential at an exact scope. There is one Codex
 * login per scope, so any existing row at the same scope is removed first.
 * Accepts either OAuth blobs (access_token+refresh_token+account_id) or
 * API key blobs ({api_key: "sk-..."}) from normalizeCodexAuthJson.
 */
export async function storeCodexCredential(scope: CodexScope, authJson: CodexAuthJson): Promise<void> {
  const encryptedValue = authJson.api_key
    ? encodeBlob({ api_key: authJson.api_key })
    : encodeBlob({
        access_token: authJson.access_token,
        refresh_token: authJson.refresh_token,
        account_id: authJson.account_id,
        id_token: authJson.id_token,
      });
  // API keys don't carry short-lived JWTs — no expiry metadata.
  const tokenExpiresAt = authJson.api_key ? null : expiryFromAuthJson(authJson);
  const now = new Date();

  // One credential per scope: replace any existing one. Not transactional, but
  // this is a manual "connect" action — neon-http has no interactive tx anyway.
  await db.delete(secrets).where(scopeMatch(scope));
  await db.insert(secrets).values({
    teamId: scope.teamId,
    accountId: scope.accountId ?? null,
    workspaceId: scope.workspaceId ?? null,
    purpose: PURPOSE,
    encryptedValue,
    tokenExpiresAt,
    lastRefreshedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Resolve the most-specific Codex credential visible to a task: workspace-scoped
 * beats account-scoped beats team-wide. Used at claim time.
 */
export async function resolveCodexCredential(opts: {
  teamId: string;
  accountId?: string | null;
  workspaceId?: string | null;
}): Promise<CodexCredential | null> {
  const rows = await db.query.secrets.findMany({
    where: and(
      eq(secrets.teamId, opts.teamId),
      eq(secrets.purpose, PURPOSE),
      or(isNull(secrets.accountId), opts.accountId ? eq(secrets.accountId, opts.accountId) : sql`false`),
      or(isNull(secrets.workspaceId), opts.workspaceId ? eq(secrets.workspaceId, opts.workspaceId) : sql`false`),
    ),
    columns: { encryptedValue: true, accountId: true, workspaceId: true, tokenExpiresAt: true, lastRefreshedAt: true },
  });
  if (rows.length === 0) return null;

  // Specificity: workspace match (2) outranks account match (1) outranks team-wide (0).
  const score = (r: { accountId: string | null; workspaceId: string | null }) =>
    (r.workspaceId && r.workspaceId === opts.workspaceId ? 2 : 0) +
    (r.accountId && r.accountId === opts.accountId ? 1 : 0);
  // Expired credentials are still returned — the claim gate attempts refresh before use.
  const best = rows.reduce((a, b) => (score(b) > score(a) ? b : a));

  const blob = decodeBlob(best.encryptedValue);
  const isApiKey = typeof blob.api_key === 'string' && blob.api_key.length > 0;
  return {
    credentialType: isApiKey ? 'api_key' : 'oauth',
    ...(isApiKey
      ? { apiKey: blob.api_key }
      : {
          accessToken: blob.access_token,
          refreshToken: blob.refresh_token,
          accountId: blob.account_id,
          idToken: blob.id_token,
        }),
    tokenExpiresAt: best.tokenExpiresAt ?? null,
    lastRefreshedAt: best.lastRefreshedAt ?? null,
  };
}

/** True when an unexpired Codex credential exists for this task scope. Does not decrypt token values. */
export async function hasCodexCredential(opts: {
  teamId: string;
  accountId?: string | null;
  workspaceId?: string | null;
}): Promise<boolean> {
  const rows = await db.query.secrets.findMany({
    where: and(
      eq(secrets.teamId, opts.teamId),
      eq(secrets.purpose, PURPOSE),
      or(isNull(secrets.accountId), opts.accountId ? eq(secrets.accountId, opts.accountId) : sql`false`),
      or(isNull(secrets.workspaceId), opts.workspaceId ? eq(secrets.workspaceId, opts.workspaceId) : sql`false`),
    ),
    columns: { tokenExpiresAt: true },
  });
  // Any stored credential counts — Codex CLI refreshes expired tokens via refresh_token.
  return rows.length > 0;
}

/** Connection status (no token values) for the credential stored at an exact scope. */
export async function getCodexStatus(scope: CodexScope): Promise<CodexStatus> {
  const row = await db.query.secrets.findFirst({
    where: scopeMatch(scope),
    columns: {
      encryptedValue: true,
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
      accountId: null,
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
    accountId: decodeBlob(row.encryptedValue).account_id ?? null,
    lastRefreshedAt: row.lastRefreshedAt ? row.lastRefreshedAt.toISOString() : null,
    lastVerifiedAt: row.lastVerifiedAt ? row.lastVerifiedAt.toISOString() : null,
    lastVerificationError: row.lastVerificationError ?? null,
    scope: row.workspaceId ? 'workspace' : 'team',
  };
}

/** Remove the Codex credential stored at an exact scope. */
export async function deleteCodexCredential(scope: CodexScope): Promise<void> {
  await db.delete(secrets).where(scopeMatch(scope));
}

/** Secret id of the Codex credential at an exact scope, or null. Used by the refresh route. */
export async function getCodexSecretId(scope: CodexScope): Promise<string | null> {
  const row = await db.query.secrets.findFirst({
    where: scopeMatch(scope),
    columns: { id: true },
  });
  return row?.id ?? null;
}

export type RefreshResult = 'refreshed' | 'locked' | 'no_credential' | 'error';

/**
 * Refresh the Codex OAuth tokens for one secret row (identified by id).
 *
 * Uses a DB-level optimistic lock on `lastRefreshedAt` so only one caller
 * refreshes at a time. OpenAI ROTATES the refresh token on each use — the new
 * refresh token is always persisted, even if it looks identical to the old one.
 *
 * Never logs token values.
 */
export async function refreshCodexCredential(secretId: string): Promise<RefreshResult> {
  // Atomically claim refresh rights: only proceed if last_refreshed_at is NULL
  // or older than the lock window. Concurrent callers get nothing back.
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

  // We hold the lock. Decrypt the stored blob.
  const blob = decodeBlob(claimed.encryptedValue);
  const currentRefreshToken = blob.refresh_token;
  // API key credentials have no refresh_token — nothing to refresh via OAuth.
  if (!currentRefreshToken) return 'no_credential';

  try {
    const res = await fetch(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: currentRefreshToken,
        client_id: codexOAuthClientId(),
      }).toString(),
    });

    if (!res.ok) {
      console.warn(`[Codex] Token refresh failed for secret ${secretId}: HTTP ${res.status}`);
      return 'error';
    }

    const tokens = await res.json() as Record<string, unknown>;

    const newAccessToken = tokens.access_token as string;
    // CRITICAL: always use the rotated refresh token from the response. OpenAI may
    // rotate it on every call. Fall back to the current one only if the response
    // genuinely omits it.
    const newRefreshToken = typeof tokens.refresh_token === 'string'
      ? tokens.refresh_token
      : currentRefreshToken;

    const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : null;
    const tokenExpiresAt = expiresIn != null ? new Date(Date.now() + expiresIn * 1000) : null;

    // Preserve id_token: the refresh response usually returns a new one, but keep
    // the prior one if omitted (codex-cli requires it in auth.json).
    const newIdToken = typeof tokens.id_token === 'string' ? tokens.id_token : blob.id_token;

    await db
      .update(secrets)
      .set({
        encryptedValue: encodeBlob({
          access_token: newAccessToken,
          refresh_token: newRefreshToken,
          account_id: blob.account_id,
          id_token: newIdToken,
        }),
        tokenExpiresAt,
        updatedAt: sql`NOW()`,
      })
      .where(eq(secrets.id, secretId));

    console.log(`[Codex] Token refreshed for secret ${secretId}`);
    return 'refreshed';
  } catch (err) {
    console.warn(`[Codex] Token refresh error for secret ${secretId}:`, err instanceof Error ? err.message : 'unknown');
    return 'error';
  }
}

/**
 * Write back refreshed OAuth tokens after a Codex run. The Codex CLI may have
 * refreshed the access/refresh tokens during the run; the runner reads the updated
 * auth.json from the stable CODEX_HOME and POSTs it here so future workers start
 * with the latest tokens instead of the original stale snapshot.
 *
 * Uses an optimistic lock on `lastRefreshedAt` to serialize concurrent write-backs
 * from multiple workers (rare, but possible when the account runs parallel Codex workers).
 * Only OAuth credentials need write-back (API keys don't rotate this way).
 *
 * Returns true when the write succeeded, false if another caller locked it recently.
 */
export async function writeBackCodexTokens(
  opts: { teamId: string; accountId?: string | null; workspaceId?: string | null },
  tokens: { accessToken: string; refreshToken: string; accountId?: string; idToken?: string; expiresIn?: number },
): Promise<boolean> {
  // Find the credential row to update (most specific scope wins).
  const rows = await db.query.secrets.findMany({
    where: and(
      eq(secrets.teamId, opts.teamId),
      eq(secrets.purpose, PURPOSE),
      or(isNull(secrets.accountId), opts.accountId ? eq(secrets.accountId, opts.accountId) : sql`false`),
      or(isNull(secrets.workspaceId), opts.workspaceId ? eq(secrets.workspaceId, opts.workspaceId) : sql`false`),
    ),
    columns: { id: true, encryptedValue: true, accountId: true, workspaceId: true },
  });
  if (rows.length === 0) return false;

  const score = (r: { accountId: string | null; workspaceId: string | null }) =>
    (r.workspaceId && r.workspaceId === opts.workspaceId ? 2 : 0) +
    (r.accountId && r.accountId === opts.accountId ? 1 : 0);
  const best = rows.reduce((a, b) => (score(b) > score(a) ? b : a));

  // Skip API key credentials — they don't refresh via this path.
  const blob = decodeBlob(best.encryptedValue);
  if (blob.api_key) return false;

  const newBlob = encodeBlob({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    account_id: tokens.accountId ?? blob.account_id,
    id_token: tokens.idToken ?? blob.id_token,
  });
  const tokenExpiresAt = tokens.expiresIn != null ? new Date(Date.now() + tokens.expiresIn * 1000) : null;

  // Optimistic lock: write-back only if not updated within the last 30s.
  // Multiple workers completing simultaneously could race here; last write wins is fine
  // since they all have fresh tokens from the same session window.
  const [updated] = await db
    .update(secrets)
    .set({
      encryptedValue: newBlob,
      ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
      lastRefreshedAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    })
    .where(
      and(
        eq(secrets.id, best.id),
        eq(secrets.purpose, PURPOSE),
        or(
          isNull(secrets.lastRefreshedAt),
          lt(secrets.lastRefreshedAt, sql`NOW() - INTERVAL '30 seconds'`),
        ),
      ),
    )
    .returning({ id: secrets.id });

  if (updated) {
    console.log(`[Codex] Tokens written back for secret ${best.id}`);
  }
  return !!updated;
}

export interface VerifyResult {
  verified: boolean;
  error: string | null;
  /**
   * True when the refresh grant passes but the credential is still flagged
   * 'revoked' from a real worker run — the session check cannot detect OAuth
   * revocation that only surfaces in-runner. The UI shows a re-auth warning
   * instead of a green pass.
   */
  revoked?: boolean;
}

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

/**
 * Smoke-test the stored Codex credential. Behavior differs by credential type:
 *
 * - **API key** (`api_key` blob): calls GET /v1/models with the key as Bearer.
 *   This endpoint is API-key-only and reliably confirms/rejects the key.
 *
 * - **OAuth** (`access_token`+`refresh_token` blob): exercises the OpenAI
 *   refresh grant (POST auth.openai.com/oauth/token). GET /v1/models returns
 *   403 for OAuth Bearer tokens regardless of validity, so it cannot detect
 *   revocation. The refresh grant is the actual path that fails when the
 *   ChatGPT session is revoked ("logged out or signed in to another account"),
 *   making it the definitive validity check. On success the rotated tokens are
 *   written back in the same DB update as the verification stamp.
 *
 * Persists lastVerifiedAt and lastVerificationError for durable UI state.
 * Never logs token values.
 */
export async function verifyCodexCredential(secretId: string): Promise<VerifyResult> {
  const row = await db.query.secrets.findFirst({
    where: and(eq(secrets.id, secretId), eq(secrets.purpose, PURPOSE)),
    columns: { encryptedValue: true, healthStatus: true },
  });

  if (!row) return { verified: false, error: 'Credential not found' };

  const blob = decodeBlob(row.encryptedValue);
  const isApiKey = typeof blob.api_key === 'string' && blob.api_key.length > 0;

  // ── API key path ─────────────────────────────────────────────────────────────
  // GET /v1/models is the correct check for API keys; response is authoritative.
  if (isApiKey) {
    let verified: boolean;
    let error: string | null = null;

    try {
      const res = await fetch(OPENAI_MODELS_URL, {
        headers: { Authorization: `Bearer ${blob.api_key}` },
      });
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

    if (verified) {
      await recordCredentialAuthSuccess(secretId);
    } else if (error) {
      await recordCredentialAuthFailure(secretId, error);
    }

    return { verified, error };
  }

  // ── OAuth path ───────────────────────────────────────────────────────────────
  // GET /v1/models is API-key-only and returns 403 for OAuth Bearer tokens
  // regardless of whether the credential is valid — it cannot confirm a good
  // OAuth cred or detect a revoked one. Use the refresh grant instead: this is
  // what the Codex CLI exercises and what actually fails on revocation.

  // Fast-fail: codex-cli 0.144 requires id_token in auth.json. A stored blob
  // without it will always crash the worker at spawn time. Detect now so health
  // is stamped and claim-time resolution can skip this credential.
  if (!blob.id_token) {
    const missingIdErr =
      'Stored credential is incomplete (missing id_token). ' +
      'Reconnect ChatGPT in Settings → Credentials to fix this.';
    await db
      .update(secrets)
      .set({ lastVerifiedAt: sql`NOW()`, lastVerificationError: missingIdErr, updatedAt: sql`NOW()` })
      .where(and(eq(secrets.id, secretId), eq(secrets.purpose, PURPOSE)));
    await recordCredentialAuthFailure(secretId, missingIdErr);
    return { verified: false, error: missingIdErr };
  }

  if (!blob.refresh_token) {
    return { verified: false, error: 'No refresh token available' };
  }

  let verified: boolean;
  let error: string | null = null;

  try {
    const res = await fetch(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: blob.refresh_token,
        client_id: codexOAuthClientId(),
      }).toString(),
    });

    if (res.ok) {
      const tokens = await res.json() as Record<string, unknown>;
      const newAccessToken = tokens.access_token as string;
      // CRITICAL: always persist the rotated refresh token (OpenAI rotates on every call)
      const newRefreshToken = typeof tokens.refresh_token === 'string'
        ? tokens.refresh_token
        : blob.refresh_token;
      const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : null;
      const tokenExpiresAt = expiresIn != null ? new Date(Date.now() + expiresIn * 1000) : null;
      // Preserve id_token: the refresh response may return a new one; keep the prior
      // one if omitted. codex-cli requires id_token in auth.json — never drop it.
      const newIdToken = typeof tokens.id_token === 'string' ? tokens.id_token : blob.id_token;

      // Merge token write-back + verification stamp into one DB update
      await db
        .update(secrets)
        .set({
          encryptedValue: encodeBlob({
            access_token: newAccessToken,
            refresh_token: newRefreshToken,
            account_id: blob.account_id,
            id_token: newIdToken,
          }),
          ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
          lastRefreshedAt: sql`NOW()`,
          lastVerifiedAt: sql`NOW()`,
          lastVerificationError: null,
          updatedAt: sql`NOW()`,
        })
        .where(and(eq(secrets.id, secretId), eq(secrets.purpose, PURPOSE)));

      verified = true;
    } else {
      verified = false;
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json() as Record<string, unknown>;
        const msg = (body.error as Record<string, unknown> | undefined)?.message
          ?? (typeof body.error_description === 'string' ? body.error_description : undefined);
        if (typeof msg === 'string') detail += `: ${msg}`;
      } catch {
        // ignore json parse error
      }
      error = detail;

      await db
        .update(secrets)
        .set({ lastVerifiedAt: sql`NOW()`, lastVerificationError: error, updatedAt: sql`NOW()` })
        .where(and(eq(secrets.id, secretId), eq(secrets.purpose, PURPOSE)));
    }
  } catch (err) {
    verified = false;
    error = err instanceof Error ? err.message : 'Network error';

    await db
      .update(secrets)
      .set({ lastVerifiedAt: sql`NOW()`, lastVerificationError: error, updatedAt: sql`NOW()` })
      .where(and(eq(secrets.id, secretId), eq(secrets.purpose, PURPOSE)));
  }

  // Revoked-aware health update (mirrors PR #1302's Claude OAuth fix).
  // A passing refresh-grant verify must NOT launder a worker-observed 'revoked'
  // credential back to 'healthy'. Session revocation surfaces only on the
  // runner's in-session path — only a fresh credential store resets health.
  // API keys have no session/refresh semantics so their verify IS authoritative
  // (handled above in the isApiKey branch).
  const revoked = row.healthStatus === 'revoked';
  if (verified) {
    if (revoked) {
      return { verified: true, error: null, revoked: true };
    }
    await recordCredentialAuthSuccess(secretId);
  } else if (error) {
    await recordCredentialAuthFailure(secretId, error);
  }

  return { verified, error };
}
