import { db } from '@buildd/core/db';
import { workspaces, connectors, connectorShares, connectorWorkspaces, secrets } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

export type ConnectorLiveStatus = 'ok' | 'auth_expired' | 'unreachable' | 'disabled';

export interface MountedConnectorSummary {
  id: string;
  name: string;
  authMode: string;
  status: ConnectorLiveStatus;
}

/**
 * Live connector health for a workspace: connectors owned by or shared to the
 * workspace's team that have been explicitly mounted (a connectorWorkspaces row
 * is present). Never-mounted connectors are excluded.
 */
export async function listMountedConnectors(
  workspaceId: string,
): Promise<{ ok: true; connectors: MountedConnectorSummary[] } | { ok: false; error: 'workspace_not_found' }> {
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { teamId: true },
  });
  if (!ws?.teamId) return { ok: false, error: 'workspace_not_found' };
  const teamId = ws.teamId;

  // Collect connector IDs owned by this team
  const ownedRows = await db.query.connectors.findMany({
    where: eq(connectors.teamId, teamId),
    columns: { id: true },
  });
  const ownedIds = new Set(ownedRows.map(r => r.id));

  // Collect connector IDs shared to this team
  const shareRows = await db.query.connectorShares.findMany({
    where: eq(connectorShares.sharedWithTeamId, teamId),
    columns: { connectorId: true },
  });
  const sharedIds = new Set(shareRows.map(r => r.connectorId));

  const allVisibleIds = [...new Set([...ownedIds, ...sharedIds])];
  if (allVisibleIds.length === 0) return { ok: true, connectors: [] };

  // Fetch connectorWorkspaces rows for this workspace — only mounted connectors appear
  const cwRows = await db.query.connectorWorkspaces.findMany({
    where: and(
      eq(connectorWorkspaces.workspaceId, workspaceId),
      inArray(connectorWorkspaces.connectorId, allVisibleIds),
    ),
  });
  if (cwRows.length === 0) return { ok: true, connectors: [] };

  // Fetch connector details for mounted connectors
  const mountedIds = cwRows.map(r => r.connectorId);
  const connectorRows = await db.query.connectors.findMany({
    where: inArray(connectors.id, mountedIds),
    columns: { id: true, name: true, authMode: true, teamId: true },
  });
  const connectorMap = new Map(connectorRows.map(c => [c.id, c]));

  // Fetch credential secrets for auth-mode connectors (keyed on owner team)
  const ownerTeamIds = [...new Set(connectorRows.map(c => c.teamId).filter(Boolean))] as string[];
  const secretRows = ownerTeamIds.length > 0
    ? await db.query.secrets.findMany({
        where: and(
          inArray(secrets.teamId, ownerTeamIds),
          eq(secrets.purpose, 'mcp_connector_credential'),
        ),
        columns: { label: true, tokenExpiresAt: true, healthStatus: true },
      })
    : [];
  const secretMap = new Map<string, { tokenExpiresAt: Date | null; healthStatus: string }>();
  for (const s of secretRows) {
    if (s.label) secretMap.set(s.label, { tokenExpiresAt: s.tokenExpiresAt, healthStatus: s.healthStatus });
  }

  const now = new Date();
  const result: MountedConnectorSummary[] = [];
  for (const cw of cwRows) {
    const connector = connectorMap.get(cw.connectorId);
    if (!connector) continue;

    let status: ConnectorLiveStatus;
    if (!cw.enabled) {
      status = 'disabled';
    } else if (connector.authMode === 'none') {
      status = 'ok';
    } else {
      const secret = secretMap.get(cw.connectorId);
      if (!secret) {
        status = 'auth_expired';
      } else if (secret.tokenExpiresAt && secret.tokenExpiresAt < now) {
        status = 'auth_expired';
      } else if (secret.healthStatus === 'revoked' || secret.healthStatus === 'degraded') {
        status = 'unreachable';
      } else {
        status = 'ok';
      }
    }

    result.push({ id: connector.id, name: connector.name, authMode: connector.authMode, status });
  }

  return { ok: true, connectors: result };
}
