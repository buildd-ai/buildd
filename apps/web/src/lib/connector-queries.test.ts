import { describe, it, expect, mock, beforeEach } from 'bun:test';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEAM_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OWNER_TEAM_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CONNECTOR_OK = 'connector-ok-00-0000-0000-000000000001';
const CONNECTOR_EXPIRED = 'connector-expired-000-0000-000000000002';
const CONNECTOR_DISABLED = 'connector-disabled-00-0000-000000000003';
const CONNECTOR_SHARED = 'connector-shared-000-0000-000000000004';
const CONNECTOR_UNMOUNTED = 'connector-unmounted-0-0000-000000000005';
const CONNECTOR_UNREACHABLE = 'connector-unreachable-000-000000000006';

const mockWorkspacesFindFirst = mock(() => Promise.resolve(null as any));
const mockConnectorsFindMany = mock(() => Promise.resolve([] as any[]));
const mockConnectorSharesFindMany = mock(() => Promise.resolve([] as any[]));
const mockConnectorWorkspacesFindMany = mock(() => Promise.resolve([] as any[]));
const mockSecretsFindMany = mock(() => Promise.resolve([] as any[]));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      connectors: { findMany: mockConnectorsFindMany },
      connectorShares: { findMany: mockConnectorSharesFindMany },
      connectorWorkspaces: { findMany: mockConnectorWorkspacesFindMany },
      secrets: { findMany: mockSecretsFindMany },
    },
  },
}));

import { listMountedConnectors } from './connector-queries';

function makeConnector(id: string, overrides: Record<string, any> = {}) {
  return { id, name: `Connector ${id.slice(-4)}`, authMode: 'oauth', teamId: TEAM_ID, ...overrides };
}

function makeCwRow(connectorId: string, enabled = true) {
  return { connectorId, workspaceId: WORKSPACE_ID, enabled };
}

function makeSecret(label: string, overrides: Record<string, any> = {}) {
  return { label, tokenExpiresAt: null, healthStatus: 'healthy', ...overrides };
}

