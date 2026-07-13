/**
 * Data migration (spec: docs/specs/mcp-connectors-and-roles.md §4).
 *
 * Converts every legacy `workspace_skills.mcpServers` entry (+ `requiredEnvVars`
 * for stdio) into `connectors` rows (deduplicated per team by name) and appends
 * the created connector ids to the owning role's `connectorRefs`.
 *
 * Idempotent: re-running creates 0 new connectors and changes 0 connectorRefs.
 * The guard is the connectors `(teamId, name)` uniqueness plus ref presence.
 *
 * Legacy `mcp_credential` secrets are left untouched (referenced via envMapping).
 *
 * Usage:
 *   cd packages/core && DATABASE_URL="..." bun scripts/migrate-role-mcp-to-connectors.ts
 *
 * Core logic (`migrateRoleMcpToConnectors`) is DB-agnostic — it drives a
 * `MigrationStore`. `createDrizzleStore` binds it to the real neon-http client;
 * tests bind an in-memory store. NO db.transaction (neon-http): each connector
 * is a find-then-insert guarded by the unique (teamId, name) index.
 */

import { and, eq } from 'drizzle-orm';
import { connectors, workspaceSkills } from '../db/schema';
import type { NewConnector } from '../db/schema';

// ── Types ──────────────────────────────────────────────────────────────────

/** A workspace_skills row that may carry legacy MCP config. */
export interface RoleRow {
  id: string;
  teamId: string;
  mcpServers: Record<string, unknown> | string[] | unknown;
  requiredEnvVars: Record<string, string> | null | undefined;
  connectorRefs: string[] | null | undefined;
}

/** Normalized connector shape derived from one legacy MCP server entry. */
export interface ServerSpec {
  name: string;
  transport: 'http' | 'stdio';
  url: string;
  command: string | null;
  args: string[];
  authMode: 'none';
  discoveredMetadata: Record<string, unknown> | null;
}

/** Data-access seam so the algorithm can run against real Drizzle or an in-memory fake. */
export interface MigrationStore {
  /** All workspace_skills rows (caller filters non-empty mcpServers via parse). */
  listRolesWithMcp(): Promise<RoleRow[]>;
  /** Existing connector for this team by name, or null. */
  findConnector(teamId: string, name: string): Promise<{ id: string } | null>;
  /** Insert a new connector; returns its generated id. */
  insertConnector(row: Omit<NewConnector, 'id'>): Promise<{ id: string }>;
  /** Overwrite a role's connectorRefs. */
  setRoleConnectorRefs(roleId: string, refs: string[]): Promise<void>;
}

export interface MigrationResult {
  rolesProcessed: number;
  connectorsCreated: number;
  refsChanged: number;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Turn a role's `mcpServers` value into normalized connector specs.
 *
 * - `{ name: { type:'http', url } }` → http connector (authMode none).
 * - `{ name: { command, args } }`    → stdio connector (authMode none).
 * - legacy `string[]` (e.g. ["slack"]) → http placeholder flagged needsReview.
 * - empty / malformed → [].
 */
export function parseMcpServers(mcpServers: unknown): ServerSpec[] {
  if (!mcpServers) return [];

  if (Array.isArray(mcpServers)) {
    return mcpServers
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
      .map((name) => ({
        name,
        transport: 'http' as const,
        url: '',
        command: null,
        args: [],
        authMode: 'none' as const,
        discoveredMetadata: { needsReview: true },
      }));
  }

  if (typeof mcpServers === 'object') {
    const specs: ServerSpec[] = [];
    for (const [name, cfg] of Object.entries(mcpServers as Record<string, unknown>)) {
      if (!name) continue;
      specs.push(deriveFromConfig(name, cfg));
    }
    return specs;
  }

  return [];
}

function deriveFromConfig(name: string, cfg: unknown): ServerSpec {
  const c: Record<string, unknown> =
    cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>) : {};
  const isStdio = typeof c.command === 'string' || c.type === 'stdio';

