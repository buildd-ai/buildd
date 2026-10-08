import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { and, asc, eq } from 'drizzle-orm';

/**
 * The account an OAuth session in `teamId` acts as: the team's oldest
 * `type='user'` account, ties broken by id.
 *
 * A team can hold several user accounts (one per CLI or device login, plus the
 * one /api/oauth/token provisions when there is none). The pick must be the
 * same on every request, because it is the id the claim stamps on
 * workers.account_id and the id PATCH /api/workers/[id] compares it with.
 * Without an ORDER BY, Postgres returns whichever matching row it reaches
 * first, which moves as rows are updated (every authenticated call writes
 * last_used_at), so one token could claim as one account and then be refused
 * on its own worker as another. tests/db/oauth-session-account.test.ts pins it.
 *
 * Both the session resolver (lib/api-auth.ts) and the token endpoint's account
 * provisioning read through this, so they agree on the row.
 */
export async function findTeamSessionAccount(teamId: string) {
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.teamId, teamId), eq(accounts.type, 'user')),
    orderBy: [asc(accounts.createdAt), asc(accounts.id)],
  });
  return account ?? null;
}
