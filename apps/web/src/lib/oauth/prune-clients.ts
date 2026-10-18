import { and, eq, lt, notExists, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { oauthClients, oauthCodes, oauthRefreshTokens, mcpOauthGrants } from '@buildd/core/db/schema';

/** Keep all consent/token history, including legacy and revoked grants. */
export async function pruneUnusedClients(now = new Date()): Promise<number> {
  const rows = await db.delete(oauthClients).where(and(
    lt(oauthClients.createdAt, new Date(now.getTime() - 30 * 86_400_000)),
    notExists(sql`(select 1 from ${mcpOauthGrants} where ${eq(mcpOauthGrants.clientId, oauthClients.clientId)})`),
    notExists(sql`(select 1 from ${oauthCodes} where ${eq(oauthCodes.clientId, oauthClients.clientId)})`),
    notExists(sql`(select 1 from ${oauthRefreshTokens} where ${eq(oauthRefreshTokens.clientId, oauthClients.clientId)})`),
  )).returning({ clientId: oauthClients.clientId });
  return rows.length;
}
