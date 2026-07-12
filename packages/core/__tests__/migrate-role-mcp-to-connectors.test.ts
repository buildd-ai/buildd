/**
 * Spec: docs/specs/mcp-connectors-and-roles.md §4 (AC-1..AC-4).
 *
 * The migration's core logic drives a `MigrationStore` seam, so these tests bind
 * an in-memory store (no db mock needed) and assert the reshaping + idempotency
 * directly. The Drizzle binding (`createDrizzleStore`) is a thin data-access
 * adapter over the same interface.
 */
import { describe, it, expect } from 'bun:test';
import {
  migrateRoleMcpToConnectors,
  parseMcpServers,
  type MigrationStore,
  type RoleRow,
} from '../scripts/migrate-role-mcp-to-connectors';

interface StoredConnector {
  id: string;
  teamId: string;
  name: string;
  url: string;
  authMode: string;
  transport: string;
  command: string | null;
  args: string[];
  envMapping: Record<string, string>;
  discoveredMetadata: Record<string, unknown> | null;
}

function makeStore(seed: RoleRow[]) {
  const roleMap = new Map<string, RoleRow>(seed.map((r) => [r.id, { ...r }]));
  const rows: StoredConnector[] = [];
  let counter = 0;

  const store: MigrationStore = {
    async listRolesWithMcp() {
      return [...roleMap.values()];
    },
    async findConnector(teamId, name) {
      const found = rows.find((c) => c.teamId === teamId && c.name === name);
      return found ? { id: found.id } : null;
    },
    async insertConnector(row) {
      const id = `conn-${++counter}`;
      rows.push({ id, ...(row as Omit<StoredConnector, 'id'>) });
      return { id };
    },
    async setRoleConnectorRefs(roleId, refs) {
      const role = roleMap.get(roleId);
      if (role) role.connectorRefs = [...refs];
    },
  };

  return { store, rows, roleMap };
}

function role(partial: Partial<RoleRow> & Pick<RoleRow, 'id' | 'teamId' | 'mcpServers'>): RoleRow {
  return {
    requiredEnvVars: {},
    connectorRefs: [],
    ...partial,
  };
}

