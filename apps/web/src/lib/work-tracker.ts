/**
 * Work-tracker integration helpers.
 *
 * Fetches the connector OAuth token for a workspace's work tracker and makes
 * outbound calls to the configured external issue tracker (e.g. Linear).
 */

import { db } from '@buildd/core/db';
import { secrets, workspaces, missionNotes, githubInstallations, type WorkspaceWorkTrackerConfig } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { decrypt } from '@buildd/core/secrets';
import { refreshMcpConnectorCredential } from '@/lib/mcp-connector-refresh';
import { triggerEvent, channels, events } from '@/lib/pusher';
import { githubApi } from '@/lib/github';

const LINEAR_API = 'https://api.linear.app/graphql';

/** Renew a token this many ms before its expiry so an in-flight call never uses a dead token. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

/** Parse a GitHub issue URL into its parts. Returns null if it isn't one. */
export function parseGitHubIssueUrl(
  url: string | null | undefined,
): { owner: string; repo: string; number: number } | null {
  if (!url) return null;
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/**
 * Parse a Linear project/issue URL into a STABLE, deterministic external id.
 *
 * The same URL always yields the same id — link idempotency (the
 * `(provider, external_id)` upsert) depends on this. We take the trailing path
 * segment, which Linear guarantees carries the entity id/slug:
 *   - issue:   `https://linear.app/ws/issue/ACM-42/some-slug`   → `ACM-42`
 *   - project: `https://linear.app/ws/project/mobile-9f8e7d6c`  → `mobile-9f8e7d6c`
 *
 * No network call — a GraphQL lookup is best-effort validation only and never
 * changes the parsed id (see the link route).
 */
export function parseLinearUrl(
  url: string | null | undefined,
): { type: 'issue' | 'project'; externalId: string } | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)linear\.app$/i.test(parsed.hostname)) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);

  const issueIdx = parts.indexOf('issue');
  if (issueIdx >= 0 && parts[issueIdx + 1]) {
    // Linear issue identifiers are case-normalised (TEAM-NUMBER).
    return { type: 'issue', externalId: parts[issueIdx + 1].toUpperCase() };
  }

  const projectIdx = parts.indexOf('project');
  if (projectIdx >= 0 && parts[projectIdx + 1]) {
    return { type: 'project', externalId: parts[projectIdx + 1] };
  }

  return null;
}

/**
 * Resolve a live OAuth access token for a connector, refreshing proactively.
 *
 * A token is treated as needing refresh when it has no expiry or is within
 * {@link TOKEN_REFRESH_SKEW_MS} of expiring; on that condition we invoke the
 * shared refresher and act on its result. Dependencies are injectable for tests.
 */
export async function getConnectorAccessToken(
  connectorId: string,
  teamId: string,
  deps: {
    db?: typeof db;
    refresh?: typeof refreshMcpConnectorCredential;
    decrypt?: typeof decrypt;
  } = {},
): Promise<string | null> {
  const database = deps.db ?? db;
  const refresh = deps.refresh ?? refreshMcpConnectorCredential;
  const decryptValue = deps.decrypt ?? decrypt;

  const querySecret = () =>
    database.query.secrets.findFirst({
      where: and(
        eq(secrets.teamId, teamId),
        eq(secrets.purpose, 'mcp_connector_credential'),
        eq(secrets.label, connectorId),
      ),
      columns: { id: true, tokenExpiresAt: true, encryptedValue: true },
    });

  let secretRow = await querySecret();
  if (!secretRow) return null;

  const now = Date.now();
  const expiresAtMs = secretRow.tokenExpiresAt ? new Date(secretRow.tokenExpiresAt).getTime() : null;
  const needsRefresh = expiresAtMs === null || expiresAtMs < now + TOKEN_REFRESH_SKEW_MS;

  if (needsRefresh) {
    const result = await refresh(secretRow.id);
    switch (result) {
      case 'refreshed': {
        // Re-read so we decode the freshly-persisted blob.
        secretRow = await querySecret();
        if (!secretRow) return null;
        break;
      }
      case 'skipped':
        // Header/none auth: no OAuth refresh possible — use the existing token.
        break;
      case 'locked':
        // Another caller holds the refresh lock. Only reuse the current token if
        // it is still valid by the real clock; otherwise fail closed.
        if (expiresAtMs === null || expiresAtMs <= now) return null;
        break;
      case 'expired':
      case 'no_credential':
      case 'error':
      default:
        return null;
    }
  }

  const encrypted = secretRow.encryptedValue;
  if (!encrypted) return null;

  let decrypted: string;
  try {
    decrypted = decryptValue(encrypted);
  } catch {
    return null;
  }

  try {
    const blob = JSON.parse(decrypted) as Record<string, unknown>;
    return (blob.access_token as string) ?? null;
  } catch {
    // Header-mode: the decrypted value is the token itself.
    return decrypted;
  }
}

