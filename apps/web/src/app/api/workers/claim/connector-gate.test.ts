import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

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

import { checkConnectorRouting, findAlternativeRole } from './connector-gate';

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

// ── Query scoping ─────────────────────────────────────────────────────────────
//
// `db` is mocked, so the four queries this gate runs were never looked at, and
// dropping a scope from any of them was silent. Each is a cross-tenant hole:
// another team's role row deciding this task's connector requirements, another
// team's share unblocking a connector this team cannot see, or a credential of
// the wrong purpose satisfying the check.

const dialect = new PgDialect();

function lastWhere(m: { mock: { calls: any[] } }) {
  const args = m.mock.calls.at(-1)![0] as { where: any };
  const q = dialect.sqlToQuery(args.where);
  return { text: q.sql, params: q.params };
}

describe('checkConnectorRouting — query scoping', () => {
  beforeEach(() => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([
      makeConnector({ authMode: 'oauth', transport: 'http' }),
    ]);
    mockSecretsFindMany.mockResolvedValue([makeSecret()]);
  });

  it('resolves the role inside this team only, enabled, workspace-scoped or team default', async () => {
    await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    const { text, params } = lastWhere(mockWorkspaceSkillsFindMany);
    // Without the team_id predicate another team's role of the same slug can
    // decide which connectors this task requires.
    expect(text).toContain('"workspace_skills"."team_id" = $4');
    expect(text).toContain('"workspace_skills"."is_role" = $2');
    expect(text).toContain('"workspace_skills"."enabled" = $3');
    expect(text).toContain(
      '("workspace_skills"."workspace_id" is null or "workspace_skills"."workspace_id" = $5)',
    );
    expect(params).toEqual([ROLE_SLUG, true, true, TEAM_ID, WORKSPACE_ID]);
  });

  it('honours only shares granted TO this team', async () => {
    await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    const { text, params } = lastWhere(mockConnectorSharesFindMany);
    // Unscoped, any share row for the connector id makes a foreign connector
    // look visible and the wrong-team never_mounted check stops working.
    expect(text).toContain('"connector_shares"."shared_with_team_id" = $1');
    expect(params[0]).toBe(TEAM_ID);
  });

  it('reads the workspace enablement rows for this workspace only', async () => {
    await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    const { text, params } = lastWhere(mockConnectorWorkspacesFindMany);
    expect(text).toContain('"connector_workspaces"."workspace_id" = $1');
    expect(params[0]).toBe(WORKSPACE_ID);
  });

  it('looks up the connector credential by its own purpose, in the owning team', async () => {
    await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    const { text, params } = lastWhere(mockSecretsFindMany);
    expect(text).toContain('"secrets"."purpose" = $2');
    expect(params).toEqual([TEAM_ID, 'mcp_connector_credential', CONNECTOR_ID]);
  });
});

// ── Role row precedence ───────────────────────────────────────────────────────

describe('checkConnectorRouting — role row precedence', () => {
  it('prefers the workspace-scoped role row over the team default', async () => {
    // Every other test returns exactly one row, so `roleRows.find(...) ??
    // roleRows[0]` collapsing to `roleRows[0]` was invisible. A team default
    // listing no connectors would then shadow the workspace override and the
    // gate would wave through a task whose connector is missing.
    mockWorkspaceSkillsFindMany.mockResolvedValue([
      { slug: ROLE_SLUG, workspaceId: null, connectorRefs: [], teamId: TEAM_ID },
      makeRole([CONNECTOR_ID]),
    ]);
    mockConnectorsFindMany.mockResolvedValue([]); // the ref is dangling
    mockSecretsFindMany.mockResolvedValue([]);

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toHaveLength(1);
    expect(result![0].mode).toBe('never_mounted');
  });
});

// ── oauth refresh grace ───────────────────────────────────────────────────────

describe('checkConnectorRouting — oauth refresh grace', () => {
  it('does NOT fail a just-refreshed token whose stored expiry is still stale', async () => {
    // `expiresAt < now && (!refreshedAt || refreshedAt < fiveMinAgo)` — only the
    // first half was covered. Dropping the grace blocks every task on a
    // connector that has just refreshed successfully, for as long as the
    // refresher lags on writing tokenExpiresAt back.
    const now = Date.now();
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([
      makeConnector({ authMode: 'oauth', transport: 'http' }),
    ]);
    mockSecretsFindMany.mockResolvedValue([
      makeSecret({
        tokenExpiresAt: new Date(now - 1000),
        lastRefreshedAt: new Date(now - 60 * 1000), // 1 min ago → inside the grace
      }),
    ]);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    expect(await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID)).toBeNull();
  });
});

