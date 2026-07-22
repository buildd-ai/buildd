/**
 * Tests for seed-cue-connector.ts core logic.
 *
 * Drives an in-memory SeedStore so no DB or mocks are needed.
 * Assertions cover:
 *   - email-agent gains connectorRefs with the Cue assertion connector
 *   - connector is created with correct authMode / URLs
 *   - mcpServers and requiredEnvVars are cleared on the role
 *   - idempotency: a second run does not duplicate the connector or re-update the role
 *   - missing workspace short-circuits with workspaceFound=false
 */

import { describe, it, expect } from 'bun:test';
import {
  seedCueConnector,
  CUE_CONNECTOR_NAME,
  CUE_CONNECTOR_URL,
  CUE_ASSERTION_AUDIENCE,
  CUE_ASSERTION_TOKEN_ENDPOINT,
  EMAIL_AGENT_SLUG,
  type SeedStore,
  type WorkspaceRow,
  type RoleRow,
} from '../scripts/seed-cue-connector';
import type { NewConnector } from '../db/schema';

// ── In-memory store ────────────────────────────────────────────────────────────

interface StoredConnector extends Omit<NewConnector, 'id'> {
  id: string;
}

interface StoredConnectorWorkspace {
  connectorId: string;
  workspaceId: string;
  enabled: boolean;
}