  if (isStdio) {
    return {
      name,
      transport: 'stdio',
      url: '',
      command: typeof c.command === 'string' ? (c.command as string) : null,
      args: Array.isArray(c.args) ? (c.args as unknown[]).filter((a): a is string => typeof a === 'string') : [],
      authMode: 'none',
      discoveredMetadata: null,
    };
  }

  return {
    name,
    transport: 'http',
    url: typeof c.url === 'string' ? (c.url as string) : '',
    command: null,
    args: [],
    authMode: 'none',
    discoveredMetadata: null,
  };
}

/** Build the connectors insert row for one spec, copying requiredEnvVars for stdio. */
export function buildConnectorRow(role: RoleRow, spec: ServerSpec): Omit<NewConnector, 'id'> {
  return {
    teamId: role.teamId,
    name: spec.name,
    url: spec.url,
    authMode: spec.authMode,
    transport: spec.transport,
    command: spec.command,
    args: spec.args,
    // Only stdio connectors carry env mappings; leave mcp_credential secrets in place.
    envMapping: spec.transport === 'stdio' ? { ...(role.requiredEnvVars ?? {}) } : {},
    discoveredMetadata: spec.discoveredMetadata,
  };
}

// ── Core algorithm ────────────────────────────────────────────────────────────

export async function migrateRoleMcpToConnectors(store: MigrationStore): Promise<MigrationResult> {
  const roles = await store.listRolesWithMcp();
  let rolesProcessed = 0;
  let connectorsCreated = 0;
  let refsChanged = 0;

  for (const role of roles) {
    const specs = parseMcpServers(role.mcpServers);
    if (specs.length === 0) continue;
    rolesProcessed++;

    const refs = Array.isArray(role.connectorRefs) ? [...role.connectorRefs] : [];
    let changed = false;

    for (const spec of specs) {
      // Dedup on (teamId, name): reuse an existing connector, else create one.
      let connector = await store.findConnector(role.teamId, spec.name);
      if (!connector) {
        connector = await store.insertConnector(buildConnectorRow(role, spec));
        connectorsCreated++;
      }
      if (!refs.includes(connector.id)) {
        refs.push(connector.id);
        changed = true;
      }
    }

    if (changed) {
      await store.setRoleConnectorRefs(role.id, refs);
      refsChanged++;
    }
  }

  return { rolesProcessed, connectorsCreated, refsChanged };
}

// ── Drizzle-backed store ───────────────────────────────────────────────────────

type DrizzleDb = {
  select: (...a: any[]) => any;
  insert: (...a: any[]) => any;
  update: (...a: any[]) => any;
};

export function createDrizzleStore(db: DrizzleDb): MigrationStore {
  return {
    async listRolesWithMcp() {
      const rows = await db
        .select({
          id: workspaceSkills.id,
          teamId: workspaceSkills.teamId,
          mcpServers: workspaceSkills.mcpServers,
          requiredEnvVars: workspaceSkills.requiredEnvVars,
          connectorRefs: workspaceSkills.connectorRefs,
        })
        .from(workspaceSkills);
      // Filter to rows with actual MCP config; parse handles the exact shapes.
      return (rows as RoleRow[]).filter((r) => parseMcpServers(r.mcpServers).length > 0);
    },

    async findConnector(teamId: string, name: string) {
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
        .returning({ id: connectors.id });
      return inserted[0];
    },

    async setRoleConnectorRefs(roleId: string, refs: string[]) {
      await db
        .update(workspaceSkills)
        .set({ connectorRefs: refs, updatedAt: new Date() })
        .where(eq(workspaceSkills.id, roleId));
    },
  };
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────

if (import.meta.main) {
  (async () => {
    const { db } = await import('../db');
    const store = createDrizzleStore(db as unknown as DrizzleDb);
    const result = await migrateRoleMcpToConnectors(store);
    console.log(
      `Migration complete: processed ${result.rolesProcessed} role(s), ` +
        `created ${result.connectorsCreated} connector(s), ` +
        `updated ${result.refsChanged} role connectorRefs.`,
    );
    process.exit(0);
  })().catch((err) => {
    console.error('Migration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
