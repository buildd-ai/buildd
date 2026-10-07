import { db } from '@buildd/core/db';
import { connectors, connectorWorkspaces, workspaces } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { encrypt } from '@buildd/core/secrets';
import { discoverOAuthMetadata, registerClient, getCallbackUrl } from '@/lib/mcp-oauth';
import { resolveConnectorIcon } from '@/lib/connector-icon';
import { normalizeConnectorUrl, type ResolvedCatalogEntry } from '@/lib/connector-catalog';

export interface OAuthSetup {
  /** What discovery concluded. 'none' = the server answered without auth. */
  authMode: 'oauth' | 'none';
  discoveredMetadata: Record<string, unknown> | null;
  clientId: string | null;
  encryptedClientSecret: string | null;
}

/**
 * OAuth discovery (RFC 9728/8414) + dynamic client registration (RFC 7591) for
 * a connector URL. Shared by POST /api/connectors and catalog provisioning so
 * a preinstalled connector is connectable exactly like a hand-added one.
 * Throws when the server cannot be reached or yields no usable metadata.
 */
export async function discoverAndRegister(url: string, origin: string, existingClientId?: string | null): Promise<OAuthSetup> {
  const discovered = await discoverOAuthMetadata(url);
  if (discovered.authMode !== 'oauth') {
    return { authMode: 'none', discoveredMetadata: null, clientId: existingClientId ?? null, encryptedClientSecret: null };
  }
  let clientId = existingClientId ?? null;
  let encryptedClientSecret: string | null = null;
  if (!clientId && discovered.authorizationServer.registration_endpoint) {
    const dcr = await registerClient(discovered.authorizationServer.registration_endpoint, getCallbackUrl(origin));
    clientId = dcr.client_id;
    if (dcr.client_secret) encryptedClientSecret = encrypt(dcr.client_secret);
  }
  return { authMode: 'oauth', discoveredMetadata: discovered as unknown as Record<string, unknown>, clientId, encryptedClientSecret };
}

type ConnectorRow = typeof connectors.$inferSelect;

/**
 * The team's connector for a catalog entry, creating it when missing. An
 * existing connector at the same URL (or with the same name) is reused, so
 * flipping an entry to preinstalled after someone already added it by hand
 * never makes a duplicate.
 */
export async function ensureCatalogConnector(teamId: string, entry: ResolvedCatalogEntry, origin: string): Promise<ConnectorRow> {
  const owned = await db.query.connectors.findMany({ where: eq(connectors.teamId, teamId) });
  const target = normalizeConnectorUrl(entry.url);
  const existing = owned.find(c => normalizeConnectorUrl(c.url) === target) ?? owned.find(c => c.name === entry.name);
  if (existing) return existing;

  const setup: OAuthSetup = entry.authMode === 'oauth'
    ? await discoverAndRegister(entry.url, origin)
    : { authMode: 'none', discoveredMetadata: null, clientId: null, encryptedClientSecret: null };
  const iconUrl = entry.iconUrl || await resolveConnectorIcon(entry.url).catch(() => null);

  const [created] = await db.insert(connectors).values({
    teamId,
    name: entry.name,
    url: entry.url,
    transport: 'http',
    authMode: entry.authMode,
    headerName: entry.authMode === 'header' ? (entry.headerName ?? null) : null,
    discoveredMetadata: setup.discoveredMetadata,
    clientId: setup.clientId,
    encryptedClientSecret: setup.encryptedClientSecret,
    iconUrl: iconUrl || null,
  }).onConflictDoNothing().returning();
  if (created) return created;
  // Lost a race on (teamId, name): the winner's row is the one to use.
  const winner = await db.query.connectors.findFirst({ where: and(eq(connectors.teamId, teamId), eq(connectors.name, entry.name)) });
  if (!winner) throw new Error(`connector for catalog entry ${entry.slug} vanished`);
  return winner;
}

/** Enable a connector in the given workspaces (idempotent; re-enables a disabled mount). */
export async function enableConnectorInWorkspaces(connectorId: string, workspaceIds: string[]): Promise<void> {
  if (workspaceIds.length === 0) return;
  await db.insert(connectorWorkspaces)
    .values(workspaceIds.map(workspaceId => ({ connectorId, workspaceId, enabled: true })))
    .onConflictDoUpdate({
      target: [connectorWorkspaces.connectorId, connectorWorkspaces.workspaceId],
      set: { enabled: true },
    });
}

/** Preinstall one entry for a team: connector row + enabled in every team workspace. */
export async function preinstallForTeam(teamId: string, entry: ResolvedCatalogEntry, origin: string): Promise<ConnectorRow> {
  const connector = await ensureCatalogConnector(teamId, entry, origin);
  const teamWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.teamId, teamId), columns: { id: true } });
  await enableConnectorInWorkspaces(connector.id, teamWorkspaces.map(w => w.id));
  return connector;
}

/**
 * A new workspace gets every connector its team preinstalls. Best effort per
 * entry: one unreachable server never blocks workspace creation or the rest.
 */
export async function applyPreinstalledToWorkspace(
  teamId: string,
  workspaceId: string,
  origin: string,
  catalog: ResolvedCatalogEntry[],
): Promise<{ installed: string[]; failed: string[] }> {
  const installed: string[] = [];
  const failed: string[] = [];
  for (const entry of catalog.filter(e => e.policy === 'preinstalled')) {
    try {
      const connector = await ensureCatalogConnector(teamId, entry, origin);
      await enableConnectorInWorkspaces(connector.id, [workspaceId]);
      installed.push(entry.slug);
    } catch (err) {
      console.error(`[connector-catalog] preinstall ${entry.slug} into new workspace failed:`, err);
      failed.push(entry.slug);
    }
  }
  return { installed, failed };
}
