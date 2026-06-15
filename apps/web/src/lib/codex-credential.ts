import { db } from '@buildd/core/db';
import { codexCredentials } from '@buildd/core/db/schema';
import { encrypt, decrypt } from '@buildd/core/secrets';
import { eq } from 'drizzle-orm';

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
    columns: { accountId: true, tokenExpiresAt: true },
  });

  if (!row) {
    return { connected: false, expired: false, accountId: null };
  }

  const expired = row.tokenExpiresAt != null && row.tokenExpiresAt < new Date();
  return { connected: true, expired, accountId: row.accountId };
}

export async function deleteCodexCredential(workspaceId: string): Promise<void> {
  await db.delete(codexCredentials).where(eq(codexCredentials.workspaceId, workspaceId));
}