function makeStore(opts: {
  workspace?: WorkspaceRow;
  role?: RoleRow & { workspaceId: string; slug: string };
}) {
  let connectorCounter = 0;
  const storedConnectors: StoredConnector[] = [];
  const storedCwRows: StoredConnectorWorkspace[] = [];
  const roleStore: Map<string, RoleRow & { workspaceId: string; slug: string }> = new Map();

  if (opts.role) roleStore.set(opts.role.id, { ...opts.role });

  const store: SeedStore = {
    async findWorkspace(workspaceId) {
      if (opts.workspace?.id === workspaceId) return opts.workspace;
      return null;
    },

    async findConnector(teamId, name) {
      const found = storedConnectors.find((c) => c.teamId === teamId && c.name === name);
      return found ? { id: found.id } : null;
    },

    async insertConnector(row) {
      // Race-safe: check again before inserting (ON CONFLICT DO NOTHING semantics)
      const existing = storedConnectors.find((c) => c.teamId === row.teamId && c.name === row.name);
      if (existing) return { id: existing.id };
      const id = `conn-${++connectorCounter}`;
      storedConnectors.push({ id, ...(row as Omit<NewConnector, 'id'>) });
      return { id };
    },

    async upsertConnectorWorkspace(connectorId, workspaceId) {
      const exists = storedCwRows.find(
        (r) => r.connectorId === connectorId && r.workspaceId === workspaceId,
      );
      if (!exists) storedCwRows.push({ connectorId, workspaceId, enabled: true });
    },

    async findEmailAgentRole(workspaceId, slug) {
      for (const r of roleStore.values()) {
        if (r.workspaceId === workspaceId && r.slug === slug) return r;
      }
      return null;
    },

    async updateEmailAgentRole(roleId, connectorRefs, mcpServers, requiredEnvVars) {
      const r = roleStore.get(roleId);
      if (r) {
        r.connectorRefs = [...connectorRefs];
        r.mcpServers = { ...mcpServers };
        r.requiredEnvVars = { ...requiredEnvVars };
      }
    },
  };

  return { store, storedConnectors, storedCwRows, roleStore };
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const WS: WorkspaceRow = { id: 'ws-cue', teamId: 'team-x' };

const EMAIL_AGENT_ROLE = {
  id: 'role-email',
  workspaceId: WS.id,
  slug: EMAIL_AGENT_SLUG,
  connectorRefs: [] as string[],
  mcpServers: {
    cue: {
      type: 'http',
      url: 'https://cue.buildd.dev/api/mcp',
      headers: { 'x-api-key': '${DISPATCH_API_KEY}', 'x-tenant-id': '${TENANT_ID}' },
    },
  } as Record<string, unknown>,
  requiredEnvVars: { DISPATCH_API_KEY: 'Cue MCP API key', TENANT_ID: 'Cue MCP tenant ID' },
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('seedCueConnector', () => {
  it('creates an assertion connector and wires it to the email-agent role', async () => {
    const { store, storedConnectors, storedCwRows, roleStore } = makeStore({
      workspace: WS,
      role: { ...EMAIL_AGENT_ROLE },
    });

    const result = await seedCueConnector(store, WS.id);

    expect(result.workspaceFound).toBe(true);
    expect(result.connectorCreated).toBe(true);
    expect(result.workspaceEnabled).toBe(true);
    expect(result.roleUpdated).toBe(true);
    expect(result.connectorId).toBeTruthy();

    // Connector row has correct assertion fields.
    const conn = storedConnectors.find((c) => c.name === CUE_CONNECTOR_NAME);
    expect(conn).toBeDefined();
    expect(conn!.teamId).toBe(WS.teamId);
    expect(conn!.authMode).toBe('assertion');
    expect(conn!.transport).toBe('http');
    expect(conn!.url).toBe(CUE_CONNECTOR_URL);
    expect(conn!.assertionAudience).toBe(CUE_ASSERTION_AUDIENCE);
    expect(conn!.assertionTokenEndpoint).toBe(CUE_ASSERTION_TOKEN_ENDPOINT);

    // Connector is enabled for the workspace.
    const cwRow = storedCwRows.find(
      (r) => r.connectorId === conn!.id && r.workspaceId === WS.id,
    );
    expect(cwRow).toBeDefined();
    expect(cwRow!.enabled).toBe(true);

    // email-agent role has the connector in connectorRefs.
    const role = roleStore.get(EMAIL_AGENT_ROLE.id)!;
    expect(role.connectorRefs).toContain(conn!.id);

    // Legacy mcpServers and requiredEnvVars are cleared.
    expect(role.mcpServers).toEqual({});
    expect(role.requiredEnvVars).toEqual({});
  });

  it('is idempotent — second run creates nothing and does not update the role', async () => {
    const { store, storedConnectors, storedCwRows, roleStore } = makeStore({
      workspace: WS,
      role: { ...EMAIL_AGENT_ROLE },
    });

    const first = await seedCueConnector(store, WS.id);
    expect(first.connectorCreated).toBe(true);
    expect(first.roleUpdated).toBe(true);

    const connCountAfterFirst = storedConnectors.length;
    const cwCountAfterFirst = storedCwRows.length;
    const refsSnapshot = [...roleStore.get(EMAIL_AGENT_ROLE.id)!.connectorRefs];

    const second = await seedCueConnector(store, WS.id);
    expect(second.connectorCreated).toBe(false);
    expect(second.roleUpdated).toBe(false);
    expect(storedConnectors.length).toBe(connCountAfterFirst);
    expect(storedCwRows.length).toBe(cwCountAfterFirst);
    expect(roleStore.get(EMAIL_AGENT_ROLE.id)!.connectorRefs).toEqual(refsSnapshot);
  });

  it('preserves pre-existing connectorRefs when appending the new one', async () => {
    const { store, storedConnectors, roleStore } = makeStore({
      workspace: WS,
      role: {
        ...EMAIL_AGENT_ROLE,
        connectorRefs: ['pre-existing-ref'],
      },
    });

    await seedCueConnector(store, WS.id);

    const conn = storedConnectors.find((c) => c.name === CUE_CONNECTOR_NAME)!;
    const role = roleStore.get(EMAIL_AGENT_ROLE.id)!;
    expect(role.connectorRefs).toContain('pre-existing-ref');
    expect(role.connectorRefs).toContain(conn.id);
  });

  it('returns workspaceFound=false and skips all work when workspace is missing', async () => {
    const { store, storedConnectors, roleStore } = makeStore({ workspace: undefined });

    const result = await seedCueConnector(store, 'non-existent-ws');

    expect(result.workspaceFound).toBe(false);
    expect(result.connectorCreated).toBe(false);
    expect(result.connectorId).toBeNull();
    expect(result.workspaceEnabled).toBe(false);
    expect(result.roleUpdated).toBe(false);
    expect(storedConnectors.length).toBe(0);
    expect(roleStore.size).toBe(0);
  });

  it('still creates the connector even when email-agent role is absent', async () => {
    const { store, storedConnectors, storedCwRows } = makeStore({ workspace: WS });

    const result = await seedCueConnector(store, WS.id);

    expect(result.connectorCreated).toBe(true);
    expect(result.workspaceEnabled).toBe(true);
    expect(result.roleUpdated).toBe(false);
    expect(storedConnectors.length).toBe(1);
    expect(storedCwRows.length).toBe(1);
  });

  it('skips role update when connectorRefs already contains the id and config is already clear', async () => {
    // Pre-wire the role as if the seed has already run.
    let connId: string | null = null;
    const { store, storedConnectors, roleStore } = makeStore({
      workspace: WS,
      role: {
        ...EMAIL_AGENT_ROLE,
        // mcpServers and requiredEnvVars already cleared — seed result of first run.
        mcpServers: {},
        requiredEnvVars: {},
        connectorRefs: [] as string[], // will be populated by first run, overridden below
      },
    });

    // Run once to get the connector id.
    const first = await seedCueConnector(store, WS.id);
    connId = first.connectorId;

    // Now simulate an already-wired role manually.
    const role = roleStore.get(EMAIL_AGENT_ROLE.id)!;
    expect(role.connectorRefs).toContain(connId);
    expect(role.mcpServers).toEqual({});

    const second = await seedCueConnector(store, WS.id);
    expect(second.roleUpdated).toBe(false);
  });
});
