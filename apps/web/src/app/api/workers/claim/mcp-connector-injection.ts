/**
 * MCP connector injection — resolves which MCP servers a claimed task's agent
 * mounts, and attaches them to the claim response.
 *
 * Spec: docs/specs/mcp-connectors-and-roles.md §2/§3.
 *
 * Connectors are the single source of truth for MCP servers. A connector reaches
 * the agent for a task iff:
 *   role.connectorRefs  ∩  enabledForWorkspace  ∩  teamConnectors
 * where the role is resolved from the task's roleSlug (workspace override > team
 * default). No role or empty connectorRefs → mount nothing (least-privilege).
 *
 * Credentials are resolved by the connector's OWNER team (connector.teamId), not
 * the task's workspace team. Today they are equal; keying on the owner makes the
 * Phase-2 cross-team sharing a pure visibility widening (no injection rewrite).
 */
import { db } from '@buildd/core/db';
import {
  connectors,
  connectorShares,
  connectorWorkspaces,
  secrets,
  workspaceSkills,
} from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { ClaimTasksResponse } from '@buildd/shared';
import type { SecretsProvider } from '@buildd/core/secrets';
import { refreshMcpConnectorCredential } from '@/lib/mcp-connector-refresh';

// Slugify a connector name into the MCP server key used in queryOptions.mcpServers.
// Connector names are already slug-shaped (uniqueness is on (teamId, name)), but we
// normalize defensively so the runner-side key is deterministic.
export function slugifyConnectorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || name.toLowerCase();
}

// A single MCP connector entry resolved at claim time. Superset of the http-only
// shared type — the runner keys behaviour off `transport`.
export type ResolvedMcpConnector = {
  id?: string;
  name: string;
  transport: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  // assertion-mode exchange metadata (assertionMode=true → runner performs mint+exchange)
  assertionMode?: true;
  mintApiUrl?: string;
  audience?: string;
  tokenEndpoint?: string;
};

/**
 * Resolve the connectors one claimed task should mount. Returns `[]` for every
 * "mount nothing" outcome (no team, no role, no refs, nothing visible/enabled)
 * so the caller never has to distinguish them.
 */
