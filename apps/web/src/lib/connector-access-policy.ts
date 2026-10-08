/**
 * Runtime enforcement of a team's catalog policy on connectors that already
 * exist. Blocking a catalog entry (PUT /api/connectors/catalog/policy) never
 * deletes the team's connector or its provider credential — it stops agents
 * from using it. Every boundary that hands a connector to an agent asks this
 * module first: the claim pre-filter, claim-time MCP injection, the assertion
 * mint, the worker-facing mounted list, and the OAuth connect/callback.
 *
 * A connector matches a catalog entry by normalized URL (the same key
 * catalogEntryForUrl uses). It is blocked for a task when EITHER the team
 * consuming it (the task's workspace team) OR the team that owns it has
 * blocked that entry: the consumer decides what its agents may touch, and an
 * owner's block must not be side-stepped by sharing the connector out.
 *
 * Spec: docs/specs/mcp-connectors-and-roles.md §5a.
 */
import { db } from '@buildd/core/db';
import { connectorCatalogTeamPolicies } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { normalizeConnectorUrl, type ResolvedCatalogEntry } from '@/lib/connector-catalog';
import { loadTeamCatalog } from '@/lib/connector-catalog-store';

/** Why a connector is blocked: which team's policy, on which catalog entry. */
export interface ConnectorBlock {
  slug: string;
  name: string;
  blockedByTeamId: string;
}

/** Per team: normalized URL → the blocked catalog entry at that URL. */
export type BlockedCatalogs = Map<string, Map<string, { slug: string; name: string }>>;

/** Index a team's merged catalog by the URLs of its blocked entries. Pure. */
export function blockedUrlIndex(catalog: readonly ResolvedCatalogEntry[]): Map<string, { slug: string; name: string }> {
  const index = new Map<string, { slug: string; name: string }>();
  for (const e of catalog) {
    if (e.policy !== 'blocked') continue;
    const key = normalizeConnectorUrl(e.url);
    if (key) index.set(key, { slug: e.slug, name: e.name });
  }
  return index;
}

/**
 * Is this connector blocked for a task in `consumingTeamId`? Checks the
 * consuming team first, then the owner team. Pure.
 */
export function connectorBlock(
  connector: { url: string | null; teamId: string },
  consumingTeamId: string,
  blocked: BlockedCatalogs,
): ConnectorBlock | null {
  const key = connector.url ? normalizeConnectorUrl(connector.url) : null;
  if (!key) return null;
  for (const teamId of [consumingTeamId, connector.teamId]) {
    const hit = blocked.get(teamId)?.get(key);
    if (hit) return { ...hit, blockedByTeamId: teamId };
  }
  return null;
}

/**
 * Load the blocked-entry index for each team. One query when no team blocks
 * anything (the common case); the merged catalog is only built for teams that
 * have at least one 'blocked' policy row. Throws on DB failure — callers on an
 * agent boundary must fail closed, not mount a connector they could not check.
 */
export async function loadBlockedCatalogs(teamIds: readonly string[]): Promise<BlockedCatalogs> {
  const out: BlockedCatalogs = new Map();
  const unique = [...new Set(teamIds.filter(Boolean))];
  if (unique.length === 0) return out;
  const rows = await db.query.connectorCatalogTeamPolicies.findMany({
    where: and(
      inArray(connectorCatalogTeamPolicies.teamId, unique),
      eq(connectorCatalogTeamPolicies.policy, 'blocked'),
    ),
    columns: { teamId: true },
  });
  const blockingTeams = [...new Set(rows.map(r => r.teamId))];
  await Promise.all(blockingTeams.map(async (teamId) => {
    out.set(teamId, blockedUrlIndex(await loadTeamCatalog(teamId)));
  }));
  return out;
}

/** Convenience for a single connector at a single boundary. */
export async function checkConnectorBlocked(
  connector: { url: string | null; teamId: string },
  consumingTeamId: string,
): Promise<ConnectorBlock | null> {
  const blocked = await loadBlockedCatalogs([consumingTeamId, connector.teamId]);
  return connectorBlock(connector, consumingTeamId, blocked);
}

/** Error body every boundary returns for a blocked connector. */
export function blockedBody(block: ConnectorBlock) {
  return {
    error: 'blocked_by_policy',
    slug: block.slug,
    message: `${block.name} is blocked by your team's connector policy. A team admin can unblock it in Settings → MCP connectors; the saved connection is kept.`,
  };
}