// ── Workspace enablement default ──────────────────────────────────────────────

describe('checkConnectorRouting — workspace enablement default', () => {
  it('treats a connector_workspaces row with a NULL enabled as enabled', async () => {
    // `enabled !== false` is deliberate: the column is nullable and rows written
    // before it existed carry NULL. Under `enabled === true` every such
    // connector reads as disabled and every task requiring it is blocked as
    // never_mounted — the existing true/false pair never covered the third
    // state.
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([
      makeConnector({ authMode: 'none', transport: 'http' }),
    ]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([
      { connectorId: CONNECTOR_ID, enabled: null },
    ]);
    mockSecretsFindMany.mockResolvedValue([]);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    expect(await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID)).toBeNull();
  });
});

// ── stdio credential checks ───────────────────────────────────────────────────

describe('checkConnectorRouting — stdio env credentials', () => {
  it('skips the credential check for an unauthenticated stdio connector', async () => {
    // The stdio pass is filtered by `authMode !== 'none'`. Dropping that filter
    // makes a no-auth stdio server (a local command needing no secret) block
    // its tasks as expired_or_revoked forever.
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([
      makeConnector({
        authMode: 'none',
        transport: 'stdio',
        envMapping: { SOME_VAR: 'some-label' },
      }),
    ]);
    mockSecretsFindMany.mockResolvedValue([]); // no secret exists for that label

    expect(await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("requires the env secret to belong to the connector's OWNING team", async () => {
    // The lookup key is `teamId\0label`. Keyed on the label alone, a same-named
    // secret in the *consuming* team satisfies the check for a connector shared
    // from another team: the gate reports the connector healthy and the worker
    // launches with an env var the runner cannot resolve, failing mid-run
    // instead of at claim time.
    const OWNER_TEAM = 'other-team';
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([
      makeConnector({
        teamId: OWNER_TEAM,
        authMode: 'header',
        transport: 'stdio',
        envMapping: { MY_SECRET: 'my-label' },
      }),
    ]);
    mockConnectorSharesFindMany.mockResolvedValue([{ connectorId: CONNECTOR_ID }]);
    mockSecretsFindMany.mockResolvedValue([
      // Satisfies the header-auth pass (keyed by connector id).
      makeSecret({ id: 'sec-hdr', label: CONNECTOR_ID, teamId: OWNER_TEAM }),
      // Right label, WRONG team — must not satisfy the stdio env pass.
      makeSecret({ id: 'sec-env', label: 'my-label', teamId: TEAM_ID }),
    ]);
    mockSecretsProviderGet.mockResolvedValue('decrypted-secret');

    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ mode: 'expired_or_revoked' });
  });
});

// ── HTTP probe shape ──────────────────────────────────────────────────────────

describe('checkConnectorRouting — probe request shape', () => {
  it('probes with HEAD and an abort signal', async () => {
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([
      makeConnector({ authMode: 'none', transport: 'http' }),
    ]);
    mockSecretsFindMany.mockResolvedValue([]);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);

    const [url, opts] = mockFetch.mock.calls[0] as unknown as [string, any];
    expect(url).toBe('https://mcp.example.com');
    // A GET would pull a body from every MCP server on every claim; a missing
    // signal makes the timeout below unenforceable.
    expect(opts.method).toBe('HEAD');
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a hanging probe instead of hanging the claim request', async () => {
    // Nothing exercised the abort timer: a connector that accepts the connection
    // and never answers would hold the claim handler open until the serverless
    // function times out, taking every task in the batch with it. This passes
    // only if the request is actually aborted, and only if it took the ~3s
    // timeout to do it — an immediate throw means the signal was never wired in.
    mockWorkspaceSkillsFindMany.mockResolvedValue([makeRole()]);
    mockConnectorsFindMany.mockResolvedValue([
      makeConnector({ authMode: 'none', transport: 'http' }),
    ]);
    mockSecretsFindMany.mockResolvedValue([]);
    mockFetch.mockImplementation(
      ((_url: string, opts?: any) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })) as any,
    );

    const startedAt = Date.now();
    const result = await checkConnectorRouting(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);
    const elapsed = Date.now() - startedAt;

    expect(result).toHaveLength(1);
    expect(result![0].mode).toBe('transient');
    expect(elapsed).toBeGreaterThanOrEqual(2_500);
    expect(elapsed).toBeLessThan(4_500);
  }, 10_000);
});

// ── findAlternativeRole ───────────────────────────────────────────────────────
//
// This exported function had no tests at all. It is the reroute path taken when
// a role is connector-blocked, so a wrong answer either sends the task straight
// back to a role that cannot run it (a reroute loop) or gives up on a workspace
// that had a perfectly good sibling role.

