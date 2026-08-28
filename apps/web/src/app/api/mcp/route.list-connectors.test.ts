/**
 * Tests for the list_connectors action in the MCP buildd tool.
 *
 * Handled directly in route.ts (like check_path_claim) because it needs DB
 * access at worker token level — the existing workspace connectors REST route
 * requires admin level.
 */

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

// ── Mocks must be declared before import ─────────────────────────────────────

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null as any));
const mockConnectorsFindMany = mock(() => Promise.resolve([] as any[]));
const mockConnectorSharesFindMany = mock(() => Promise.resolve([] as any[]));
const mockConnectorWorkspacesFindMany = mock(() => Promise.resolve([] as any[]));
const mockSecretsFindMany = mock(() => Promise.resolve([] as any[]));

// Separate findFirst mock to avoid state-sharing across queries
const mockTeamsFindFirst = mock(() => Promise.resolve(null as any));
const mockWorkersFindFirst = mock(() => Promise.resolve(null as any));

const mockResolveWorkspace = mock(() => Promise.resolve(null as any));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/workspace-resolver', () => ({
  resolveWorkspace: mockResolveWorkspace,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      teams: { findFirst: mockTeamsFindFirst },
      workers: { findFirst: mockWorkersFindFirst },
      tasks: { findFirst: mock(() => Promise.resolve(null)) },
      connectors: { findMany: mockConnectorsFindMany },
      connectorShares: { findMany: mockConnectorSharesFindMany },
      connectorWorkspaces: { findMany: mockConnectorWorkspacesFindMany },
      secrets: { findMany: mockSecretsFindMany },
    },
    update: mock(() => ({ set: mock(() => ({ where: mock(() => ({ returning: mock(() => Promise.resolve([])) })) })) })),
    insert: mock(() => ({ values: mock(() => Promise.resolve([])) })),
    select: mock(() => ({ from: mock(() => ({ where: mock(() => ({ limit: mock(() => Promise.resolve([])) })) })) })),
  },
}));

mock.module('@buildd/core/path-claim', () => ({
  checkPathClaimConflict: mock(async () => null),
  insertClaims: mock(async () => []),
  registerWaiter: mock(async () => ({ registered: true })),
}));

mock.module('@buildd/core/knowledge-store', () => ({
  PgVectorStore: class {
    upsert() { return Promise.resolve([]); }
    search() { return Promise.resolve([]); }
  },
  getVoyageEmbedder: () => null,
  getVoyageReranker: () => null,
}));

mock.module('@buildd/core/memory-client', () => ({
  MemoryClient: class {
    getContext() { return Promise.resolve({ markdown: '' }); }
  },
}));

mock.module('@buildd/core/mcp-tools', () => ({
  handleBuilddAction: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  handleMemoryAction: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  handleRecallAction: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  handleLearnAction: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  triggerActions: [],
  workerActions: ['list_connectors'],
  adminActions: [],
  allActions: ['list_connectors'],
  memoryActions: [],
  buildToolDescription: () => 'description',
  buildParamsDescription: () => 'params',
  buildMemoryDescription: () => 'memory',
}));

