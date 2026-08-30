/**
 * Helpers for managing the team memory API key via the encrypted secrets table.
 *
 * Keys are stored as team-scoped singletons: purpose='memory_api_key',
 * accountId=NULL, workspaceId=NULL, label=NULL.
 */

import { db } from '../db/client';
import { secrets } from '../db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { getSecretsProvider } from './index';

const PURPOSE = 'memory_api_key' as const;

/**
 * Retrieve the decrypted memory API key for a team.
 * Returns null if none is stored or ENCRYPTION_KEY is unset.
 */
export async function getMemoryApiKeyForTeam(teamId: string): Promise<string | null> {
  if (!process.env.ENCRYPTION_KEY) return null;

  const row = await db.query.secrets.findFirst({
    where: and(
      eq(secrets.teamId, teamId),
      eq(secrets.purpose, PURPOSE),
      isNull(secrets.accountId),
      isNull(secrets.workspaceId),
    ),
    columns: { id: true },
  });
  if (!row) return null;

  return getSecretsProvider().get(row.id);
}

/**
 * Store (or replace) the memory API key for a team, encrypted at rest.
 */
export async function setMemoryApiKeyForTeam(teamId: string, key: string): Promise<void> {
  await getSecretsProvider().replaceScoped(key, { teamId, purpose: PURPOSE });
}