export async function resolveMcpConnectorsForTask(
  task: any,
  now: Date,
  connectorProvider: SecretsProvider,
): Promise<ResolvedMcpConnector[]> {
  const workspaceTeamId = task?.workspace?.teamId as string | undefined;
  if (!workspaceTeamId) return [];

  // Resolve the task's role → connectorRefs. No role slug → no opt-in (§2 AC-3).
  const roleSlug = task?.roleSlug as string | null;
  if (!roleSlug) return [];

  const roleRows = await db.query.workspaceSkills.findMany({
    where: and(
      eq(workspaceSkills.slug, roleSlug),
      eq(workspaceSkills.isRole, true),
      eq(workspaceSkills.enabled, true),
      eq(workspaceSkills.teamId, workspaceTeamId),
      or(
        isNull(workspaceSkills.workspaceId),
        eq(workspaceSkills.workspaceId, task.workspaceId),
      ),
    ),
    columns: { connectorRefs: true, workspaceId: true },
  });
  if (roleRows.length === 0) return [];

  // Workspace-scoped override wins over the team-default row.
  const role = roleRows.find(r => (r as any).workspaceId) ?? roleRows[0];
  const connectorRefs = ((role as any).connectorRefs as string[] | null) ?? [];
  if (connectorRefs.length === 0) return [];

  // Cross-team sharing (§1b): visibility = owned ∪ shared-in. Fetch the
  // share grants for this team first, then keep only referenced connectors
  // that are owned by the task's team OR shared to it. A revoked share
  // (row absent) drops the connector here — no orphaned injection (§1b AC-5).
  // A dangling ref (deleted / invisible connector) simply drops out (§2 AC-4).
  const shareRows = await db.query.connectorShares.findMany({
    where: and(
      eq(connectorShares.sharedWithTeamId, workspaceTeamId),
      inArray(connectorShares.connectorId, connectorRefs),
    ),
    columns: { connectorId: true },
  });
  const sharedIdSet = new Set(shareRows.map(r => r.connectorId));

  const referencedRows = await db.query.connectors.findMany({
    where: inArray(connectors.id, connectorRefs),
  });
  const referencedConnectors = referencedRows.filter(
    c => c.teamId === workspaceTeamId || sharedIdSet.has(c.id),
  );
  if (referencedConnectors.length === 0) return [];

  // Filter to connectors enabled for this workspace (enabled !== false; a
  // missing connector_workspaces row is treated as enabled).
  const cwRows = await db.query.connectorWorkspaces.findMany({
    where: and(
      eq(connectorWorkspaces.workspaceId, task.workspaceId),
      inArray(connectorWorkspaces.connectorId, referencedConnectors.map(c => c.id)),
    ),
  });
  const cwMap = new Map(cwRows.map(r => [r.connectorId, r.enabled]));
  const activeConnectors = referencedConnectors.filter(c => cwMap.get(c.id) !== false);
  if (activeConnectors.length === 0) return [];

  const ownerTeamIds = [...new Set(activeConnectors.map(c => c.teamId))];

  // header/oauth credentials — keyed on the OWNER team (secrets.teamId = connector.teamId).
  const authConnectorIds = activeConnectors
    .filter(c => c.authMode === 'header' || c.authMode === 'oauth')
    .map(c => c.id);
  const connectorSecretMap = new Map<string, { id: string; tokenExpiresAt: Date | null }>();
  if (authConnectorIds.length > 0) {
    const connectorSecretRows = await db.query.secrets.findMany({
      where: and(
        inArray(secrets.teamId, ownerTeamIds),
        eq(secrets.purpose, 'mcp_connector_credential'),
        inArray(secrets.label, authConnectorIds),
      ),
      columns: { id: true, label: true, tokenExpiresAt: true },
    });
    for (const s of connectorSecretRows) {
      if (s.label) connectorSecretMap.set(s.label, { id: s.id, tokenExpiresAt: s.tokenExpiresAt ?? null });
    }
  }

  // stdio env-var credentials — mcp_credential secrets referenced by envMapping,
  // keyed on the owner team + secret label.
  const envLabels = [...new Set(
    activeConnectors
      .filter(c => c.transport === 'stdio')
      .flatMap(c => Object.values((c.envMapping as Record<string, string> | null) ?? {})),
  )];
  // Keyed by `${ownerTeamId}\0${label}` — the same label can exist in
  // several owner teams (§1b), and each connector must only ever see its
  // OWN team's secret value.
  const envSecretMap = new Map<string, string>();
  if (envLabels.length > 0) {
    const envSecretRows = await db.query.secrets.findMany({
      where: and(
        inArray(secrets.teamId, ownerTeamIds),
        eq(secrets.purpose, 'mcp_credential'),
        inArray(secrets.label, envLabels),
      ),
      columns: { id: true, label: true, teamId: true },
    });
    await Promise.all(envSecretRows.map(async (s) => {
      if (!s.label || !s.teamId) return;
      const val = await connectorProvider.get(s.id);
      if (val) envSecretMap.set(`${s.teamId}\0${s.label}`, val);
    }));
  }

  const mcpConnectors: ResolvedMcpConnector[] = [];

  // Slug-collision precedence (§1b): if an owned and a shared-in connector
  // slugify to the same MCP key, the OWNED one wins — process owned
  // connectors first and drop any later connector whose key is already
  // claimed (deterministic, no double-mount).
  const orderedConnectors = [
    ...activeConnectors.filter(c => c.teamId === workspaceTeamId),
    ...activeConnectors.filter(c => c.teamId !== workspaceTeamId),
  ];
  const claimedNames = new Set<string>();

  for (const connector of orderedConnectors) {
    const name = slugifyConnectorName(connector.name);
    if (claimedNames.has(name)) continue;
    claimedNames.add(name);

    // stdio transport: spawn a local process; env resolved from envMapping.
    // No headers, no url. Omit if a mapped secret is missing (AC-4 parity).
    if (connector.transport === 'stdio') {
      if (!connector.command) continue;
      const mapping = (connector.envMapping as Record<string, string> | null) ?? {};
      const env: Record<string, string> = {};
      let missing = false;
      for (const [envVar, label] of Object.entries(mapping)) {
        const val = envSecretMap.get(`${connector.teamId}\0${label}`);
        if (!val) { missing = true; break; }
        env[envVar] = val;
      }
      if (missing) continue;
      mcpConnectors.push({
        name,
        transport: 'stdio',
        command: connector.command,
        args: (connector.args as string[] | null) ?? [],
        ...(Object.keys(env).length > 0 ? { env } : {}),
      });
      continue;
    }

    // http transport.
    if (!connector.url) continue;

    if (connector.authMode === 'none') {
      mcpConnectors.push({ id: connector.id, name, transport: 'http', url: connector.url });
      continue;
    }

    // assertion-mode: return exchange metadata so the runner can mint+exchange
    if (connector.authMode === 'assertion') {
      if (!connector.assertionAudience || !connector.assertionTokenEndpoint) continue;
      mcpConnectors.push({
        id: connector.id,
        name,
        transport: 'http',
        url: connector.url,
        assertionMode: true,
        mintApiUrl: `https://buildd.dev/api/connectors/${connector.id}/assertion`,
        audience: connector.assertionAudience,
        tokenEndpoint: connector.assertionTokenEndpoint,
      });
      continue;
    }

    const secretInfo = connectorSecretMap.get(connector.id);
    if (!secretInfo) continue; // missing credential → omit (AC-4)

    if (connector.authMode === 'oauth') {
      // Refresh an expired access token at claim time; omit on unrecoverable failure (AC-3).
      if (secretInfo.tokenExpiresAt && new Date(secretInfo.tokenExpiresAt) < now) {
        const result = await refreshMcpConnectorCredential(secretInfo.id);
        if (result !== 'refreshed' && result !== 'locked') continue;
      }
      const decryptedValue = await connectorProvider.get(secretInfo.id);
      if (!decryptedValue) continue;
      try {
        const tokenBlob = JSON.parse(decryptedValue) as Record<string, unknown>;
        const accessToken = tokenBlob.access_token as string | undefined;
        if (!accessToken) continue;
        mcpConnectors.push({
          id: connector.id,
          name,
          transport: 'http',
          url: connector.url,
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      } catch {
        // Malformed JSON blob — skip
      }
    } else if (connector.authMode === 'header') {
      const decryptedValue = await connectorProvider.get(secretInfo.id);
      if (!decryptedValue) continue;
      mcpConnectors.push({
        id: connector.id,
        name,
        transport: 'http',
        url: connector.url,
        headers: { [connector.headerName!]: decryptedValue },
      });
    }
  }

  return mcpConnectors;
}

/**
 * Attach `mcpConnectors` to each claimed worker.
 *
 * The try/catch deliberately wraps the whole loop rather than each worker: a
 * failure here must never fail the claim, and the pre-extraction behaviour was
 * to abandon injection for the remaining workers too.
 */
export async function attachMcpConnectors(
  claimedWorkers: ClaimTasksResponse['workers'],
  now: Date,
  connectorProvider: SecretsProvider,
): Promise<void> {
  try {
    for (const cw of claimedWorkers) {
      const mcpConnectors = await resolveMcpConnectorsForTask(cw.task as any, now, connectorProvider);
      if (mcpConnectors.length > 0) {
        (cw as any).mcpConnectors = mcpConnectors;
      }
    }
  } catch (err) {
    console.warn('Failed to inject MCP connector configs:', err);
  }
}
