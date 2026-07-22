/**
 * Seed script: Wire email-agent role to use the Cue MCP connector via assertion-grant.
 *
 * What this does:
 *   1. Looks up the cue workspace to get its teamId.
 *   2. Upserts a `connectors` row for the Cue MCP server (authMode='assertion').
 *   3. Enables the connector for the cue workspace via `connector_workspaces`.
 *   4. Updates the email-agent role: adds the connector ID to `connectorRefs`,
 *      clears `mcpServers` (set to {}), and clears `requiredEnvVars` (set to {}).
 *
 * Idempotent: re-running is a no-op (ON CONFLICT DO NOTHING + ref-presence check).
 *
 * Usage:
 *   cd packages/core && DATABASE_URL="..." bun scripts/seed-cue-connector.ts
 *
 * Core logic (`seedCueConnector`) is DB-agnostic — it drives a `SeedStore`.
 * `createDrizzleStore` binds it to the real neon-http client; tests bind an in-memory store.
 */

import { and, eq } from 'drizzle-orm';
import { connectors, connectorWorkspaces, workspaces, workspaceSkills } from '../db/schema';
import type { NewConnector } from '../db/schema';

// ── Constants ──────────────────────────────────────────────────────────────────

export const CUE_WORKSPACE_ID = 'c3ecacc4-a77a-468c-9d1a-389f41c9434f';
export const CUE_CONNECTOR_NAME = 'cue';
export const CUE_CONNECTOR_URL = 'https://cue.buildd.dev/api/mcp';
export const CUE_ASSERTION_AUDIENCE = 'https://cue.buildd.dev/api/mcp';
export const CUE_ASSERTION_TOKEN_ENDPOINT = 'https://cue.buildd.dev/api/oauth/token';
export const EMAIL_AGENT_SLUG = 'email-agent';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface WorkspaceRow {
  id: string;
  teamId: string;
}

export interface RoleRow {
  id: string;
  connectorRefs: string[];
  mcpServers: Record<string, unknown>;
  requiredEnvVars: Record<string, string>;
}

export interface SeedStore {
  /** Find a workspace by ID, returns its teamId. */
  findWorkspace(workspaceId: string): Promise<WorkspaceRow | null>;
  /** Find an existing connector by (teamId, name). */
  findConnector(teamId: string, name: string): Promise<{ id: string } | null>;
  /** Insert a new connector; returns its generated id. */
  insertConnector(row: Omit<NewConnector, 'id'>): Promise<{ id: string }>;
  /** Enable the connector for the workspace (ON CONFLICT DO NOTHING). */
  upsertConnectorWorkspace(connectorId: string, workspaceId: string): Promise<void>;
  /** Find the email-agent role in the workspace. */
  findEmailAgentRole(workspaceId: string, slug: string): Promise<RoleRow | null>;
  /** Update the email-agent role's connector wiring. */
  updateEmailAgentRole(
    roleId: string,
    connectorRefs: string[],
    mcpServers: Record<string, unknown>,
    requiredEnvVars: Record<string, string>,
  ): Promise<void>;
}

export interface SeedResult {
  workspaceFound: boolean;
  connectorCreated: boolean;
  connectorId: string | null;
  workspaceEnabled: boolean;
  roleUpdated: boolean;
}

// ── Core logic ─────────────────────────────────────────────────────────────────

export async function seedCueConnector(
  store: SeedStore,
  workspaceId = CUE_WORKSPACE_ID,
): Promise<SeedResult> {
  const result: SeedResult = {
    workspaceFound: false,
    connectorCreated: false,
    connectorId: null,
    workspaceEnabled: false,
    roleUpdated: false,
  };

  // 1. Find the workspace to get teamId.
  const ws = await store.findWorkspace(workspaceId);
  if (!ws) return result;
  result.workspaceFound = true;

  // 2. Upsert the Cue connector for the team.
  let connector = await store.findConnector(ws.teamId, CUE_CONNECTOR_NAME);
  if (!connector) {
    connector = await store.insertConnector({
      teamId: ws.teamId,
      name: CUE_CONNECTOR_NAME,
      url: CUE_CONNECTOR_URL,
      authMode: 'assertion',
      transport: 'http',
      command: null,
      args: [],
      envMapping: {},
      assertionAudience: CUE_ASSERTION_AUDIENCE,
      assertionTokenEndpoint: CUE_ASSERTION_TOKEN_ENDPOINT,
    });
    result.connectorCreated = true;
  }
  result.connectorId = connector.id;

  // 3. Enable the connector for the workspace.
  await store.upsertConnectorWorkspace(connector.id, workspaceId);
  result.workspaceEnabled = true;

  // 4. Update the email-agent role.
  const role = await store.findEmailAgentRole(workspaceId, EMAIL_AGENT_SLUG);
  if (role) {
    const refs = Array.isArray(role.connectorRefs) ? role.connectorRefs : [];
    // Only update if we need to add the ref or clear old config.
    const needsRefAdd = !refs.includes(connector.id);
    const hasStaleMcpServers = Object.keys(role.mcpServers ?? {}).length > 0;
    const hasStaleEnvVars = Object.keys(role.requiredEnvVars ?? {}).length > 0;

    if (needsRefAdd || hasStaleMcpServers || hasStaleEnvVars) {
      const newRefs = needsRefAdd ? [...refs, connector.id] : refs;
      await store.updateEmailAgentRole(role.id, newRefs, {}, {});
      result.roleUpdated = true;
    }
  }

  return result;
}

