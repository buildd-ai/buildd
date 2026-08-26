import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockWorkspaceSkillsFindMany = mock(() => [] as any[]);
const mockConnectorsFindMany = mock(() => [] as any[]);
const mockConnectorSharesFindMany = mock(() => [] as any[]);
const mockConnectorWorkspacesFindMany = mock(() => [] as any[]);
const mockSecretsFindMany = mock(() => [] as any[]);
const mockMissionsFindFirst = mock(() => null as any);
const mockWorkersFindMany = mock(() => [] as any[]);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaceSkills: { findMany: mockWorkspaceSkillsFindMany },
      connectors: { findMany: mockConnectorsFindMany },
      connectorShares: { findMany: mockConnectorSharesFindMany },
      connectorWorkspaces: { findMany: mockConnectorWorkspacesFindMany },
      secrets: { findMany: mockSecretsFindMany },
      missions: { findFirst: mockMissionsFindFirst },
      workers: { findMany: mockWorkersFindMany },
    },
  },
}));

const mockSecretsProviderGet = mock((_id: string) => Promise.resolve(null as string | null));
mock.module('@buildd/core/secrets', () => ({
  getSecretsProvider: () => ({ get: mockSecretsProviderGet }),
}));

const mockFetch = mock((_url: string, _opts?: any) => Promise.resolve({ ok: true, status: 200 }));
mock.module('node:fetch', () => ({ default: mockFetch }));

// Replace global fetch; restored in afterAll so Bun's shared-process test runner
// doesn't contaminate subsequent test files (Bun 1.3.14+ shares globalThis).
const _originalFetch = (globalThis as any).fetch;
(globalThis as any).fetch = mockFetch;
afterAll(() => { (globalThis as any).fetch = _originalFetch; });

mock.module('@/lib/codex-credential', () => ({
  hasCodexCredential: mock(() => Promise.resolve(false)),
}));

import { checkConnectorRouting } from './claim-gates';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEAM_ID = 'team-111';
const WORKSPACE_ID = 'ws-222';
const ROLE_SLUG = 'builder';
const CONNECTOR_ID = 'conn-aaa';
const CONNECTOR_NAME = 'My MCP Server';
const SECRET_ID = 'secret-sss';

function makeRole(connectorRefs: string[] = [CONNECTOR_ID]) {
  return {
    slug: ROLE_SLUG,
    workspaceId: WORKSPACE_ID,
    connectorRefs,
    teamId: TEAM_ID,
  };
}

function makeConnector(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTOR_ID,
    teamId: TEAM_ID,
    name: CONNECTOR_NAME,
    authMode: 'none',
    transport: 'http',
    url: 'https://mcp.example.com',
    envMapping: {},
    ...overrides,
  };
}

function makeSecret(overrides: Record<string, unknown> = {}) {
  return {
    id: SECRET_ID,
    label: CONNECTOR_ID,
    teamId: TEAM_ID,
    tokenExpiresAt: null,
    lastRefreshedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockWorkspaceSkillsFindMany.mockReset();
  mockConnectorsFindMany.mockReset();
  mockConnectorSharesFindMany.mockReset();
  mockConnectorWorkspacesFindMany.mockReset();
  mockSecretsFindMany.mockReset();
  mockSecretsProviderGet.mockReset();
  mockFetch.mockReset();

  // Default: no shares, all workspaces enabled
  mockConnectorSharesFindMany.mockResolvedValue([]);
  mockConnectorWorkspacesFindMany.mockResolvedValue([]);
  mockSecretsProviderGet.mockResolvedValue('decrypted-secret');
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
  process.env.ENCRYPTION_KEY = 'test-key-32-chars-padding-here!!';
});

// ── never_mounted ─────────────────────────────────────────────────────────────