describe('parseMcpServers', () => {
  it('parses http config → http transport, authMode none', () => {
    const specs = parseMcpServers({ linear: { type: 'http', url: 'https://linear.app/mcp' } });
    expect(specs).toEqual([
      {
        name: 'linear',
        transport: 'http',
        url: 'https://linear.app/mcp',
        command: null,
        args: [],
        authMode: 'none',
        discoveredMetadata: null,
      },
    ]);
  });

  it('parses stdio config → command/args, authMode none', () => {
    const specs = parseMcpServers({ fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-fs'] } });
    expect(specs[0]).toMatchObject({
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-fs'],
      authMode: 'none',
    });
  });

  it('parses legacy string[] → http placeholder flagged needsReview', () => {
    const specs = parseMcpServers(['slack']);
    expect(specs[0]).toMatchObject({
      name: 'slack',
      transport: 'http',
      authMode: 'none',
      discoveredMetadata: { needsReview: true },
    });
  });

  it('returns [] for empty / malformed input', () => {
    expect(parseMcpServers({})).toEqual([]);
    expect(parseMcpServers([])).toEqual([]);
    expect(parseMcpServers(null)).toEqual([]);
    expect(parseMcpServers('nope')).toEqual([]);
  });
});

describe('migrateRoleMcpToConnectors', () => {
  // AC-1
  it('creates a connector for an http mcpServers entry and references it', async () => {
    const { store, rows, roleMap } = makeStore([
      role({ id: 'r1', teamId: 'team-a', mcpServers: { linear: { type: 'http', url: 'https://linear.app/mcp' } } }),
    ]);

    const result = await migrateRoleMcpToConnectors(store);

    expect(result.connectorsCreated).toBe(1);
    expect(result.refsChanged).toBe(1);

    const linear = rows.find((c) => c.name === 'linear');
    expect(linear).toBeDefined();
    expect(linear!.teamId).toBe('team-a');
    expect(linear!.transport).toBe('http');
    expect(linear!.url).toBe('https://linear.app/mcp');
    expect(linear!.authMode).toBe('none');
    expect(roleMap.get('r1')!.connectorRefs).toContain(linear!.id);
  });

  // AC-2
  it('dedups an identical http server across two roles in the same team', async () => {
    const github = { type: 'http', url: 'https://api.github.com/mcp' };
    const { store, rows, roleMap } = makeStore([
      role({ id: 'r1', teamId: 'team-a', mcpServers: { github } }),
      role({ id: 'r2', teamId: 'team-a', mcpServers: { github } }),
    ]);

    const result = await migrateRoleMcpToConnectors(store);

    const githubRows = rows.filter((c) => c.name === 'github' && c.teamId === 'team-a');
    expect(githubRows.length).toBe(1);
    expect(result.connectorsCreated).toBe(1);

    const id = githubRows[0].id;
    expect(roleMap.get('r1')!.connectorRefs).toContain(id);
    expect(roleMap.get('r2')!.connectorRefs).toContain(id);
  });

  it('keeps same-named connectors separate across different teams', async () => {
    const github = { type: 'http', url: 'https://api.github.com/mcp' };
    const { store, rows } = makeStore([
      role({ id: 'r1', teamId: 'team-a', mcpServers: { github } }),
      role({ id: 'r2', teamId: 'team-b', mcpServers: { github } }),
    ]);

    await migrateRoleMcpToConnectors(store);

    expect(rows.filter((c) => c.name === 'github').length).toBe(2);
  });

  // AC-3
  it('creates a needsReview placeholder for a legacy string[] server', async () => {
    const { store, rows, roleMap } = makeStore([
      role({ id: 'r1', teamId: 'team-a', mcpServers: ['slack'] }),
    ]);

    await migrateRoleMcpToConnectors(store);

    const slack = rows.find((c) => c.name === 'slack');
    expect(slack).toBeDefined();
    expect(slack!.authMode).toBe('none');
    expect(slack!.transport).toBe('http');
    expect(slack!.discoveredMetadata).toEqual({ needsReview: true });
    expect(roleMap.get('r1')!.connectorRefs).toContain(slack!.id);
  });

  it('copies requiredEnvVars into a stdio connector envMapping only', async () => {
    const { store, rows } = makeStore([
      role({
        id: 'r1',
        teamId: 'team-a',
        mcpServers: {
          fs: { command: 'npx', args: ['-y', 'server-fs'] },
          linear: { type: 'http', url: 'https://linear.app/mcp' },
        },
        requiredEnvVars: { API_TOKEN: 'fs-token-label' },
      }),
    ]);

    await migrateRoleMcpToConnectors(store);

    const fs = rows.find((c) => c.name === 'fs')!;
    expect(fs.transport).toBe('stdio');
    expect(fs.command).toBe('npx');
    expect(fs.args).toEqual(['-y', 'server-fs']);
    expect(fs.envMapping).toEqual({ API_TOKEN: 'fs-token-label' });

    // http connectors must NOT receive the env mapping (stdio env-only).
    const linear = rows.find((c) => c.name === 'linear')!;
    expect(linear.envMapping).toEqual({});
  });

  it('preserves pre-existing connectorRefs when appending new ones', async () => {
    const { store, rows, roleMap } = makeStore([
      role({
        id: 'r1',
        teamId: 'team-a',
        mcpServers: { linear: { type: 'http', url: 'https://linear.app/mcp' } },
        connectorRefs: ['pre-existing'],
      }),
    ]);

    await migrateRoleMcpToConnectors(store);

    const linear = rows.find((c) => c.name === 'linear')!;
    expect(roleMap.get('r1')!.connectorRefs).toEqual(['pre-existing', linear.id]);
  });

  it('skips roles with empty mcpServers', async () => {
    const { store } = makeStore([
      role({ id: 'r1', teamId: 'team-a', mcpServers: {} }),
      role({ id: 'r2', teamId: 'team-a', mcpServers: [] }),
    ]);

    const result = await migrateRoleMcpToConnectors(store);
    expect(result).toEqual({ rolesProcessed: 0, connectorsCreated: 0, refsChanged: 0 });
  });

  // AC-4
  it('is idempotent: a second run creates 0 rows and changes 0 refs', async () => {
    const { store, rows, roleMap } = makeStore([
      role({ id: 'r1', teamId: 'team-a', mcpServers: { linear: { type: 'http', url: 'https://linear.app/mcp' } } }),
      role({ id: 'r2', teamId: 'team-a', mcpServers: { linear: { type: 'http', url: 'https://linear.app/mcp' } } }),
      role({ id: 'r3', teamId: 'team-a', mcpServers: ['slack'] }),
      role({
        id: 'r4',
        teamId: 'team-b',
        mcpServers: { fs: { command: 'npx', args: ['-y', 'server-fs'] } },
        requiredEnvVars: { API_TOKEN: 'label' },
      }),
    ]);

    const first = await migrateRoleMcpToConnectors(store);
    expect(first.connectorsCreated).toBeGreaterThan(0);

    const rowsAfterFirst = rows.length;
    const refsSnapshot = JSON.stringify([...roleMap.values()].map((r) => r.connectorRefs));

    const second = await migrateRoleMcpToConnectors(store);
    expect(second.connectorsCreated).toBe(0);
    expect(second.refsChanged).toBe(0);
    expect(rows.length).toBe(rowsAfterFirst);
    expect(JSON.stringify([...roleMap.values()].map((r) => r.connectorRefs))).toBe(refsSnapshot);
  });
});
