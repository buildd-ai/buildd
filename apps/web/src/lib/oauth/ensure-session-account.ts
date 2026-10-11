import { randomBytes } from 'crypto';
import { db } from '@buildd/core/db';
import { accounts, users } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { findTeamSessionAccount } from '@/lib/oauth/session-account';
import { hashApiKey, extractApiKeyPrefix } from '@/lib/api-auth';
import { resolveClaudeCredential, extractJwtSub } from '@/lib/claude-credential';

/**
 * Make sure `teamId` has the `type='user'` account an OAuth session in that
 * team acts as (lib/oauth/session-account.ts). A person who connects an MCP
 * client without ever logging in through the CLI or device flow has none.
 *
 * Callers (all with the person's membership in `teamId` already checked):
 *  - the token endpoint, at code exchange and refresh, for every granted team;
 *  - PATCH /api/mcp-grants/[id], for the team of every workspace it adds, so
 *    the workspace works on the next request rather than the next refresh;
 *  - /api/mcp, when a granted workspace's team turns out to have none.
 *
 * Creates a minimal account and also fills in its seat from the team's Claude
 * credential. Never throws: the caller's response is never blocked. Returns
 * whether the team has a session account afterwards.
 */
export async function ensureTeamSessionAccount(userId: string, teamId: string): Promise<boolean> {
  try {
    const existing = await findTeamSessionAccount(teamId);

    let accountId: string;
    if (existing) {
      accountId = existing.id;
      if (existing.seatId) return true;
    } else {
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { name: true, email: true },
      });

      const plaintextKey = `bld_${randomBytes(32).toString('hex')}`;
      const [created] = await db.insert(accounts).values({
        name: `${user?.name || user?.email || 'User'}'s Account`,
        type: 'user',
        authType: 'oauth',
        apiKey: hashApiKey(plaintextKey),
        apiKeyPrefix: extractApiKeyPrefix(plaintextKey),
        maxConcurrentWorkers: 10,
        teamId,
      }).returning({ id: accounts.id });
      if (!created) return false;
      accountId = created.id;
    }

    // Seat from the team's Claude credential, so this account is grouped with
    // the other accounts sharing that Anthropic subscription.
    try {
      const cred = await resolveClaudeCredential({ teamId, accountId });
      if (cred) {
        const seatId = extractJwtSub(cred.accessToken);
        if (seatId) await db.update(accounts).set({ seatId }).where(eq(accounts.id, accountId));
      }
    } catch {
      // The seat is bookkeeping; the session works without it.
    }
    return true;
  } catch {
    return false;
  }
}