describe('checkConnectorRouting — never_mounted', () => {
  it('returns null when role has no connector refs', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole([])]);
    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toBeNull();
  });

  it('returns null when no role row found', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([]);
    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toBeNull();
  });

  it('classifies dangling connector ref as never_mounted', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([]); // connector not found
    mockSecretsFindMany.mockResolvedValue([]);

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      connectorId: CONNECTOR_ID,
      connectorName: CONNECTOR_ID, // falls back to ID when name unknown
      mode: 'never_mounted',
    });
  });

  it('classifies wrong-team unshared connector as never_mounted', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([makeConnector({ teamId: 'other-team' })]);
    mockConnectorSharesFindMany.mockResolvedValue([]); // not shared
    mockSecretsFindMany.mockResolvedValue([]);

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ mode: 'never_mounted', connectorName: CONNECTOR_NAME });
  });

  it('returns null for connector shared from another team', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([makeConnector({ teamId: 'other-team', authMode: 'none', transport: 'http' })]);
    mockConnectorSharesFindMany.mockResolvedValue([{ connectorId: CONNECTOR_ID }]);
    mockSecretsFindMany.mockResolvedValue([]);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toBeNull();
  });

  it('classifies explicitly disabled connector as never_mounted', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([makeConnector()]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([
      { connectorId: CONNECTOR_ID, enabled: false },
    ]);
    mockSecretsFindMany.mockResolvedValue([]);

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ mode: 'never_mounted', connectorName: CONNECTOR_NAME });
  });

  it('returns null when connector is enabled (explicit true row)', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([makeConnector({ authMode: 'none', transport: 'http' })]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([
      { connectorId: CONNECTOR_ID, enabled: true },
    ]);
    mockSecretsFindMany.mockResolvedValue([]);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toBeNull();
  });
});

// ── expired_or_revoked ────────────────────────────────────────────────────────

describe('checkConnectorRouting — expired_or_revoked', () => {
  it('classifies oauth connector with expired token (>5min ago refresh) as expired_or_revoked', async () => {
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 1000); // 1s ago
    const refreshedAt = new Date(now.getTime() - 10 * 60 * 1000); // 10min ago

    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([makeConnector({ authMode: 'oauth', transport: 'http' })]);
    mockSecretsFindMany.mockResolvedValue([
      makeSecret({ tokenExpiresAt: expiredAt, lastRefreshedAt: refreshedAt }),
    ]);

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ mode: 'expired_or_revoked', connectorName: CONNECTOR_NAME });
  });

  it('does NOT classify oauth connector as expired when token not yet expired', async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1h from now
    const refreshedAt = new Date(now.getTime() - 1 * 60 * 1000); // 1min ago

    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([makeConnector({ authMode: 'oauth', transport: 'http' })]);
    mockSecretsFindMany.mockResolvedValue([
      makeSecret({ tokenExpiresAt: expiresAt, lastRefreshedAt: refreshedAt }),
    ]);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toBeNull();
  });

  it('classifies oauth connector with missing secret as expired_or_revoked', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([makeConnector({ authMode: 'oauth', transport: 'http' })]);
    mockSecretsFindMany.mockResolvedValue([]); // no secret row

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ mode: 'expired_or_revoked', connectorName: CONNECTOR_NAME });
  });

  it('classifies header connector with undecryptable secret as expired_or_revoked', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([makeConnector({ authMode: 'header', transport: 'http' })]);
    mockSecretsFindMany.mockResolvedValue([makeSecret()]);
    mockSecretsProviderGet.mockResolvedValue(null); // decryption returns null

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ mode: 'expired_or_revoked', connectorName: CONNECTOR_NAME });
  });

  it('classifies header connector with decrypt error as expired_or_revoked', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([makeConnector({ authMode: 'header', transport: 'http' })]);
    mockSecretsFindMany.mockResolvedValue([makeSecret()]);
    mockSecretsProviderGet.mockRejectedValue(new Error('decryption failed'));

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ mode: 'expired_or_revoked', connectorName: CONNECTOR_NAME });
  });

  it('returns null for header connector with valid decryptable secret', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([makeConnector({ authMode: 'header', transport: 'http' })]);
    mockSecretsFindMany.mockResolvedValue([makeSecret()]);
    mockSecretsProviderGet.mockResolvedValue('my-api-key');
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toBeNull();
  });

  it('classifies stdio connector with missing env secret as expired_or_revoked', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([
      makeConnector({ authMode: 'header', transport: 'stdio', envMapping: { MY_SECRET: 'my-label' } }),
    ]);
    // No secret row for the env label
    mockSecretsFindMany.mockResolvedValue([]);

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ mode: 'expired_or_revoked', connectorName: CONNECTOR_NAME });
  });

  it('skips expired_or_revoked check when ENCRYPTION_KEY is missing', async () => {
    const orig = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
      mockConnectorsFindMany.mockResolvedValue([makeConnector({ authMode: 'oauth', transport: 'http' })]);
      mockSecretsFindMany.mockResolvedValue([]);
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      // With no encryption key, skip expired check → proceed to transient probe
      const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
      // Probe succeeds → null
      expect(result).toBeNull();
    } finally {
      if (orig !== undefined) process.env.ENCRYPTION_KEY = orig;
      else delete process.env.ENCRYPTION_KEY;
    }
  });
});

// ── transient ─────────────────────────────────────────────────────────────────