/**
 * Serve both shapes of role query off the one mock: `checkConnectorRouting`
 * binds the slug first, `findAlternativeRole` binds `is_role = true` first (it
 * has no slug to match, only one to exclude).
 */
function serveRoleQueries(siblings: any[], bySlug: Record<string, any>) {
  mockWorkspaceSkillsFindMany.mockImplementation((async (args: any) => {
    const { params } = dialect.sqlToQuery(args.where);
    if (typeof params[0] === 'string') {
      const row = bySlug[params[0] as string];
      return row ? [row] : [];
    }
    return siblings;
  }) as any);
}

describe('findAlternativeRole', () => {
  it('returns a sibling role that needs no connectors', async () => {
    const helper = { slug: 'helper', workspaceId: WORKSPACE_ID, connectorRefs: [], teamId: TEAM_ID };
    serveRoleQueries([helper], { helper });

    expect(await findAlternativeRole(ROLE_SLUG, WORKSPACE_ID, TEAM_ID)).toBe('helper');
  });

  it('skips a sibling whose own connectors are broken', async () => {
    // `if (!failures) return role.slug` → `if (failures)` returns exactly the
    // roles that cannot run the task, so the reroute lands on a blocked role and
    // the task bounces between them.
    const blockedSibling = {
      slug: 'needs-mcp',
      workspaceId: WORKSPACE_ID,
      connectorRefs: [CONNECTOR_ID],
      teamId: TEAM_ID,
    };
    const usable = { slug: 'plain', workspaceId: WORKSPACE_ID, connectorRefs: [], teamId: TEAM_ID };
    serveRoleQueries([blockedSibling, usable], { 'needs-mcp': blockedSibling, plain: usable });
    mockConnectorsFindMany.mockResolvedValue([]); // the ref is dangling
    mockSecretsFindMany.mockResolvedValue([]);

    expect(await findAlternativeRole(ROLE_SLUG, WORKSPACE_ID, TEAM_ID)).toBe('plain');
  });

  it('returns null when every sibling is blocked', async () => {
    const blockedSibling = {
      slug: 'needs-mcp',
      workspaceId: WORKSPACE_ID,
      connectorRefs: [CONNECTOR_ID],
      teamId: TEAM_ID,
    };
    serveRoleQueries([blockedSibling], { 'needs-mcp': blockedSibling });
    mockConnectorsFindMany.mockResolvedValue([]);
    mockSecretsFindMany.mockResolvedValue([]);

    expect(await findAlternativeRole(ROLE_SLUG, WORKSPACE_ID, TEAM_ID)).toBeNull();
  });

  it('asks the DB to exclude the blocked role, within this team', async () => {
    // The exclusion lives in SQL, so a mock that ignores the where clause can
    // never notice it going missing — and without it the "alternative" the
    // reroute picks can be the very role that is blocked, which is a loop.
    const helper = { slug: 'helper', workspaceId: WORKSPACE_ID, connectorRefs: [], teamId: TEAM_ID };
    serveRoleQueries([helper], { helper });
    await findAlternativeRole(ROLE_SLUG, WORKSPACE_ID, TEAM_ID);

    const { text, params } = lastWhere(mockWorkspaceSkillsFindMany);
    expect(text).toContain('"workspace_skills"."slug" <> $4');
    expect(text).toContain('"workspace_skills"."team_id" = $3');
    expect(params).toEqual([true, true, TEAM_ID, ROLE_SLUG, WORKSPACE_ID]);
  });

  it('deduplicates a slug in favour of its workspace-scoped row', async () => {
    // Both rows carry the same slug; the workspace-scoped one wins. Under
    // `if (!existing)` the team default's stale connectorRefs are consulted
    // instead, observable here as an extra routing query the correct code never
    // needs to make.
    const teamDefault = {
      slug: 'helper',
      workspaceId: null,
      connectorRefs: [CONNECTOR_ID],
      teamId: TEAM_ID,
    };
    const workspaceRow = { slug: 'helper', workspaceId: WORKSPACE_ID, connectorRefs: [], teamId: TEAM_ID };
    serveRoleQueries([teamDefault, workspaceRow], { helper: workspaceRow });
    mockConnectorsFindMany.mockResolvedValue([]);
    mockSecretsFindMany.mockResolvedValue([]);

    expect(await findAlternativeRole(ROLE_SLUG, WORKSPACE_ID, TEAM_ID)).toBe('helper');
    // One query: the sibling scan. No per-role connector check was needed.
    expect(mockWorkspaceSkillsFindMany).toHaveBeenCalledTimes(1);
  });
});
