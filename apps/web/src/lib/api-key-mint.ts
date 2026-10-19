/**
 * Mint one `bld_` API key: the account row (hashed key, prefix) and its
 * workspace links. Shared by POST /api/accounts and the cloud runner deploy,
 * which mints the Worker's runner key without anyone seeing it. Callers
 * validate the request and the minter's role first; this only writes.
 *
 * The plaintext key is returned once and never stored.
 */
import { randomBytes } from 'crypto';
import { db } from '@buildd/core/db';
import { accounts, accountWorkspaces } from '@buildd/core/db/schema';
import { hashApiKey, extractApiKeyPrefix } from '@/lib/api-auth';
import { clearTeamCache } from '@/lib/team-cache';

export function generateApiKey(): string {
  return `bld_${randomBytes(32).toString('hex')}`;
}

export type MintAccountValues = Omit<typeof accounts.$inferInsert, 'apiKey' | 'apiKeyPrefix'>;

export async function mintApiKeyAccount(
  values: MintAccountValues,
  linkWorkspaceIds: string[],
): Promise<{ account: typeof accounts.$inferSelect; plaintextKey: string }> {
  const plaintextKey = generateApiKey();
  const [account] = await db
    .insert(accounts)
    .values({ ...values, apiKey: hashApiKey(plaintextKey), apiKeyPrefix: extractApiKeyPrefix(plaintextKey) } as typeof accounts.$inferInsert)
    .returning();
  for (const workspaceId of linkWorkspaceIds) {
    await db.insert(accountWorkspaces).values({ accountId: account.id, workspaceId, canClaim: true, canCreate: true });
  }
  await clearTeamCache(account.teamId, 'runners');
  return { account, plaintextKey };
}
