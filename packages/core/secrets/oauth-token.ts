/**
 * Convenience helpers for managing OAuth tokens via the encrypted secrets table.
 *
 * Uses the (accountId, purpose='oauth_token') unique index for upsert semantics.
 */

import { db } from '../db/client';
import { secrets } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { getSecretsProvider } from './index';

/**
 * Store (or update) an OAuth token for an account, encrypted at rest.
 * Returns the secret ID.
 */
export async function setOAuthToken(opts: {
  accountId: string;
  teamId: string;
  token: string;
}): Promise<string> {
  const { accountId, teamId, token } = opts;

  // Check if an oauth_token secret already exists for this account
  const existing = await db.query.secrets.findFirst({
    where: and(
      eq(secrets.accountId, accountId),
      eq(secrets.purpose, 'oauth_token'),
    ),
    columns: { id: true },
  });

  const provider = getSecretsProvider();
  return provider.set(existing?.id ?? null, token, {
    teamId,
    accountId,
    purpose: 'oauth_token',
    label: 'OAuth Token',
  });
}

/**
 * Retrieve the decrypted OAuth token for an account.
 * Returns null if no token is stored or ENCRYPTION_KEY is not set.
 */
export async function getOAuthToken(accountId: string): Promise<string | null> {
  if (!process.env.ENCRYPTION_KEY) return null;

  const row = await db.query.secrets.findFirst({
    where: and(
      eq(secrets.accountId, accountId),
      eq(secrets.purpose, 'oauth_token'),
    ),
    columns: { id: true },
  });
  if (!row) return null;

  const provider = getSecretsProvider();
  return provider.get(row.id);
}

/**
 * Delete the OAuth token secret for an account.
 */
export async function deleteOAuthToken(accountId: string): Promise<void> {
  const row = await db.query.secrets.findFirst({
    where: and(
      eq(secrets.accountId, accountId),
      eq(secrets.purpose, 'oauth_token'),
    ),
    columns: { id: true },
  });
  if (!row) return;

  const provider = getSecretsProvider();
  await provider.delete(row.id);
}