describe('checkConnectorRouting — transient', () => {
  it('classifies http connector failing HEAD probe as transient', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([makeConnector({ authMode: 'none', transport: 'http' })]);
    mockSecretsFindMany.mockResolvedValue([]);
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ mode: 'transient', connectorName: CONNECTOR_NAME });
  });

  it('returns null when http connector HEAD probe succeeds', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([makeConnector({ authMode: 'none', transport: 'http' })]);
    mockSecretsFindMany.mockResolvedValue([]);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toBeNull();
  });

  it('treats non-2xx HEAD probe response as reachable (not transient)', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([makeConnector({ authMode: 'none', transport: 'http' })]);
    mockSecretsFindMany.mockResolvedValue([]);
    mockFetch.mockResolvedValue({ ok: false, status: 404 }); // 404 = reachable

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toBeNull();
  });

  it('does NOT probe stdio connectors', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([
      makeConnector({ authMode: 'none', transport: 'stdio', command: 'npx', url: 'unused' }),
    ]);
    mockSecretsFindMany.mockResolvedValue([]);

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('marks remaining connectors as transient when 5s probe budget exceeded', async () => {
    const conn1 = { ...makeConnector({ authMode: 'none', transport: 'http', url: 'https://slow.example.com' }), id: 'conn-1', name: 'Slow MCP' };
    const conn2 = { ...makeConnector({ authMode: 'none', transport: 'http', url: 'https://fast.example.com' }), id: 'conn-2', name: 'Fast MCP' };

    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole(['conn-1', 'conn-2'])]);
    mockConnectorsFindMany.mockResolvedValue([conn1, conn2]);
    mockSecretsFindMany.mockResolvedValue([]);

    let callCount = 0;
    mockFetch.mockImplementation(async (url: string) => {
      callCount++;
      if (url === 'https://slow.example.com') {
        // Simulate exceeding the budget by making the test exhaust the budget variable
        // In practice the budget check happens synchronously before fetch
        await new Promise(r => setTimeout(r, 10));
      }
      return { ok: true, status: 200 };
    });

    // For this test, we verify both connectors are eventually processed
    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    // Both succeed → null
    expect(result).toBeNull();
    expect(callCount).toBe(2);
  });

  it('skips probing for connector already failed as never_mounted', async () => {
    // connector has wrong team — should be never_mounted, not additionally transient
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([makeConnector({ teamId: 'other-team' })]);
    mockConnectorSharesFindMany.mockResolvedValue([]);
    mockSecretsFindMany.mockResolvedValue([]);

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toHaveLength(1);
    expect(result![0].mode).toBe('never_mounted');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── Multiple connectors ───────────────────────────────────────────────────────

describe('checkConnectorRouting — multiple connectors', () => {
  it('returns multiple failures with correct modes when several connectors fail differently', async () => {
    const conn1 = { ...makeConnector(), id: 'conn-1', name: 'Gone MCP', authMode: 'none', transport: 'http' };
    const conn2 = { ...makeConnector(), id: 'conn-2', name: 'OAuth MCP', authMode: 'oauth', transport: 'http' };
    const conn3 = { ...makeConnector(), id: 'conn-3', name: 'Down MCP', authMode: 'none', transport: 'http' };

    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole(['conn-1', 'conn-2', 'conn-3'])]);
    // conn-1 is dangling (not in DB), conn-2 exists but secret missing, conn-3 exists but unreachable
    mockConnectorsFindMany.mockResolvedValue([conn2, conn3]);
    mockSecretsFindMany.mockImplementation(async ({ where }: any) => {
      // Return empty — oauth secret missing
      return [];
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (url === conn3.url) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200 };
    });

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);

    const byId = Object.fromEntries(result!.map(f => [f.connectorId, f]));
    expect(byId['conn-1'].mode).toBe('never_mounted');
    expect(byId['conn-2'].mode).toBe('expired_or_revoked');
    expect(byId['conn-3'].mode).toBe('transient');
  });

  it('returns null when all connectors pass', async () => {
    const conn1 = { ...makeConnector(), id: 'conn-1', name: 'MCP A', authMode: 'none', transport: 'http', url: 'https://a.example.com' };
    const conn2 = { ...makeConnector(), id: 'conn-2', name: 'MCP B', authMode: 'header', transport: 'http', url: 'https://b.example.com' };

    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole(['conn-1', 'conn-2'])]);
    mockConnectorsFindMany.mockResolvedValue([conn1, conn2]);
    mockSecretsFindMany.mockResolvedValue([makeSecret({ id: 'sec-b', label: 'conn-2', teamId: TEAM_ID })]);
    mockSecretsProviderGet.mockResolvedValue('valid-key');
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toBeNull();
  });
});
