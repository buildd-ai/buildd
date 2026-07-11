/**
 * Work-tracker integration helpers.
 *
 * Fetches the connector OAuth token for a workspace's work tracker and makes
 * outbound calls to the configured external issue tracker (e.g. Linear).
 */

import { db } from '@buildd/core/db';
import { secrets, workspaces, missionNotes } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { getSecretsProvider } from '@buildd/core/secrets';
import { triggerEvent } from '@/lib/pusher';
import { channels, events } from '@/lib/pusher-events';

const LINEAR_API = 'https://api.linear.app/graphql';

async function getConnectorAccessToken(connectorId: string, teamId: string): Promise<string | null> {
  const secretRow = await db.query.secrets.findFirst({
    where: and(
      eq(secrets.teamId, teamId),
      eq(secrets.purpose, 'mcp_connector_credential'),
      eq(secrets.label, connectorId),
    ),
    columns: { id: true, tokenExpiresAt: true },
  });
  if (!secretRow) return null;

  if (secretRow.tokenExpiresAt && new Date(secretRow.tokenExpiresAt) < new Date()) {
    return null; // expired
  }

  const provider = getSecretsProvider();
  const raw = await provider.get(secretRow.id);
  if (!raw) return null;

  try {
    const blob = JSON.parse(raw) as Record<string, unknown>;
    return (blob.access_token as string) ?? null;
  } catch {
    // Header-mode: raw value is the token itself
    return raw;
  }
}

async function linearGraphQL(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(LINEAR_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    return data;
  } catch {
    return null;
  }
}

/**
 * Post a completion comment on a Linear issue and transition its state.
 *
 * @param opts.externalIssueId  - Linear issue ID
 * @param opts.connectorId      - Connector ID to source the token from
 * @param opts.teamId           - Team ID (for secret lookup)
 * @param opts.prUrl            - PR URL to include in the comment
 * @param opts.merged           - true if PR was merged (→ "Done"), false if opened (→ "In Review")
 */
export async function postLinearCompletionComment(opts: {
  externalIssueId: string;
  connectorId: string;
  teamId: string;
  prUrl: string | null;
  merged: boolean;
}): Promise<void> {
  const { externalIssueId, connectorId, teamId, prUrl, merged } = opts;

  const token = await getConnectorAccessToken(connectorId, teamId);
  if (!token) {
    console.log(`[work-tracker] No token for connector ${connectorId}, skipping Linear update`);
    return;
  }

  const prLine = prUrl ? `\n\nPR: ${prUrl}` : '';
  const body = `Task completed.${prLine}`;

  // Post comment
  await linearGraphQL(token, `
    mutation CreateComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
      }
    }
  `, { issueId: externalIssueId, body });

  // Transition state
  const targetStateName = merged ? 'Done' : 'In Review';
  const statesData = await linearGraphQL(token, `
    query GetStates {
      workflowStates(filter: { name: { eqIgnoreCase: "${targetStateName}" } }) {
        nodes { id name }
      }
    }
  `);

  const stateNodes = (statesData as any)?.data?.workflowStates?.nodes as Array<{ id: string }> | undefined;
  if (stateNodes && stateNodes.length > 0) {
    await linearGraphQL(token, `
      mutation UpdateIssueState($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) {
          success
        }
      }
    `, { issueId: externalIssueId, stateId: stateNodes[0].id });
  }
}

/**
 * Post an informational note to a mission when a work tracker is configured.
 * Non-blocking — errors are logged but not re-thrown.
 */
export async function maybePostWorkTrackerNote(
  missionId: string,
  workspaceId: string,
): Promise<void> {
  try {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { workTrackerConfig: true },
    });
    if (!ws?.workTrackerConfig) return;

    const provider = ws.workTrackerConfig.provider;
    const providerLabel = provider === 'linear' ? 'Linear' : provider;

    const [note] = await db.insert(missionNotes).values({
      missionId,
      authorType: 'system',
      type: 'suggestion',
      title: `Connect ${providerLabel} project`,
      body: `Link to a ${providerLabel} project? Run \`/link-linear <project-url>\` in a task to connect.`,
      status: 'answered',
    }).returning();

    await triggerEvent(channels.mission(missionId), events.MISSION_NOTE_POSTED, {
      noteId: note.id,
      type: note.type,
      authorType: note.authorType,
      title: note.title,
    });
  } catch (err) {
    console.error('[work-tracker] Failed to post work tracker note:', err);
  }
}
