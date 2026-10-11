import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { teamCredentialWhere } from '@buildd/core/secrets/team-scope';
import { ne, or } from 'drizzle-orm';
import { AGENT_CREDENTIAL_PURPOSES, AGENT_INFERENCE_KEY_LABELS } from './getting-started';

/**
 * Does the team hold an agent-backend credential that has not been revoked?
 * Any scope counts (team-wide, one workspace, one runner account): the
 * checklist asks whether agents can run at all, not on which machine.
 */
export async function teamHasAgentCredential(teamId: string): Promise<boolean> {
  const rows = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(or(
      teamCredentialWhere({ teamId, purpose: AGENT_CREDENTIAL_PURPOSES }, ne(secrets.healthStatus, 'revoked')),
      // The Anthropic / OpenAI key in canonical storage serves agent runs too.
      teamCredentialWhere({ teamId, purpose: 'inference_key', label: AGENT_INFERENCE_KEY_LABELS }, ne(secrets.healthStatus, 'revoked')),
    ))
    .limit(1);
  return rows.length > 0;
}