import { POST } from './route';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeListConnectorsRequest(workspaceParam = WORKSPACE_ID) {
  const wsQuery = workspaceParam ? `?workspace=${workspaceParam}` : '';
  return new Request(`http://localhost/api/mcp${wsQuery}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer bld_test',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'buildd',
        arguments: { action: 'list_connectors', params: {} },
      },
    }),
  });
}

function makeListConnectorsRequestWithParamWorkspaceId(workspaceId: string) {
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer bld_test',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'buildd',
        arguments: { action: 'list_connectors', params: { workspaceId } },
      },
    }),
  });
}

async function callListConnectors(workspaceParam = WORKSPACE_ID): Promise<any> {
  const res = await POST(makeListConnectorsRequest(workspaceParam));
  const body = await res.json();
  const text = body?.result?.content?.[0]?.text;
  try { return JSON.parse(text); } catch { return text; }
}

async function callListConnectorsViaParam(workspaceId: string): Promise<any> {
  const res = await POST(makeListConnectorsRequestWithParamWorkspaceId(workspaceId));
  const body = await res.json();
  const text = body?.result?.content?.[0]?.text;
  try { return JSON.parse(text); } catch { return text; }
}

function makeConnector(id: string, overrides: Record<string, any> = {}) {
  return { id, name: `Connector ${id.slice(-4)}`, authMode: 'oauth', teamId: TEAM_ID, ...overrides };
}

function makeCwRow(connectorId: string, enabled = true) {
  return { connectorId, workspaceId: WORKSPACE_ID, enabled };
}

function makeSecret(label: string, overrides: Record<string, any> = {}) {
  return { label, tokenExpiresAt: null, healthStatus: 'healthy', ...overrides };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('list_connectors MCP action', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockConnectorsFindMany.mockReset();
    mockConnectorSharesFindMany.mockReset();
    mockConnectorWorkspacesFindMany.mockReset();
    mockSecretsFindMany.mockReset();
    mockTeamsFindFirst.mockReset();
    mockWorkersFindFirst.mockReset();
    mockResolveWorkspace.mockReset();

    // Default happy path: worker token, workspace resolves
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'acc-1', level: 'worker', teamId: TEAM_ID, authType: 'api',
    });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: TEAM_ID });
    mockConnectorsFindMany.mockResolvedValue([]);
    mockConnectorSharesFindMany.mockResolvedValue([]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    mockSecretsFindMany.mockResolvedValue([]);
    mockTeamsFindFirst.mockResolvedValue(null);
  });

  // ── ok connector ─────────────────────────────────────────────────────────────

  it('returns ok for a mounted enabled connector with a healthy credential', async () => {
    mockConnectorsFindMany.mockResolvedValue([makeConnector(CONNECTOR_OK)]);
    mockConnectorSharesFindMany.mockResolvedValue([]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_OK, true)]);
    mockSecretsFindMany.mockResolvedValue([makeSecret(CONNECTOR_OK, { healthStatus: 'healthy' })]);

    const data = await callListConnectors();
    expect(data.connectors).toHaveLength(1);
    expect(data.connectors[0]).toMatchObject({ id: CONNECTOR_OK, status: 'ok' });
  });

  it('returns ok for authMode=none connector (no credential needed)', async () => {
    mockConnectorsFindMany.mockResolvedValue([makeConnector(CONNECTOR_OK, { authMode: 'none' })]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_OK, true)]);
    mockSecretsFindMany.mockResolvedValue([]);

    const data = await callListConnectors();
    expect(data.connectors[0]).toMatchObject({ id: CONNECTOR_OK, status: 'ok' });
  });

  // ── auth_expired connector ────────────────────────────────────────────────────

  it('returns auth_expired when the connector has no credential', async () => {
    mockConnectorsFindMany.mockResolvedValue([makeConnector(CONNECTOR_EXPIRED)]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_EXPIRED, true)]);
    mockSecretsFindMany.mockResolvedValue([]);

    const data = await callListConnectors();
    expect(data.connectors[0]).toMatchObject({ id: CONNECTOR_EXPIRED, status: 'auth_expired' });
  });

  it('returns auth_expired when the token is past its expiry date', async () => {
    const pastDate = new Date(Date.now() - 60_000);
    mockConnectorsFindMany.mockResolvedValue([makeConnector(CONNECTOR_EXPIRED)]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_EXPIRED, true)]);
    mockSecretsFindMany.mockResolvedValue([
      makeSecret(CONNECTOR_EXPIRED, { tokenExpiresAt: pastDate, healthStatus: 'healthy' }),
    ]);

    const data = await callListConnectors();
    expect(data.connectors[0]).toMatchObject({ id: CONNECTOR_EXPIRED, status: 'auth_expired' });
  });

  // ── unreachable connector ─────────────────────────────────────────────────────

  it('returns unreachable when credential healthStatus is revoked', async () => {
    mockConnectorsFindMany.mockResolvedValue([makeConnector(CONNECTOR_UNREACHABLE)]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_UNREACHABLE, true)]);
    mockSecretsFindMany.mockResolvedValue([
      makeSecret(CONNECTOR_UNREACHABLE, { healthStatus: 'revoked' }),
    ]);

    const data = await callListConnectors();
    expect(data.connectors[0]).toMatchObject({ id: CONNECTOR_UNREACHABLE, status: 'unreachable' });
  });

  it('returns unreachable when credential healthStatus is degraded', async () => {
    mockConnectorsFindMany.mockResolvedValue([makeConnector(CONNECTOR_UNREACHABLE)]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_UNREACHABLE, true)]);
    mockSecretsFindMany.mockResolvedValue([
      makeSecret(CONNECTOR_UNREACHABLE, { healthStatus: 'degraded' }),
    ]);

    const data = await callListConnectors();
    expect(data.connectors[0]).toMatchObject({ id: CONNECTOR_UNREACHABLE, status: 'unreachable' });
  });

  // ── disabled connector ────────────────────────────────────────────────────────

  it('returns disabled for a connector with enabled=false in connectorWorkspaces', async () => {
    mockConnectorsFindMany.mockResolvedValue([makeConnector(CONNECTOR_DISABLED)]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_DISABLED, false)]);
    mockSecretsFindMany.mockResolvedValue([makeSecret(CONNECTOR_DISABLED)]);

    const data = await callListConnectors();
    expect(data.connectors[0]).toMatchObject({ id: CONNECTOR_DISABLED, status: 'disabled' });
  });

  // ── never-mounted filtering ───────────────────────────────────────────────────

  it('excludes connectors that have no connectorWorkspaces row (never-mounted)', async () => {
    mockConnectorsFindMany.mockResolvedValue([
      makeConnector(CONNECTOR_OK),
      makeConnector(CONNECTOR_UNMOUNTED),
    ]);
    // Only CONNECTOR_OK has a CW row; CONNECTOR_UNMOUNTED has none
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_OK, true)]);
    mockSecretsFindMany.mockResolvedValue([makeSecret(CONNECTOR_OK)]);

    const data = await callListConnectors();
    expect(data.connectors).toHaveLength(1);
    expect(data.connectors[0].id).toBe(CONNECTOR_OK);
  });

  // ── shared connectors ─────────────────────────────────────────────────────────

  it('includes connectors shared to the workspace team', async () => {
    mockConnectorsFindMany.mockResolvedValue([]);
    mockConnectorSharesFindMany.mockResolvedValue([
      { connectorId: CONNECTOR_SHARED },
    ]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_SHARED, true)]);
    // Connector details fetched in second connectors.findMany call
    mockConnectorsFindMany
      .mockResolvedValueOnce([])  // first call: ownedRows (empty)
      .mockResolvedValueOnce([makeConnector(CONNECTOR_SHARED, { teamId: OWNER_TEAM_ID })]);
    mockSecretsFindMany.mockResolvedValue([makeSecret(CONNECTOR_SHARED)]);

    const data = await callListConnectors();
    expect(data.connectors[0]).toMatchObject({ id: CONNECTOR_SHARED, status: 'ok' });
  });

  // ── empty workspace ───────────────────────────────────────────────────────────

  it('returns empty array when no connectors are mounted', async () => {
    const data = await callListConnectors();
    expect(data.connectors).toHaveLength(0);
  });

  // ── params.workspaceId resolution ────────────────────────────────────────────

  it('resolves workspace from params.workspaceId when no URL workspace is given', async () => {
    mockResolveWorkspace.mockResolvedValue({ id: WORKSPACE_ID, teamId: TEAM_ID, name: 'buildd' });
    mockConnectorsFindMany.mockResolvedValue([makeConnector(CONNECTOR_OK)]);
    mockConnectorSharesFindMany.mockResolvedValue([]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([makeCwRow(CONNECTOR_OK, true)]);
    mockSecretsFindMany.mockResolvedValue([makeSecret(CONNECTOR_OK, { healthStatus: 'healthy' })]);

    const data = await callListConnectorsViaParam('buildd');
    expect(data.connectors).toHaveLength(1);
    expect(data.connectors[0]).toMatchObject({ id: CONNECTOR_OK, status: 'ok' });
  });

  it('returns workspace_required when params.workspaceId cannot be resolved', async () => {
    mockResolveWorkspace.mockResolvedValue(null);
    const data = await callListConnectorsViaParam('nonexistent-workspace');
    expect(data.error).toBe('workspace_required');
  });

  // ── error: no workspace ───────────────────────────────────────────────────────

  it('returns error when workspace cannot be resolved', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(null);
    const res = await POST(makeListConnectorsRequest(''));
    const body = await res.json();
    const result = body?.result;
    const text = result?.content?.[0]?.text;
    const parsed = JSON.parse(text);
    // Either workspace_required or workspace_not_found
    expect(['workspace_required', 'workspace_not_found']).toContain(parsed.error);
  });
});
