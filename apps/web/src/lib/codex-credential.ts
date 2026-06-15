import { db } from '@buildd/core/db';
import { codexCredentials } from '@buildd/core/db/schema';
import { encrypt, decrypt } from '@buildd/core/secrets';
import { eq, and, or, isNull, lt, sql } from 'drizzle-orm';

const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = process.env.CODEX_OAUTH_CLIENT_ID ?? 'app_client_id';

export interface CodexAuthJson {
  access_token: string;
  refresh_token: string;
  account_id: string;
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
}

export interface CodexCredential {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  tokenExpiresAt: Date | null;
  lastRefreshedAt: Date | null;
}

export async function storeCodexCredential(workspaceId: string, authJson: CodexAuthJson): Promise<void> {
  const encryptedAccessToken = encrypt(authJson.access_token);
  const encryptedRefreshToken = encrypt(authJson.refresh_token);

  let tokenExpiresAt: Date | null = null;
  if (authJson.expires_in != null) {
    tokenExpiresAt = new Date(Date.now() + authJson.expires_in * 1000);
  } else if (authJson.expiry) {
    tokenExpiresAt = new Date(authJson.expiry);
  }

  const now = new Date();
  await db
    .insert(codexCredentials)
    .values({
      workspaceId,
      encryptedAccessToken,
      encryptedRefreshToken,
      accountId: authJson.account_id,
      tokenExpiresAt,
      lastRefreshedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: codexCredentials.workspaceId,
      set: {
        encryptedAccessToken,
        encryptedRefreshToken,
        accountId: authJson.account_id,
        tokenExpiresAt,
        lastRefreshedAt: now,
        updatedAt: now,
      },
    });
}

export async function getCodexCredential(workspaceId: string): Promise<CodexCredential | null> {
  const row = await db.query.codexCredentials.findFirst({
    where: eq(codexCredentials.workspaceId, workspaceId),
  });
  if (!row) return null;

  return {
    accessToken: decrypt(row.encryptedAccessToken),
    refreshToken: decrypt(row.encryptedRefreshToken),
    accountId: row.accountId,
    tokenExpiresAt: row.tokenExpiresAt ?? null,
    lastRefreshedAt: row.lastRefreshedAt ?? null,
  };
}

export async function getCodexStatus(workspaceId: string): Promise<CodexStatus> {
  const row = await db.query.codexCredentials.findFirst({
    where: eq(codexCredentials.workspaceId, workspaceId),
    columns: { accountId: true, tokenExpiresAt: true, lastRefreshedAt: true },
  });

  if (!row) {
    return { connected: false, expired: false, accountId: null, lastRefreshedAt: null };
  }

  const expired = row.tokenExpiresAt != null && row.tokenExpiresAt < new Date();
  return {
    connected: true,
    expired,
    accountId: row.accountId,
    lastRefreshedAt: row.lastRefreshedAt ? row.lastRefreshedAt.toISOString() : null,
  };
}

export async function deleteCodexCredential(workspaceId: string): Promise<void> {
  await db.delete(codexCredentials).where(eq(codexCredentials.workspaceId, workspaceId));
}

export type RefreshResult = 'refreshed' | 'locked' | 'no_credential' | 'error';

/**
 * Refresh the Codex OAuth tokens for a workspace.
 *
 * Uses a DB-level optimistic lock so only one caller refreshes at a time.
 * OpenAI ROTATES the refresh token on each use — both new tokens are always
 * persisted, even if the new refresh_token looks identical to the old one.
 *
 * Never logs token values.
 */
export async function refreshCodexCredential(workspaceId: string): Promise<RefreshResult> {
  // Atomically claim refresh rights: only proceed if last_refreshed_at is
  // NULL or older than LOCK_WINDOW_MINUTES. Concurrent callers get nothing back.
  const [claimed] = await db
    .update(codexCredentials)
    .set({
      lastRefreshedAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    })
    .where(
      and(
        eq(codexCredentials.workspaceId, workspaceId),
        or(
          isNull(codexCredentials.lastRefreshedAt),
          lt(codexCredentials.lastRefreshedAt, sql`NOW() - INTERVAL '60 minutes'`)
        )
      )
    )
    .returning();

  if (!claimed) {
    // Either the credential doesn't exist, or it was refreshed recently.
    const exists = await db.query.codexCredentials.findFirst({
      where: eq(codexCredentials.workspaceId, workspaceId),
      columns: { id: true },
    });
    return exists ? 'locked' : 'no_credential';
  }

  // We hold the lock. Decrypt the stored refresh token.
  const currentRefreshToken = decrypt(claimed.encryptedRefreshToken);

  try {
    const res = await fetch(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: currentRefreshToken,
        client_id: CODEX_CLIENT_ID,
      }).toString(),
    });

    if (!res.ok) {
      console.warn(`[Codex] Token refresh failed for workspace ${workspaceId}: HTTP ${res.status}`);
      return 'error';
    }

    const tokens = await res.json() as Record<string, unknown>;

    const newAccessToken = tokens.access_token as string;
    // CRITICAL: always use the rotated refresh token from the response.
    // OpenAI may rotate it on every call. Fall back to the current one only
    // if the response genuinely omits it (some providers do this).
    const newRefreshToken = typeof tokens.refresh_token === 'string'
      ? tokens.refresh_token
      : currentRefreshToken;

    const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : null;
    const tokenExpiresAt = expiresIn != null ? new Date(Date.now() + expiresIn * 1000) : null;

    await db
      .update(codexCredentials)
      .set({
        encryptedAccessToken: encrypt(newAccessToken),
        encryptedRefreshToken: encrypt(newRefreshToken),
        tokenExpiresAt,
        updatedAt: sql`NOW()`,
      })
      .where(eq(codexCredentials.workspaceId, workspaceId));

    console.log(`[Codex] Token refreshed for workspace ${workspaceId}`);
    return 'refreshed';
  } catch (err) {
    console.warn(`[Codex] Token refresh error for workspace ${workspaceId}:`, err instanceof Error ? err.message : 'unknown');
    return 'error';
  }
}
