/**
 * Server-side loader for capability discovery (rules: capability-discovery.ts).
 * Reads only rows of the workspace's own team: connectors it owns or was
 * shared, this workspace's enablement, credential health keyed on each
 * connector's owner team, the team's roles and catalog policy. Selects no
 * credential value. Visibility mirrors claim/mcp-connector-injection.ts.
 */
import { db } from '@buildd/core/db';
import { connectors, connectorShares, connectorWorkspaces, workspaces, workspaceSkills } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { teamCredentialWhere } from '@buildd/core/secrets/team-scope';
import { loadTeamCatalog } from './connector-catalog-store';
import { loadOperatorGrant } from './operator-capability-source';
import type { DiscoveryCredential, DiscoveryInput, DiscoveryRole } from './capability-discovery';

export async function loadDiscoveryInput(
  workspaceId: string,
  roleSlug: string | null,
  now: Date = new Date(),
): Promise<DiscoveryInput | null> {
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { teamId: true } });
  if (!ws?.teamId) return null;
  const teamId = ws.teamId;

  const [catalog, shareRows, roleRows, operatorGrant] = await Promise.all([
    loadTeamCatalog(teamId),
    db.query.connectorShares.findMany({ where: eq(connectorShares.sharedWithTeamId, teamId), columns: { connectorId: true } }),
    db.query.workspaceSkills.findMany({
      where: and(
        eq(workspaceSkills.teamId, teamId),
        eq(workspaceSkills.isRole, true),
        eq(workspaceSkills.enabled, true),
        or(isNull(workspaceSkills.workspaceId), eq(workspaceSkills.workspaceId, workspaceId)),
      ),
      columns: { slug: true, workspaceId: true, connectorRefs: true, allowedTools: true },
    }),
    roleSlug ? loadOperatorGrant(workspaceId, roleSlug) : Promise.resolve(null),
  ]);

  const sharedIds = shareRows.map(r => r.connectorId);
  const connectorRows = await db.query.connectors.findMany({
    where: sharedIds.length > 0
      ? or(eq(connectors.teamId, teamId), inArray(connectors.id, sharedIds))
      : eq(connectors.teamId, teamId),
    columns: { id: true, name: true, url: true, authMode: true, transport: true, command: true, teamId: true },
  });
  const ids = connectorRows.map(c => c.id);
  const ownerTeamIds = [...new Set(connectorRows.map(c => c.teamId))];

  const [cwRows, secretRows] = ids.length === 0 ? [[], []] : await Promise.all([
    db.query.connectorWorkspaces.findMany({
      where: and(eq(connectorWorkspaces.workspaceId, workspaceId), inArray(connectorWorkspaces.connectorId, ids)),
      columns: { connectorId: true, enabled: true },
    }),
    db.query.secrets.findMany({
      where: teamCredentialWhere({ teamId: ownerTeamIds, purpose: 'mcp_connector_credential', label: ids }),
      columns: { label: true, teamId: true, tokenExpiresAt: true, lastVerificationError: true, healthStatus: true },
    }),
  ]);

  // A credential counts only under its connector's OWNER team: the same label
  // in another team is that team's business, never this connector's health.
  const ownerOf = new Map(connectorRows.map(c => [c.id, c.teamId]));
  const credentials = new Map<string, DiscoveryCredential>();
  for (const s of secretRows) {
    if (!s.label || s.teamId !== ownerOf.get(s.label)) continue;
    credentials.set(s.label, { tokenExpiresAt: s.tokenExpiresAt, lastVerificationError: s.lastVerificationError, healthStatus: s.healthStatus });
  }

  // Effective role per slug: the workspace row wins over the team row.
  const bySlug = new Map<string, (typeof roleRows)[number]>();
  for (const r of roleRows) {
    const cur = bySlug.get(r.slug);
    if (!cur || (r.workspaceId && !cur.workspaceId)) bySlug.set(r.slug, r);
  }
  const roles: DiscoveryRole[] = [...bySlug.values()].map(r => ({
    slug: r.slug,
    connectorRefs: (r.connectorRefs as string[] | null) ?? [],
    allowedTools: (r.allowedTools as string[] | null) ?? [],
  }));

  return {
    teamId,
    catalog,
    connectors: connectorRows.map(c => ({
      id: c.id, name: c.name, url: c.url, authMode: c.authMode, transport: c.transport, command: c.command, ownerTeamId: c.teamId,
    })),
    workspaceEnablement: new Map(cwRows.map(r => [r.connectorId, r.enabled])),
    credentials,
    roles,
    roleSlug,
    operatorGrant: operatorGrant
      ? { roleSlug: operatorGrant.roleSlug, enabled: operatorGrant.enabled, capabilities: operatorGrant.capabilities, providers: operatorGrant.scope.providers }
      : null,
    now,
  };
}