export async function linearGraphQL(
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
 * Post a completion comment on a GitHub issue and (on merge) close it, using the
 * workspace's existing GitHub App installation — no connector. The issue is
 * identified by the task's `externalIssueUrl`; if it isn't a GitHub issue URL, or
 * the workspace has no installation, this is a no-op.
 */
export async function postGitHubCompletionUpdate(opts: {
  workspaceId: string;
  externalIssueUrl: string | null;
  prUrl: string | null;
  merged: boolean;
}): Promise<void> {
  const { workspaceId, externalIssueUrl, prUrl, merged } = opts;

  const issue = parseGitHubIssueUrl(externalIssueUrl);
  if (!issue) {
    console.log('[work-tracker] externalIssueUrl is not a GitHub issue URL, skipping');
    return;
  }

  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { githubInstallationId: true },
  });
  if (!ws?.githubInstallationId) {
    console.log(`[work-tracker] Workspace ${workspaceId} has no GitHub installation, skipping`);
    return;
  }

  const installation = await db.query.githubInstallations.findFirst({
    where: eq(githubInstallations.id, ws.githubInstallationId),
    columns: { installationId: true },
  });
  if (!installation) return;
  const installId = installation.installationId;

  const prLine = prUrl ? `\n\nPR: ${prUrl}` : '';
  const base = `/repos/${issue.owner}/${issue.repo}/issues/${issue.number}`;

  try {
    await githubApi(installId, `${base}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: `Task ${merged ? 'completed' : 'in review'}.${prLine}` }),
    });
    if (merged) {
      await githubApi(installId, base, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
      });
    }
  } catch (err) {
    console.error('[work-tracker] GitHub issue update failed:', err);
  }
}

/**
 * Provider-dispatched completion update (spec §2). Routes to the configured work
 * tracker: Linear via its connector, GitHub via the App installation. Best-effort
 * — never throws into the caller (the GitHub webhook).
 */
export async function postWorkTrackerCompletionUpdate(opts: {
  workspaceId: string;
  teamId: string;
  config: WorkspaceWorkTrackerConfig;
  externalIssueId: string | null;
  externalIssueUrl: string | null;
  prUrl: string | null;
  merged: boolean;
}): Promise<void> {
  const { workspaceId, teamId, config, externalIssueId, externalIssueUrl, prUrl, merged } = opts;
  try {
    if (config.provider === 'linear') {
      if (!externalIssueId || !config.connectorId) return;
      await postLinearCompletionComment({ externalIssueId, connectorId: config.connectorId, teamId, prUrl, merged });
    } else if (config.provider === 'github') {
      await postGitHubCompletionUpdate({ workspaceId, externalIssueUrl, prUrl, merged });
    }
  } catch (err) {
    console.error('[work-tracker] completion update failed:', err);
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
      body: `Link this mission to a ${providerLabel} project so task completions post back automatically. In a task, run the buildd \`link_tracker\` action with entityType "mission", this mission's ID, and the ${providerLabel} project URL (or POST that URL to /api/missions/${missionId}/link).`,
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