// ── Drizzle-backed store ───────────────────────────────────────────────────────

type DrizzleDb = {
  select: (...a: any[]) => any;
  insert: (...a: any[]) => any;
  update: (...a: any[]) => any;
};

export function createDrizzleStore(db: DrizzleDb): SeedStore {
  return {
    async findWorkspace(workspaceId) {
      const rows = await db
        .select({ id: workspaces.id, teamId: workspaces.teamId })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      return rows[0] ?? null;
    },

    async findConnector(teamId, name) {
      const rows = await db
        .select({ id: connectors.id })
        .from(connectors)
        .where(and(eq(connectors.teamId, teamId), eq(connectors.name, name)))
        .limit(1);
      return rows[0] ?? null;
    },

    async insertConnector(row) {
      const inserted = await db
        .insert(connectors)
        .values(row)
        .onConflictDoNothing()
        .returning({ id: connectors.id });
      // If onConflictDoNothing fired (race), fall back to a find.
      if (inserted[0]) return inserted[0];
      const found = await db
        .select({ id: connectors.id })
        .from(connectors)
        .where(and(eq(connectors.teamId, row.teamId), eq(connectors.name, row.name)))
        .limit(1);
      return found[0];
    },

    async upsertConnectorWorkspace(connectorId, workspaceId) {
      await db
        .insert(connectorWorkspaces)
        .values({ connectorId, workspaceId, enabled: true })
        .onConflictDoNothing();
    },

    async findEmailAgentRole(workspaceId, slug) {
      const rows = await db
        .select({
          id: workspaceSkills.id,
          connectorRefs: workspaceSkills.connectorRefs,
          mcpServers: workspaceSkills.mcpServers,
          requiredEnvVars: workspaceSkills.requiredEnvVars,
        })
        .from(workspaceSkills)
        .where(
          and(eq(workspaceSkills.workspaceId, workspaceId), eq(workspaceSkills.slug, slug)),
        )
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        connectorRefs: Array.isArray(r.connectorRefs) ? r.connectorRefs : [],
        mcpServers: (r.mcpServers as Record<string, unknown>) ?? {},
        requiredEnvVars: (r.requiredEnvVars as Record<string, string>) ?? {},
      };
    },

    async updateEmailAgentRole(roleId, connectorRefs, mcpServers, requiredEnvVars) {
      await db
        .update(workspaceSkills)
        .set({ connectorRefs, mcpServers, requiredEnvVars, updatedAt: new Date() })
        .where(eq(workspaceSkills.id, roleId));
    },
  };
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────

if (import.meta.main) {
  (async () => {
    const { db } = await import('../db');
    const store = createDrizzleStore(db as unknown as DrizzleDb);
    const result = await seedCueConnector(store);

    if (!result.workspaceFound) {
      console.error(`Workspace ${CUE_WORKSPACE_ID} not found — is DATABASE_URL pointing at the right DB?`);
      process.exit(1);
    }

    console.log(`Connector: ${result.connectorCreated ? 'created' : 'already existed'} (id=${result.connectorId})`);
    console.log(`Workspace link: ${result.workspaceEnabled ? 'enabled' : 'skipped (already existed)'}`);
    console.log(`email-agent role: ${result.roleUpdated ? 'updated connectorRefs + cleared mcpServers/requiredEnvVars' : 'no change needed (already wired)'}`);
    console.log('\nDone!');
    process.exit(0);
  })().catch((err) => {
    console.error('Seed failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
