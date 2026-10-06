import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { teamCredentialWhere } from '@buildd/core/secrets/team-scope';
import { ne } from 'drizzle-orm';
import { AGENT_CREDENTIAL_PURPOSES } from './getting-started';

/**
 * Does the team hold an agent-backend credential that has not been revoked?
 * Any scope counts (team-wide, one workspace, one runner account): the
 * checklist asks whether agents can run at all, not on which machine.
 */
export async function teamHasAgentCredential(teamId: string): Promise<boolean> {
  const rows = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(teamCredentialWhere({ teamId, purpose: AGENT_CREDENTIAL_PURPOSES }, ne(secrets.healthStatus, 'revoked')))
    .limit(1);
  return rows.length > 0;
}