describe('listMountedConnectors', () => {
  beforeEach(() => {
    mockWorkspacesFindFirst.mockReset();
    mockConnectorsFindMany.mockReset();
    mockConnectorSharesFindMany.mockReset();
    mockConnectorWorkspacesFindMany.mockReset();
    mockSecretsFindMany.mockReset();

    mockWorkspacesFindFirst.mockResolvedValue({ teamId: TEAM_ID });
    mockConnectorsFindMany.mockResolvedValue([]);
    mockConnectorSharesFindMany.mockResolvedValue([]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    mockSecretsFindMany.mockResolvedValue([]);
  });

  it('returns ok for a mounted enabled connector with a healthy credential', async () => {
    mockConnectorsFindMany.mockResolvedValue([makeConnector(CONNECTOR_OK)]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_OK, true)]);
    mockSecretsFindMany.mockResolvedValue([makeSecret(CONNECTOR_OK, { healthStatus: 'healthy' })]);

    const result = await listMountedConnectors(WORKSPACE_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.connectors).toHaveLength(1);
    expect(result.connectors[0]).toMatchObject({ id: CONNECTOR_OK, status: 'ok' });
  });

  it('returns ok for authMode=none connector (no credential needed)', async () => {
    mockConnectorsFindMany.mockResolvedValue([makeConnector(CONNECTOR_OK, { authMode: 'none' })]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_OK, true)]);
    mockSecretsFindMany.mockResolvedValue([]);

    const result = await listMountedConnectors(WORKSPACE_ID);
    if (!result.ok) throw new Error('unreachable');
    expect(result.connectors[0]).toMatchObject({ id: CONNECTOR_OK, status: 'ok' });
  });

  it('returns auth_expired when the connector has no credential', async () => {
    mockConnectorsFindMany.mockResolvedValue([makeConnector(CONNECTOR_EXPIRED)]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_EXPIRED, true)]);
    mockSecretsFindMany.mockResolvedValue([]);

    const result = await listMountedConnectors(WORKSPACE_ID);
    if (!result.ok) throw new Error('unreachable');
    expect(result.connectors[0]).toMatchObject({ id: CONNECTOR_EXPIRED, status: 'auth_expired' });
  });

  it('returns auth_expired when the token is past its expiry date', async () => {
    const pastDate = new Date(Date.now() - 60_000);
    mockConnectorsFindMany.mockResolvedValue([makeConnector(CONNECTOR_EXPIRED)]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_EXPIRED, true)]);
    mockSecretsFindMany.mockResolvedValue([
      makeSecret(CONNECTOR_EXPIRED, { tokenExpiresAt: pastDate, healthStatus: 'healthy' }),
    ]);

    const result = await listMountedConnectors(WORKSPACE_ID);
    if (!result.ok) throw new Error('unreachable');
    expect(result.connectors[0]).toMatchObject({ id: CONNECTOR_EXPIRED, status: 'auth_expired' });
  });

  it('returns unreachable when credential healthStatus is revoked', async () => {
    mockConnectorsFindMany.mockResolvedValue([makeConnector(CONNECTOR_UNREACHABLE)]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_UNREACHABLE, true)]);
    mockSecretsFindMany.mockResolvedValue([makeSecret(CONNECTOR_UNREACHABLE, { healthStatus: 'revoked' })]);

    const result = await listMountedConnectors(WORKSPACE_ID);
    if (!result.ok) throw new Error('unreachable');
    expect(result.connectors[0]).toMatchObject({ id: CONNECTOR_UNREACHABLE, status: 'unreachable' });
  });

  it('returns unreachable when credential healthStatus is degraded', async () => {
    mockConnectorsFindMany.mockResolvedValue([makeConnector(CONNECTOR_UNREACHABLE)]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_UNREACHABLE, true)]);
    mockSecretsFindMany.mockResolvedValue([makeSecret(CONNECTOR_UNREACHABLE, { healthStatus: 'degraded' })]);

    const result = await listMountedConnectors(WORKSPACE_ID);
    if (!result.ok) throw new Error('unreachable');
    expect(result.connectors[0]).toMatchObject({ id: CONNECTOR_UNREACHABLE, status: 'unreachable' });
  });

  it('returns disabled for a connector with enabled=false in connectorWorkspaces', async () => {
    mockConnectorsFindMany.mockResolvedValue([makeConnector(CONNECTOR_DISABLED)]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_DISABLED, false)]);
    mockSecretsFindMany.mockResolvedValue([makeSecret(CONNECTOR_DISABLED)]);

    const result = await listMountedConnectors(WORKSPACE_ID);
    if (!result.ok) throw new Error('unreachable');
    expect(result.connectors[0]).toMatchObject({ id: CONNECTOR_DISABLED, status: 'disabled' });
  });

  it('excludes connectors that have no connectorWorkspaces row (never-mounted)', async () => {
    mockConnectorsFindMany.mockResolvedValue([
      makeConnector(CONNECTOR_OK),
      makeConnector(CONNECTOR_UNMOUNTED),
    ]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_OK, true)]);
    mockSecretsFindMany.mockResolvedValue([makeSecret(CONNECTOR_OK)]);

    const result = await listMountedConnectors(WORKSPACE_ID);
    if (!result.ok) throw new Error('unreachable');
    expect(result.connectors).toHaveLength(1);
    expect(result.connectors[0].id).toBe(CONNECTOR_OK);
  });

  it('includes connectors shared to the workspace team', async () => {
    mockConnectorSharesFindMany.mockResolvedValue([{ connectorId: CONNECTOR_SHARED }]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_SHARED, true)]);
    mockConnectorsFindMany
      .mockResolvedValueOnce([]) // ownedRows
      .mockResolvedValueOnce([makeConnector(CONNECTOR_SHARED, { teamId: OWNER_TEAM_ID })]); // connector details
    mockSecretsFindMany.mockResolvedValue([makeSecret(CONNECTOR_SHARED)]);

    const result = await listMountedConnectors(WORKSPACE_ID);
    if (!result.ok) throw new Error('unreachable');
    expect(result.connectors[0]).toMatchObject({ id: CONNECTOR_SHARED, status: 'ok' });
  });

  it('returns an empty array when no connectors are mounted', async () => {
    const result = await listMountedConnectors(WORKSPACE_ID);
    if (!result.ok) throw new Error('unreachable');
    expect(result.connectors).toHaveLength(0);
  });

  it('returns workspace_not_found when the workspace does not exist', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(null);

    const result = await listMountedConnectors(WORKSPACE_ID);
    expect(result).toEqual({ ok: false, error: 'workspace_not_found' });
  });
});
