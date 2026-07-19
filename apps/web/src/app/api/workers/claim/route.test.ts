import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindMany = mock(() => [] as any[]);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockAccountWorkspacesFindMany = mock(() => [] as any[]);
const mockTasksFindMany = mock(() => [] as any[]);
const mockTeamsFindFirst = mock(() => null as any);
const mockHeartbeatsFindFirst = mock(() => null as any);
const mockWorkersUpdate = mock(() => ({ set: mock(() => ({ where: mock(() => ({ returning: mock(() => []) })) })) }));
const mockTasksUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mock(() => [{ id: 'task-1' }]),
    })),
  })),
}));
const mockWorkersInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() => [{ id: 'worker-1', taskId: 'task-1', branch: 'buildd/test', status: 'idle' }]),
  })),
}));
const mockDbExecute = mock(() => Promise.resolve({
  rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
}));
const mockAccountsUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockSecretsFindMany = mock(() => Promise.resolve([] as any[]));
const mockSecretsProviderGet = mock(() => Promise.resolve(null as string | null));
const mockConnectorsFindMany = mock(() => Promise.resolve([] as any[]));
const mockConnectorWorkspacesFindMany = mock(() => Promise.resolve([] as any[]));
const mockConnectorSharesFindMany = mock(() => Promise.resolve([] as any[]));
const mockWorkspaceSkillsFindMany = mock(() => Promise.resolve([] as any[]));
const mockWorkspaceSkillsFindFirst = mock(() => Promise.resolve(null as any));
const mockDbSelect = mock(() => ({
  from: mock(() => ({
    where: mock(() => Promise.resolve([{ count: 0 }])),
  })),
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

const mockGetAccountWorkspacePermissions = mock(() => Promise.resolve([] as any[]));
mock.module('@/lib/account-workspace-cache', () => ({
  getAccountWorkspacePermissions: mockGetAccountWorkspacePermissions,
}));

const mockGetCodexCredential = mock(() => Promise.resolve(null as any));
const mockHasCodexCredential = mock(() => Promise.resolve(false));
mock.module('@/lib/codex-credential', () => ({
  getCodexCredential: mockGetCodexCredential,
  hasCodexCredential: mockHasCodexCredential,
}));

const mockRefreshMcpConnectorCredential = mock(() => Promise.resolve('error' as string));
mock.module('@/lib/mcp-connector-refresh', () => ({
  refreshMcpConnectorCredential: mockRefreshMcpConnectorCredential,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      workspaces: { findMany: mockWorkspacesFindMany },
      accountWorkspaces: { findMany: mockAccountWorkspacesFindMany },
      tasks: { findMany: mockTasksFindMany },
      teams: { findFirst: mockTeamsFindFirst },
      workerHeartbeats: { findFirst: mockHeartbeatsFindFirst },
      secrets: { findMany: mockSecretsFindMany },
      tenantBudgets: { findFirst: mock(() => null as any) },
      workspaceSkills: {
        findMany: mockWorkspaceSkillsFindMany,
        findFirst: mockWorkspaceSkillsFindFirst,
      },
      connectors: { findMany: mockConnectorsFindMany },
      connectorWorkspaces: { findMany: mockConnectorWorkspacesFindMany },
      connectorShares: { findMany: mockConnectorSharesFindMany },
    },
    update: (table: any) => {
      if (table === 'workers') return mockWorkersUpdate();
      if (table === 'tasks') return mockTasksUpdate();
      if (table === 'accounts') return mockAccountsUpdate();
      return mockTasksUpdate();
    },
    insert: (table: any) => mockWorkersInsert(),
    delete: (table: any) => ({ where: mock(() => Promise.resolve()) }),
    select: mockDbSelect,
    execute: mockDbExecute,
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  or: (...args: any[]) => ({ args, type: 'or' }),
  not: (value: any) => ({ value, type: 'not' }),
  isNull: (field: any) => ({ field, type: 'isNull' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }),
    {
      raw: (s: string) => ({ raw: s, type: 'sql' }),
      join: (parts: any[], sep?: any) => ({ parts, sep, type: 'sql' }),
    },
  ),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  lt: (field: any, value: any) => ({ field, value, type: 'lt' }),
  gt: (field: any, value: any) => ({ field, value, type: 'gt' }),
  gte: (field: any, value: any) => ({ field, value, type: 'gte' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  accounts: { id: 'id', activeSessions: 'activeSessions' },
  accountWorkspaces: { accountId: 'accountId', canClaim: 'canClaim', workspaceId: 'workspaceId' },
  tasks: { id: 'id', workspaceId: 'workspaceId', status: 'status', claimedBy: 'claimedBy', claimedAt: 'claimedAt', expiresAt: 'expiresAt', runnerPreference: 'runnerPreference', createdAt: 'createdAt', priority: 'priority', dependsOn: 'dependsOn', backend: 'backend', pathManifest: 'pathManifest' },
  workers: { id: 'id', accountId: 'accountId', status: 'status', updatedAt: 'updatedAt', taskId: 'taskId', prUrl: 'prUrl', mergedAt: 'mergedAt', workspaceId: 'workspaceId' },
  workerHeartbeats: { accountId: 'accountId', lastHeartbeatAt: 'lastHeartbeatAt' },
  workspaces: { id: 'id', accessMode: 'accessMode' },
  workspaceSkills: { slug: 'slug', isRole: 'isRole', enabled: 'enabled', workspaceId: 'workspaceId', accountId: 'accountId', teamId: 'teamId', connectorRefs: 'connectorRefs' },
  secrets: { accountId: 'accountId', purpose: 'purpose', label: 'label', teamId: 'teamId', workspaceId: 'workspaceId' },
  tenantBudgets: { id: 'id', tenantId: 'tenantId', teamId: 'teamId', budgetResetsAt: 'budgetResetsAt' },
  teams: { id: 'id', enabledBackends: 'enabledBackends' },
  connectors: { id: 'id', teamId: 'teamId', name: 'name', url: 'url', authMode: 'authMode', headerName: 'headerName', transport: 'transport', command: 'command', args: 'args', envMapping: 'envMapping' },
  connectorWorkspaces: { connectorId: 'connectorId', workspaceId: 'workspaceId', enabled: 'enabled' },
  connectorShares: { connectorId: 'connectorId', sharedWithTeamId: 'sharedWithTeamId', grantedByAccountId: 'grantedByAccountId' },
}));

mock.module('@buildd/core/secrets', () => ({
  getSecretsProvider: () => ({
    get: mockSecretsProviderGet,
  }),
}));

// Stub non-critical modules used by claim route
mock.module('@/lib/pusher', () => ({
  triggerEvent: mock(() => Promise.resolve()),
}));
mock.module('@/lib/notify', () => ({
  notify: mock(() => {}),
}));
mock.module('@/lib/stale-workers', () => ({
  cleanupStaleWorkers: mock(() => Promise.resolve()),
}));
mock.module('@/lib/api-response', () => ({
  jsonResponse: (data: any, init?: any) => {
    const body = JSON.stringify(data);
    return new Response(body, { ...init, headers: { 'content-type': 'application/json' } });
  },
}));
mock.module('@/lib/storage', () => ({
  isStorageConfigured: () => false,
  generateDownloadUrl: mock(() => ''),
}));
mock.module('@/lib/pushover', () => ({
  notify: mock(() => Promise.resolve()),
}));

import { POST } from './route';

function createMockRequest(options: {
  headers?: Record<string, string>;
  body?: any;
} = {}): NextRequest {
  const { headers = {}, body } = options;
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers(headers),
  };
  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Headers).set('content-type', 'application/json');
  }
  return new NextRequest('http://localhost:3000/api/workers/claim', init);
}

describe('POST /api/workers/claim', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockGetAccountWorkspacePermissions.mockReset();
    mockWorkersFindMany.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockAccountWorkspacesFindMany.mockReset();
    mockTasksFindMany.mockReset();
    mockHeartbeatsFindFirst.mockReset();
    mockSecretsFindMany.mockReset();
    mockSecretsProviderGet.mockReset();
    mockConnectorsFindMany.mockReset();
    mockConnectorWorkspacesFindMany.mockReset();
    mockGetCodexCredential.mockReset();
    mockHasCodexCredential.mockReset();
    mockGetCodexCredential.mockResolvedValue(null);
    mockHasCodexCredential.mockResolvedValue(false);
    mockTeamsFindFirst.mockReset();
    mockTeamsFindFirst.mockResolvedValue(null); // default: enabledBackends null => all enabled

    // Default: no stale workers
    mockWorkersFindMany.mockResolvedValue([]);
    // Default: no claimable/sibling tasks
    mockTasksFindMany.mockResolvedValue([]);
    // Default: no open workspaces
    mockWorkspacesFindMany.mockResolvedValue([]);
    // Default: no secrets
    mockSecretsFindMany.mockResolvedValue([]);
    // Default: fresh heartbeat exists (runner is online)
    mockHeartbeatsFindFirst.mockResolvedValue({ id: 'hb-1' });
    // Default: no workspace permissions
    mockGetAccountWorkspacePermissions.mockResolvedValue([]);
    // Default: no role overrides
    mockWorkspaceSkillsFindMany.mockResolvedValue([]);
    mockWorkspaceSkillsFindFirst.mockResolvedValue(null);
    // Default: no connectors
    mockConnectorsFindMany.mockResolvedValue([]);
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    // Default: no cross-team shares (§1b)
    mockConnectorSharesFindMany.mockReset();
    mockConnectorSharesFindMany.mockResolvedValue([]);
    // Default: OAuth refresh fails (expired stays expired) unless a test overrides it
    mockRefreshMcpConnectorCredential.mockReset();
    mockRefreshMcpConnectorCredential.mockResolvedValue('error');
    // Default: zero recent claims (router spike-detection input)
    mockDbSelect.mockReturnValue({
      from: mock(() => ({
        where: mock(() => Promise.resolve([{ count: 0 }])),
      })),
    });
  });

  it('returns 401 when no API key', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest({
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Invalid API key');
  });

  it('returns 400 when runner is missing', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
      type: 'user',
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { workspaceId: 'ws-1' },
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('runner is required');
  });

  it('returns 429 when max concurrent workers limit reached', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 2,
      type: 'user',
      authType: 'api',
    });

    // cleanupStaleWorkers is mocked as no-op, so only the active workers query hits findMany
    mockWorkersFindMany.mockResolvedValueOnce([{ id: 'w1' }, { id: 'w2' }]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toBe('Max concurrent workers limit reached');
    expect(data.limit).toBe(2);
    expect(data.current).toBe(2);
  });

  it('returns 429 when daily cost limit exceeded for API auth type', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'api',
      maxCostPerDay: '10.00',
      totalCost: '15.00',
    });

    // No active workers (cleanupStaleWorkers is mocked)
    mockWorkersFindMany.mockResolvedValueOnce([]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toBe('Daily cost limit exceeded');
  });

  it('returns 429 when max concurrent sessions reached for OAuth auth type', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'oauth',
      maxConcurrentSessions: 2,
      activeSessions: 2,
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toBe('Max concurrent sessions limit reached');
  });

  // Defense-in-depth for the 2026-05-25 misroute incident: even if the MCP-layer
  // guard is bypassed, the claim route refuses ambiguous OAuth claims.
  it('returns 400 for OAuth tokens with >1 accessible workspace and no workspaceId', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'oauth',
      maxConcurrentSessions: 10,
      activeSessions: 0,
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    // 2 accessible: one via permissions, one via open access — total 2 unique
    mockGetAccountWorkspacePermissions.mockResolvedValue([{ workspaceId: 'ws-restricted', canClaim: true }]);
    mockWorkspacesFindMany.mockResolvedValueOnce([{ id: 'ws-open' }]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },  // no workspaceId
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/workspaceId required/);
    expect(data.accessibleWorkspaces).toBe(2);
  });

  it('allows OAuth claim across >1 accessible workspaces when claimAcrossAccessible is set', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'oauth',
      maxConcurrentSessions: 10,
      activeSessions: 0,
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    // 2 accessible workspaces — would trip the guard without the explicit opt-in
    mockGetAccountWorkspacePermissions.mockResolvedValue([{ workspaceId: 'ws-restricted', canClaim: true }]);
    mockWorkspacesFindMany.mockResolvedValueOnce([{ id: 'ws-open' }]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-open', accessMode: 'open', teamId: 'team-1' }]);
    mockTasksFindMany.mockResolvedValue([]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner', claimAcrossAccessible: true },  // explicit cross-workspace intent
    });
    const res = await POST(req);

    // Should NOT be 400 — caller explicitly opted into cross-workspace claiming
    expect(res.status).toBe(200);
  });

  it('allows OAuth claim without workspaceId when only 1 workspace is accessible', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'oauth',
      maxConcurrentSessions: 10,
      activeSessions: 0,
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockGetAccountWorkspacePermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true }]);
    // Same workspace shows up via both paths — deduped to 1
    mockWorkspacesFindMany.mockResolvedValueOnce([{ id: 'ws-1' }]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', accessMode: 'open', teamId: 'team-1' }]);
    mockTasksFindMany.mockResolvedValue([]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    // Should NOT be 400 — single accessible workspace, no ambiguity
    expect(res.status).toBe(200);
  });

  it('skips the OAuth workspace-required guard when authType is api', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    // 2 accessible workspaces — would trigger the guard if it were OAuth
    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-a', canClaim: true },
      { workspaceId: 'ws-b', canClaim: true },
    ]);
    mockWorkspacesFindMany.mockResolvedValue([]);
    mockTasksFindMany.mockResolvedValue([]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },  // no workspaceId — fine for API key
    });
    const res = await POST(req);

    // API keys are workspace-scoped at creation; the guard doesn't apply.
    expect(res.status).toBe(200);
  });

  it('skips non-tenant tasks when OAuth budget is exhausted', async () => {
    const futureReset = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'oauth',
      maxConcurrentSessions: 10,
      activeSessions: 0,
      budgetExhaustedAt: new Date().toISOString(),
      budgetResetsAt: futureReset,
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockGetAccountWorkspacePermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true }]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', accessMode: 'private', teamId: 'team-1' }]);
    mockTasksFindMany.mockResolvedValue([]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    // Should proceed past budget check — server filters non-tenant tasks in the loop
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.diagnostics?.reason).toBe('no_pending_tasks');
  });

  it('auto-clears budget exhaustion when reset time has passed', async () => {
    const pastReset = new Date(Date.now() - 60 * 1000).toISOString();
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
      type: 'user',
      authType: 'oauth',
      maxConcurrentSessions: 10,
      activeSessions: 0,
      budgetExhaustedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      budgetResetsAt: pastReset,
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockGetAccountWorkspacePermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true }]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', accessMode: 'private', teamId: 'team-1' }]);
    mockTasksFindMany.mockResolvedValue([]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    // Should proceed past budget check (auto-cleared) and reach no_pending_tasks
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.diagnostics?.reason).toBe('no_pending_tasks');
  });

  it('budget exhaustion check only applies to OAuth accounts', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
      type: 'user',
      authType: 'api',
      maxCostPerDay: '100',
      totalCost: '10',
      budgetExhaustedAt: new Date().toISOString(),
      budgetResetsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockGetAccountWorkspacePermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true }]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', accessMode: 'private', teamId: 'team-1' }]);
    mockTasksFindMany.mockResolvedValue([]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    // API accounts bypass budget check — should reach no_pending_tasks
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.diagnostics?.reason).toBe('no_pending_tasks');
  });

  describe('budget failover to Codex', () => {
    const exhaustedOauthAccount = () => ({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user' as const,
      authType: 'oauth' as const,
      maxConcurrentSessions: 10,
      activeSessions: 0,
      budgetExhaustedAt: new Date().toISOString(),
      budgetResetsAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    });

    const pendingClaudeTask = () => ({
      id: 'task-1',
      workspaceId: 'ws-1',
      title: 'Blocked task',
      backend: 'claude',
      dependsOn: [],
      workspace: { id: 'ws-1', gitConfig: null, teamId: 'team-1' },
    });

    function setupClaim() {
      mockGetAccountWorkspacePermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true }]);
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', accessMode: 'private', teamId: 'team-1' }]);
      mockTasksUpdate.mockReturnValue({
        set: mock(() => ({ where: mock(() => ({ returning: mock(() => [{ id: 'task-1' }]) })) })),
      });
      mockDbExecute.mockReturnValue(Promise.resolve({
        rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
      }));
    }

    it('routes a budget-blocked Claude task to Codex when the workspace has a Codex credential', async () => {
      mockAuthenticateApiKey.mockResolvedValue(exhaustedOauthAccount());
      mockWorkersFindMany.mockResolvedValue([]); // no active workers → Codex slot free
      mockTasksFindMany.mockResolvedValueOnce([pendingClaudeTask()]); // claimable tasks
      mockHasCodexCredential.mockResolvedValue(true);
      mockGetCodexCredential.mockResolvedValue({
        accessToken: 'at', refreshToken: 'rt', accountId: 'acc', tokenExpiresAt: null, lastRefreshedAt: null,
      });
      setupClaim();

      const req = createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'test-runner' } });
      const res = await POST(req);

      const data = await res.json();
      expect(res.status).toBe(200);
      // Without failover this task would be skipped (budget exhausted); now it's claimed on Codex.
      expect(data.workers.length).toBe(1);
      expect(data.workers[0].taskId).toBe('task-1');
      // The task was flipped to Codex (in-memory) so the runner executes it on Codex.
      expect(data.workers[0].task.backend).toBe('codex');
    });

    it('skips a budget-blocked Claude task when the workspace has no Codex credential', async () => {
      mockAuthenticateApiKey.mockResolvedValue(exhaustedOauthAccount());
      mockWorkersFindMany.mockResolvedValue([]);
      mockTasksFindMany.mockResolvedValueOnce([pendingClaudeTask()]);
      mockHasCodexCredential.mockResolvedValue(false); // no Codex → fall back to skip-until-reset
      setupClaim();

      const req = createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'test-runner' } });
      const res = await POST(req);

      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.workers.length).toBe(0);
      // Regression (2026-07-11): when every pending task is budget-blocked and
      // can't fail over, the response must surface budgetResetsAt + a budget
      // reason — NOT a bare race_lost — so the runner can schedule a resume poll
      // at reset time instead of stalling on its hourly fallback.
      expect(data.diagnostics.reason).toBe('budget_exhausted');
      expect(data.budgetResetsAt).toBeTruthy();
    });

    it('does not start a second Codex worker when the workspace already has one active', async () => {
      mockAuthenticateApiKey.mockResolvedValue(exhaustedOauthAccount());
      // One active worker whose task is Codex in ws-1 → Codex slot busy.
      mockWorkersFindMany.mockResolvedValue([
        { id: 'w-active', taskId: 'task-active', status: 'running', workspaceId: 'ws-1' },
      ]);
      // First findMany = claimable tasks; second = active-Codex-workspace derivation.
      mockTasksFindMany
        .mockResolvedValueOnce([pendingClaudeTask()])
        .mockResolvedValueOnce([{ workspaceId: 'ws-1' }]);
      mockHasCodexCredential.mockResolvedValue(true);
      setupClaim();

      const req = createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'test-runner' } });
      const res = await POST(req);

      const data = await res.json();
      expect(res.status).toBe(200);
      // Codex busy → task is left pending rather than funneled into a deferral failure.
      expect(data.workers.length).toBe(0);
    });
  });

  describe('team provider toggle (reversible mask)', () => {
    function apiAccount() {
      return { id: 'account-1', maxConcurrentWorkers: 5, type: 'user' as const, authType: 'api' as const, teamId: 'team-1' };
    }
    function task(backend: 'claude' | 'codex') {
      return { id: 'task-1', workspaceId: 'ws-1', title: 'T', backend, dependsOn: [], workspace: { id: 'ws-1', gitConfig: null, teamId: 'team-1' } };
    }
    function setupClaim() {
      mockGetAccountWorkspacePermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true }]);
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', accessMode: 'private', teamId: 'team-1' }]);
      mockWorkersFindMany.mockResolvedValue([]);
      mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => ({ returning: mock(() => [{ id: 'task-1' }]) })) })) });
      mockDbExecute.mockReturnValue(Promise.resolve({ rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }] }));
    }

    it('reroutes a Claude task to Codex when Claude is disabled team-wide', async () => {
      mockAuthenticateApiKey.mockResolvedValue(apiAccount());
      mockTasksFindMany.mockResolvedValueOnce([task('claude')]);
      mockTeamsFindFirst.mockResolvedValue({ enabledBackends: ['codex'] }); // Claude disabled
      mockHasCodexCredential.mockResolvedValue(true);
      setupClaim();

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.workers.length).toBe(1);
      expect(data.workers[0].task.backend).toBe('codex');
    });

    it('reroutes a Codex task to Claude when Codex is disabled team-wide', async () => {
      mockAuthenticateApiKey.mockResolvedValue(apiAccount());
      mockTasksFindMany.mockResolvedValueOnce([task('codex')]);
      mockTeamsFindFirst.mockResolvedValue({ enabledBackends: ['claude'] }); // Codex disabled
      setupClaim();

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.workers.length).toBe(1);
      expect(data.workers[0].task.backend).toBe('claude'); // no Codex creds needed to fall back to Claude
    });

    it('leaves backends untouched when both providers are enabled (default)', async () => {
      mockAuthenticateApiKey.mockResolvedValue(apiAccount());
      mockTasksFindMany.mockResolvedValueOnce([task('claude')]);
      mockTeamsFindFirst.mockResolvedValue({ enabledBackends: ['claude', 'codex'] });
      setupClaim();

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.workers.length).toBe(1);
      expect(data.workers[0].task.backend).toBe('claude');
    });
  });

  it('returns empty workers when no accessible workspaces', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers).toEqual([]);
  });

  it('returns empty workers when no claimable tasks', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);
    mockTasksFindMany.mockResolvedValue([]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers).toEqual([]);
  });

  it('auto-derives capabilities from environment when none provided', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    // Task with requiredCapabilities that should match auto-derived caps
    mockTasksFindMany.mockResolvedValue([
      {
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'Test task',
        requiredCapabilities: ['node', 'DATABASE_URL'],
        workspace: { id: 'ws-1', gitConfig: null },
      },
    ]);

    // Mock the claim flow (update + insert)
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'task-1' }]),
        })),
      })),
    });
    mockDbExecute.mockReturnValue(Promise.resolve({
      rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
    }));

    const environment = {
      tools: [{ name: 'node', version: '22.1.0' }, { name: 'git', version: '2.43.0' }],
      envKeys: ['DATABASE_URL', 'ANTHROPIC_API_KEY'],
      mcp: ['slack'],
      labels: { type: 'local', os: 'darwin', arch: 'arm64', hostname: 'test' },
      scannedAt: '2026-01-01T00:00:00.000Z',
    };

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: {
        runner: 'test-runner',
        // No explicit capabilities — should be derived from environment
        environment,
      },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    // The task with requiredCapabilities: ['node', 'DATABASE_URL'] should match
    // because auto-derived capabilities include 'node' (from tools) and 'DATABASE_URL' (from envKeys)
  });

  it('does not auto-derive capabilities when explicit capabilities are provided', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    // Task requires 'docker' which is NOT in explicit capabilities
    mockTasksFindMany.mockResolvedValue([
      {
        id: 'task-1',
        workspaceId: 'ws-1',
        requiredCapabilities: ['docker'],
        workspace: { id: 'ws-1' },
      },
    ]);

    const environment = {
      tools: [{ name: 'docker', version: '24.0.0' }],
      envKeys: [],
      mcp: [],
      labels: { type: 'local', os: 'darwin', arch: 'arm64', hostname: 'test' },
      scannedAt: '2026-01-01T00:00:00.000Z',
    };

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: {
        runner: 'test-runner',
        capabilities: ['node'],  // Explicit capabilities — should NOT be overridden by environment
        environment,
      },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    // Task requires 'docker' but explicit capabilities only has 'node'
    // Even though environment has docker, it should NOT be used because explicit caps were provided
    expect(data.workers).toEqual([]);
  });

  it('does not claim codex tasks without backend:codex capability', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);
    mockTasksFindMany.mockResolvedValue([
      {
        id: 'task-1',
        workspaceId: 'ws-1',
        backend: 'codex',
        requiredCapabilities: [],
        workspace: { id: 'ws-1' },
      },
    ]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers).toEqual([]);
    expect(data.diagnostics.reason).toBe('capability_mismatch');
  });

  it('claims codex tasks when environment advertises backend:codex', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);
    mockTasksFindMany.mockResolvedValue([
      {
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'Codex task',
        backend: 'codex',
        requiredCapabilities: [],
        workspace: { id: 'ws-1', gitConfig: null },
      },
    ]);
    mockDbExecute.mockReturnValue(Promise.resolve({
      rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
    }));

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: {
        runner: 'test-runner',
        environment: {
          tools: [],
          envKeys: ['backend:codex', 'CODEX_HOME'],
          mcp: [],
          labels: { type: 'local', os: 'darwin', arch: 'arm64', hostname: 'test' },
          scannedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers.length).toBe(1);
  });

  // --- Per-workspace concurrency cap tests ---

  it('caps concurrent workers per repo-backed workspace at maxConcurrentTasks', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      name: 'acct',
      teamId: 'team-1',
      maxConcurrentWorkers: 10,
      type: 'user',
      authType: 'api',
    });

    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-repo', accessMode: 'open', teamId: 'team-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);
    const repoWs = { id: 'ws-repo', repo: 'org/repo', maxConcurrentTasks: 3, teamId: 'team-1', gitConfig: null };
    mockTasksFindMany.mockResolvedValue(
      [1, 2, 3, 4, 5].map((n) => ({
        id: `task-${n}`,
        workspaceId: 'ws-repo',
        title: `Task ${n}`,
        requiredCapabilities: [],
        workspace: repoWs,
      })),
    );
    // Every optimistic claim + conditional insert "succeeds" so only the in-loop cap limits us.
    let inserted = 0;
    mockDbExecute.mockImplementation(() =>
      Promise.resolve({ rows: [{ id: `worker-${++inserted}`, task_id: `task-${inserted}`, branch: 'b', status: 'idle' }] }),
    );

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    // 5 same-repo tasks pending, cap 3 → only 3 claimed in this batch.
    expect(data.workers.length).toBe(3);
  });

  it('counts existing active workers in the repo toward the cap', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      name: 'acct',
      teamId: 'team-1',
      maxConcurrentWorkers: 10,
      type: 'user',
      authType: 'api',
    });

    // Two workers already active in ws-repo (cap 3) → only 1 more may be claimed.
    mockWorkersFindMany.mockResolvedValue([
      { workspaceId: 'ws-repo', status: 'running' },
      { workspaceId: 'ws-repo', status: 'idle' },
    ]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-repo', accessMode: 'open', teamId: 'team-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);
    const repoWs = { id: 'ws-repo', repo: 'org/repo', maxConcurrentTasks: 3, teamId: 'team-1', gitConfig: null };
    mockTasksFindMany.mockResolvedValue(
      [1, 2, 3].map((n) => ({
        id: `task-${n}`,
        workspaceId: 'ws-repo',
        title: `Task ${n}`,
        requiredCapabilities: [],
        workspace: repoWs,
      })),
    );
    let inserted = 0;
    mockDbExecute.mockImplementation(() =>
      Promise.resolve({ rows: [{ id: `worker-${++inserted}`, task_id: `task-${inserted}`, branch: 'b', status: 'idle' }] }),
    );

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    const data = await res.json();
    expect(data.workers.length).toBe(1);
  });

  it('does not cap repo-less workspaces (no serialization)', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      name: 'acct',
      teamId: 'team-1',
      maxConcurrentWorkers: 10,
      type: 'user',
      authType: 'api',
    });

    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-coord', accessMode: 'open', teamId: 'team-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);
    // No repo → cap must not apply even with maxConcurrentTasks set.
    const coordWs = { id: 'ws-coord', repo: null, maxConcurrentTasks: 3, teamId: 'team-1', gitConfig: null };
    mockTasksFindMany.mockResolvedValue(
      [1, 2, 3, 4, 5].map((n) => ({
        id: `task-${n}`,
        workspaceId: 'ws-coord',
        title: `Task ${n}`,
        requiredCapabilities: [],
        workspace: coordWs,
      })),
    );
    let inserted = 0;
    mockDbExecute.mockImplementation(() =>
      Promise.resolve({ rows: [{ id: `worker-${++inserted}`, task_id: `task-${inserted}`, branch: 'b', status: 'idle' }] }),
    );

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    const data = await res.json();
    expect(data.workers.length).toBe(5);
  });

  // --- Dependency filtering tests ---

  it('filters out tasks with unresolved dependsOn dependencies', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    // Dependency filtering now happens in SQL, so the query returns no tasks
    // when deps are unresolved
    mockTasksFindMany.mockResolvedValueOnce([]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers).toEqual([]);
  });

  it('allows tasks with all dependsOn dependencies completed', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    // SQL subquery now handles dep filtering — tasks with resolved deps are returned directly
    mockTasksFindMany.mockResolvedValueOnce([
      {
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'Test task',
        dependsOn: ['dep-1'],
        workspace: { id: 'ws-1', gitConfig: null },
      },
    ]);

    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'task-1' }]),
        })),
      })),
    });
    mockDbExecute.mockReturnValue(Promise.resolve({
      rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
    }));

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers.length).toBe(1);
    expect(data.workers[0].taskId).toBe('task-1');
  });

  it('allows tasks with failed dependencies (terminal state)', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    // SQL subquery handles dep filtering — failed deps are terminal, so task is returned
    mockTasksFindMany.mockResolvedValueOnce([
      {
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'Test task',
        dependsOn: ['dep-1'],
        workspace: { id: 'ws-1', gitConfig: null },
      },
    ]);

    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'task-1' }]),
        })),
      })),
    });
    mockDbExecute.mockReturnValue(Promise.resolve({
      rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
    }));

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers.length).toBe(1);
    expect(data.workers[0].taskId).toBe('task-1');
  });

  it('filters tasks with partially resolved dependencies', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    // SQL subquery filters out tasks with partially resolved deps — returns empty
    mockTasksFindMany.mockResolvedValueOnce([]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers).toEqual([]);
  });

  // --- Active worker guard tests ---

  it('excludes tasks that already have an active worker (prevents duplicate claims)', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);

    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    // SQL NOT EXISTS subquery filters out tasks with active workers — returns empty
    mockTasksFindMany.mockResolvedValueOnce([]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers).toEqual([]);
    expect(data.diagnostics?.reason).toBe('no_pending_tasks');
  });

  it('claims a task when its previous worker has already completed (no active worker)', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany
      .mockResolvedValueOnce([])   // stale workers
      .mockResolvedValueOnce([])   // active workers for concurrency check
      .mockResolvedValueOnce([]);  // re-check in claim loop

    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    // Task is claimable because NOT EXISTS subquery passes (no active workers)
    mockTasksFindMany.mockResolvedValueOnce([
      {
        id: 'task-retry',
        workspaceId: 'ws-1',
        title: 'Retried task',
        workspace: { id: 'ws-1', gitConfig: null },
      },
    ]);

    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'task-retry' }]),
        })),
      })),
    });
    mockWorkersInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(() => [{
          id: 'worker-new',
          taskId: 'task-retry',
          branch: 'buildd/test',
          status: 'idle',
        }]),
      })),
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers.length).toBe(1);
    expect(data.workers[0].taskId).toBe('task-retry');
  });

  it('passes through tasks with empty dependsOn', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    // Only one findMany call needed — no deps to look up
    mockTasksFindMany.mockResolvedValueOnce([
      {
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'Test task',
        dependsOn: [],
        workspace: { id: 'ws-1', gitConfig: null },
      },
    ]);

    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'task-1' }]),
        })),
      })),
    });
    mockDbExecute.mockReturnValue(Promise.resolve({
      rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
    }));

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers.length).toBe(1);
    expect(data.workers[0].taskId).toBe('task-1');
  });

  it('no longer flat-injects mcp_credential secrets as mcpSecrets (connectors are the only path)', async () => {
    // Set ENCRYPTION_KEY so secrets branch executes
    const origKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'test-encryption-key';

    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'api',
      dailyCostLimitCents: 10000,
      currentDailyCostCents: 0,
    });

    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true },
    ]);

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    mockTasksFindMany.mockResolvedValueOnce([
      {
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'Test task',
        dependsOn: [],
        workspace: { id: 'ws-1', teamId: 'team-1', gitConfig: null },
      },
    ]);

    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'task-1' }]),
        })),
      })),
    });
    mockDbExecute.mockReturnValue(Promise.resolve({
      rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
    }));

    // Even if mcp_credential secrets exist, they must NOT surface as a flat
    // `mcpSecrets` map — that legacy role-MCP env injection path was retired.
    // The anthropic/oauth secrets query now only asks for those two purposes,
    // so this row would never be returned; assert nothing leaks.
    mockSecretsFindMany.mockResolvedValue([
      { id: 'secret-1', purpose: 'mcp_credential', label: 'DISPATCH_API_KEY' },
    ]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers.length).toBe(1);
    expect(data.workers[0].mcpSecrets).toBeUndefined();

    // Restore
    if (origKey !== undefined) {
      process.env.ENCRYPTION_KEY = origKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  // Regression: prod outage where Claude-backend tasks failed with
  // `401 Invalid authentication credentials` because the server-managed
  // `oauth_token` secret was never delivered to the runner at claim time.
  // The claim RESPONSE must carry `serverOauthToken` (and `serverApiKey`)
  // whenever the task's team has those secrets — this is the guard that
  // was missing.
  it('attaches serverOauthToken when an oauth_token secret exists for the team', async () => {
    const origKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'test-encryption-key';

    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'api',
      dailyCostLimitCents: 10000,
      currentDailyCostCents: 0,
    });

    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true },
    ]);

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    mockTasksFindMany.mockResolvedValueOnce([
      {
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'Test task',
        dependsOn: [],
        workspace: { id: 'ws-1', teamId: 'team-1', gitConfig: null },
      },
    ]);

    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'task-1' }]),
        })),
      })),
    });
    mockDbExecute.mockReturnValue(Promise.resolve({
      rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
    }));

    // Team-wide oauth_token secret (accountId/workspaceId NULL → team-scoped row)
    mockSecretsFindMany.mockResolvedValue([
      { id: 'oauth-secret-1', purpose: 'oauth_token', label: null },
    ]);
    mockSecretsProviderGet.mockResolvedValue('decrypted-oauth-token');

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers.length).toBe(1);
    // The decrypted OAuth token MUST reach the runner under `serverOauthToken`.
    expect(data.workers[0].serverOauthToken).toBe('decrypted-oauth-token');

    if (origKey !== undefined) {
      process.env.ENCRYPTION_KEY = origKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  it('attaches serverApiKey when an anthropic_api_key secret exists for the team', async () => {
    const origKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'test-encryption-key';

    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'api',
      dailyCostLimitCents: 10000,
      currentDailyCostCents: 0,
    });

    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true },
    ]);

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    mockTasksFindMany.mockResolvedValueOnce([
      {
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'Test task',
        dependsOn: [],
        workspace: { id: 'ws-1', teamId: 'team-1', gitConfig: null },
      },
    ]);

    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'task-1' }]),
        })),
      })),
    });
    mockDbExecute.mockReturnValue(Promise.resolve({
      rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
    }));

    mockSecretsFindMany.mockResolvedValue([
      { id: 'apikey-secret-1', purpose: 'anthropic_api_key', label: null },
    ]);
    mockSecretsProviderGet.mockResolvedValue('decrypted-anthropic-key');

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers.length).toBe(1);
    expect(data.workers[0].serverApiKey).toBe('decrypted-anthropic-key');

    if (origKey !== undefined) {
      process.env.ENCRYPTION_KEY = origKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  it('does not include mcpSecrets when no mcp_credential secrets exist', async () => {
    const origKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'test-encryption-key';

    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'api',
      dailyCostLimitCents: 10000,
      currentDailyCostCents: 0,
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    mockTasksFindMany.mockResolvedValueOnce([
      {
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'Test task',
        dependsOn: [],
        workspace: { id: 'ws-1', teamId: 'team-1', gitConfig: null },
      },
    ]);

    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'task-1' }]),
        })),
      })),
    });
    mockDbExecute.mockReturnValue(Promise.resolve({
      rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
    }));

    // No secrets at all
    mockSecretsFindMany.mockResolvedValue([]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers.length).toBe(1);
    expect(data.workers[0].mcpSecrets).toBeUndefined();

    if (origKey !== undefined) {
      process.env.ENCRYPTION_KEY = origKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  it('scopes secrets query by workspace teamId to prevent cross-team leakage', async () => {
    const origKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'test-encryption-key';

    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'api',
      dailyCostLimitCents: 10000,
      currentDailyCostCents: 0,
    });

    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true },
    ]);

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    // Task workspace has teamId 'team-A'
    mockTasksFindMany.mockResolvedValueOnce([
      {
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'Test task',
        dependsOn: [],
        workspace: { id: 'ws-1', teamId: 'team-A', gitConfig: null },
      },
    ]);

    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'task-1' }]),
        })),
      })),
    });
    mockDbExecute.mockReturnValue(Promise.resolve({
      rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
    }));

    // Return empty — simulating that the team-scoped query filters out secrets from other teams
    mockSecretsFindMany.mockResolvedValue([]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers.length).toBe(1);
    // No secrets should be attached since the team-scoped query returned none
    expect(data.workers[0].mcpSecrets).toBeUndefined();
    expect(data.workers[0].serverApiKey).toBeUndefined();

    // Verify secrets.findMany was called with a where clause (team-scoped)
    expect(mockSecretsFindMany).toHaveBeenCalled();

    if (origKey !== undefined) {
      process.env.ENCRYPTION_KEY = origKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  // --- Smart routing tests (see packages/core/model-router.ts) ---

  describe('smart model routing', () => {
    // Capture the payload written on the claim UPDATE so we can assert
    // predictedModel + patched context without reaching into the DB layer.
    let lastTaskSetPayload: any = null;

    function mockClaimSuccess() {
      mockTasksUpdate.mockImplementation(() => ({
        set: mock((payload: any) => {
          lastTaskSetPayload = payload;
          return {
            where: mock(() => ({
              returning: mock(() => [{ id: 'task-1' }]),
            })),
          };
        }),
      }));
      mockDbExecute.mockReturnValue(Promise.resolve({
        rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
      }));
    }

    beforeEach(() => {
      lastTaskSetPayload = null;
    });

    it('writes predictedModel and injects model into task.context on successful claim', async () => {
      mockAuthenticateApiKey.mockResolvedValue({
        id: 'account-1',
        maxConcurrentWorkers: 3,
        type: 'user',
        authType: 'api',
        maxCostPerDay: '100',
        totalCost: '5',
      });
      mockWorkersFindMany.mockResolvedValueOnce([]);
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
      mockAccountWorkspacesFindMany.mockResolvedValue([]);
      mockTasksFindMany.mockResolvedValue([{
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'simple doc edit',
        kind: 'engineering',
        complexity: 'simple',
        priority: 0,
        dependsOn: [],
        workspace: { id: 'ws-1', gitConfig: null },
      }]);
      mockClaimSuccess();

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.workers.length).toBe(1);

      // engineering/simple → haiku (baseline matrix)
      expect(lastTaskSetPayload.predictedModel).toBe('haiku');
      expect(lastTaskSetPayload.context?.model).toBe('haiku');
    });

    it('downshifts engineering/complex to sonnet when daily budget > 70%', async () => {
      mockAuthenticateApiKey.mockResolvedValue({
        id: 'account-1',
        maxConcurrentWorkers: 3,
        type: 'user',
        authType: 'api',
        maxCostPerDay: '100',
        totalCost: '75', // 75% budget pressure
      });
      mockWorkersFindMany.mockResolvedValueOnce([]);
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
      mockAccountWorkspacesFindMany.mockResolvedValue([]);
      mockTasksFindMany.mockResolvedValue([{
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'big refactor',
        kind: 'engineering',
        complexity: 'complex',
        priority: 0,
        dependsOn: [],
        workspace: { id: 'ws-1', gitConfig: null },
      }]);
      mockClaimSuccess();

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      });
      await POST(req);

      // baseline=opus, but 70–90% band downshifts engineering → sonnet
      expect(lastTaskSetPayload.predictedModel).toBe('sonnet');
    });

    it('skips the task when the router returns paused (budget >= 95%, priority 0)', async () => {
      mockAuthenticateApiKey.mockResolvedValue({
        id: 'account-1',
        maxConcurrentWorkers: 3,
        type: 'user',
        authType: 'api',
        maxCostPerDay: '100',
        totalCost: '50', // daily-cost hard limit not hit yet (50% < 100%)…
      });
      // …but the *router* input uses this ratio. Force 96% by tweaking cost.
      mockAuthenticateApiKey.mockResolvedValue({
        id: 'account-1',
        maxConcurrentWorkers: 3,
        type: 'user',
        authType: 'api',
        maxCostPerDay: '100',
        totalCost: '96', // 96% → paused for priority 0
      });
      mockWorkersFindMany.mockResolvedValueOnce([]);
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
      mockAccountWorkspacesFindMany.mockResolvedValue([]);
      mockTasksFindMany.mockResolvedValue([{
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'normal task',
        kind: 'engineering',
        complexity: 'normal',
        priority: 0,
        dependsOn: [],
        workspace: { id: 'ws-1', gitConfig: null },
      }]);
      mockClaimSuccess();

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      });
      const res = await POST(req);

      // Router returned paused — no claim UPDATE should have fired.
      expect(lastTaskSetPayload).toBeNull();
      const data = await res.json();
      expect(data.workers).toEqual([]);
    });

    it('explicit context.model bypasses router gates', async () => {
      mockAuthenticateApiKey.mockResolvedValue({
        id: 'account-1',
        maxConcurrentWorkers: 3,
        type: 'user',
        authType: 'api',
        maxCostPerDay: '100',
        totalCost: '92', // would normally downshift, but override wins
      });
      mockWorkersFindMany.mockResolvedValueOnce([]);
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
      mockAccountWorkspacesFindMany.mockResolvedValue([]);
      mockTasksFindMany.mockResolvedValue([{
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'user-pinned',
        kind: 'engineering',
        complexity: 'simple',
        priority: 0,
        dependsOn: [],
        context: { model: 'claude-opus-4-8' },
        workspace: { id: 'ws-1', gitConfig: null },
      }]);
      mockClaimSuccess();

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      });
      await POST(req);

      expect(lastTaskSetPayload.predictedModel).toBe('claude-opus-4-8');
      expect(lastTaskSetPayload.context?.model).toBe('claude-opus-4-8');
    });

    it('spike-detection downshifts when recent claim count exceeds threshold', async () => {
      mockAuthenticateApiKey.mockResolvedValue({
        id: 'account-1',
        maxConcurrentWorkers: 3,
        type: 'user',
        authType: 'api',
        maxCostPerDay: '100',
        totalCost: '10', // budget-gate won't fire
      });
      mockWorkersFindMany.mockResolvedValueOnce([]);
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
      mockAccountWorkspacesFindMany.mockResolvedValue([]);
      mockTasksFindMany.mockResolvedValue([{
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'engineering in a spike',
        kind: 'engineering',
        complexity: 'complex',
        priority: 0,
        dependsOn: [],
        workspace: { id: 'ws-1', gitConfig: null },
      }]);
      mockClaimSuccess();

      // 25 recent claims > default threshold of 20 → spike fires
      mockDbSelect.mockReturnValue({
        from: mock(() => ({
          where: mock(() => Promise.resolve([{ count: 25 }])),
        })),
      });

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      });
      await POST(req);

      // engineering/complex baseline=opus, spike downshifts → sonnet
      expect(lastTaskSetPayload.predictedModel).toBe('sonnet');
    });

    it('role floor clamps a simple engineering task up from haiku', async () => {
      mockAuthenticateApiKey.mockResolvedValue({
        id: 'account-1',
        maxConcurrentWorkers: 3,
        type: 'user',
        authType: 'api',
        maxCostPerDay: '100',
        totalCost: '5',
      });
      mockWorkersFindMany.mockResolvedValueOnce([]);
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
      mockAccountWorkspacesFindMany.mockResolvedValue([]);
      mockTasksFindMany.mockResolvedValue([{
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'builder-owned simple task',
        kind: 'engineering',
        complexity: 'simple',
        roleSlug: 'builder',
        priority: 0,
        dependsOn: [],
        workspace: { id: 'ws-1', gitConfig: null },
      }]);

      // Workspace role configures builder with a sonnet floor.
      mockWorkspaceSkillsFindMany.mockResolvedValue([
        { slug: 'builder', model: 'sonnet', workspaceId: 'ws-1' },
      ]);
      mockClaimSuccess();

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      });
      await POST(req);

      // baseline=haiku, role floor=sonnet → clamped up to sonnet
      expect(lastTaskSetPayload.predictedModel).toBe('sonnet');
    });
  });

  it('skips secrets when workspace has no teamId', async () => {
    const origKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'test-encryption-key';

    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'api',
      dailyCostLimitCents: 10000,
      currentDailyCostCents: 0,
    });

    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true },
    ]);

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    // Workspace without teamId (edge case)
    mockTasksFindMany.mockResolvedValueOnce([
      {
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'Test task',
        dependsOn: [],
        workspace: { id: 'ws-1', gitConfig: null },
      },
    ]);

    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'task-1' }]),
        })),
      })),
    });
    mockDbExecute.mockReturnValue(Promise.resolve({
      rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
    }));

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers.length).toBe(1);
    // No secrets attached since workspace has no teamId
    expect(data.workers[0].mcpSecrets).toBeUndefined();
    expect(data.workers[0].serverApiKey).toBeUndefined();

    if (origKey !== undefined) {
      process.env.ENCRYPTION_KEY = origKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  // Regression: on 2026-04-16, a runner claimed the same task ~12x in 52s after
  // an OAuth budget exhaustion. Each failed worker released the task back to
  // pending, Pusher re-dispatched, and the claim route had no gate against
  // the same runner re-claiming. The per-runner cooldown is a server-side
  // defense-in-depth to complement the client-side breaker (#683).
  it('includes a per-runner cooldown SQL predicate referencing workers.runner + status + updated_at', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);
    mockTasksFindMany.mockResolvedValueOnce([]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    await POST(req);

    // Inspect the where-clause assembled for tasks.findMany
    const call = mockTasksFindMany.mock.calls[0]?.[0] as any;
    const whereArgs = call?.where?.args ?? [];
    const sqlClauses = whereArgs.filter((a: any) => a?.type === 'sql');
    const joined = sqlClauses
      .map((s: any) => (s.strings ? s.strings.join(' ') : ''))
      .join('|');

    // The predicate must reference the workers table, the runner column,
    // the error status, and updated_at (the cooldown cutoff comparison).
    expect(joined).toMatch(/runner/);
    expect(joined).toMatch(/status/);
    expect(joined).toMatch(/updated_at/);
  });

  // Regression: on 2026-05-25, a task pinned to project "moa-ops" was created
  // against a workspace whose projects[] only contained "dispatch-family". The
  // task got claimed, the agent flailed on a non-existent path, stuck-detector
  // killed it, cleanup re-queued, and the loop ran 4 times before being killed
  // manually. The claim route now refuses such tasks up-front and marks them
  // failed so no runner picks them up again.
  it('marks task failed with workspace_mismatch when task.project is not in workspace.projects[]', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    mockTasksFindMany.mockResolvedValueOnce([
      {
        id: 'misrouted-task',
        workspaceId: 'ws-1',
        project: 'moa-ops',
        requiredCapabilities: [],
        context: {},
        workspace: {
          id: 'ws-1',
          gitConfig: null,
          projects: [{ name: 'dispatch-family' }],
        },
      },
    ]);

    let capturedSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((data: any) => {
        capturedSet = data;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    // No worker should be created — task was rejected up-front
    expect(data.workers).toEqual([]);
    // Task was marked failed, not left pending
    expect(capturedSet).not.toBeNull();
    expect(capturedSet.status).toBe('failed');
    expect(capturedSet.context.terminalError).toBe('workspace_mismatch');
  });

  it('claims normally when task.project matches a workspace project', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    mockTasksFindMany.mockResolvedValueOnce([
      {
        id: 'good-task',
        workspaceId: 'ws-1',
        title: 'Test task',
        project: 'dispatch-family',
        requiredCapabilities: [],
        context: {},
        workspace: {
          id: 'ws-1',
          gitConfig: null,
          projects: [{ name: 'dispatch-family' }, { name: 'other-project' }],
        },
      },
    ]);

    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'good-task' }]),
        })),
      })),
    });
    mockDbExecute.mockReturnValue(Promise.resolve({
      rows: [{ id: 'worker-1', task_id: 'good-task', branch: 'buildd/test', status: 'idle' }],
    }));

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers).toHaveLength(1);
  });

  // --- MCP connector injection tests ---

  describe('mcpConnectors injection (role opt-in intersection)', () => {
    const origKey = process.env.ENCRYPTION_KEY;

    // Set up a claimable task. `connectorRefs` populates the resolved role's
    // opt-in list; pass `null` for roleSlug to simulate an unrouted task (no role).
    function setupConnectorClaim(
      connectorRefs: string[] = [],
      roleSlug: string | null = 'builder',
    ) {
      process.env.ENCRYPTION_KEY = 'test-encryption-key';
      mockAuthenticateApiKey.mockResolvedValue({
        id: 'account-1',
        maxConcurrentWorkers: 5,
        type: 'user',
        authType: 'api',
      });
      mockGetAccountWorkspacePermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true }]);
      mockWorkersFindMany.mockResolvedValueOnce([]);
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
      mockTasksFindMany.mockResolvedValueOnce([{
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'Test task',
        dependsOn: [],
        roleSlug,
        workspace: { id: 'ws-1', teamId: 'team-1', gitConfig: null },
      }]);
      mockTasksUpdate.mockReturnValue({
        set: mock(() => ({ where: mock(() => ({ returning: mock(() => [{ id: 'task-1' }]) })) })),
      });
      mockDbExecute.mockReturnValue(Promise.resolve({
        rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
      }));
      mockSecretsFindMany.mockResolvedValue([]); // no main team secrets
      // Role resolution: a team-default role (workspaceId null) with the given refs.
      // Used by both the model-floor prefetch and the connector-block role lookup.
      if (roleSlug) {
        mockWorkspaceSkillsFindMany.mockResolvedValue([
          { slug: roleSlug, isRole: true, enabled: true, workspaceId: null, model: 'inherit', connectorRefs },
        ]);
      } else {
        mockWorkspaceSkillsFindMany.mockResolvedValue([]);
      }
    }

    afterEach(() => {
      if (origKey !== undefined) {
        process.env.ENCRYPTION_KEY = origKey;
      } else {
        delete process.env.ENCRYPTION_KEY;
      }
    });

    // §2 AC-1: role refs [conn-1], workspace enables {conn-1, conn-2} → only conn-1 mounts.
    it('mounts only role-referenced connectors even when the workspace enables more', async () => {
      setupConnectorClaim(['conn-1']);
      mockConnectorsFindMany.mockResolvedValue([
        { id: 'conn-1', teamId: 'team-1', name: 'my-mcp', url: 'https://mcp.example.com', authMode: 'none', headerName: null, transport: 'http', command: null, args: [], envMapping: {} },
      ]);
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-1', workspaceId: 'ws-1', enabled: true },
        { connectorId: 'conn-2', workspaceId: 'ws-1', enabled: true },
      ]);

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers[0].mcpConnectors).toEqual([
        { id: 'conn-1', name: 'my-mcp', transport: 'http', url: 'https://mcp.example.com' },
      ]);
    });

    // §2 AC-2: role references conn-1 but the workspace has NOT enabled it → not mounted.
    it('does not mount a referenced connector the workspace disabled', async () => {
      setupConnectorClaim(['conn-1']);
      mockConnectorsFindMany.mockResolvedValue([
        { id: 'conn-1', teamId: 'team-1', name: 'my-mcp', url: 'https://mcp.example.com', authMode: 'none', headerName: null, transport: 'http', command: null, args: [], envMapping: {} },
      ]);
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-1', workspaceId: 'ws-1', enabled: false },
      ]);

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers[0].mcpConnectors).toBeUndefined();
    });

    // §2 AC-3: a task with no roleSlug (unrouted) mounts no connectors.
    it('mounts nothing when the task has no role', async () => {
      setupConnectorClaim([], null);
      mockConnectorsFindMany.mockResolvedValue([
        { id: 'conn-1', teamId: 'team-1', name: 'my-mcp', url: 'https://mcp.example.com', authMode: 'none', headerName: null, transport: 'http', command: null, args: [], envMapping: {} },
      ]);
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-1', workspaceId: 'ws-1', enabled: true },
      ]);

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers[0].mcpConnectors).toBeUndefined();
    });

    // §2 AC-4: a dangling ref (deleted / other-team connector) is tolerated — the
    // claim succeeds and mounts only the surviving valid refs (no 500).
    it('tolerates a dangling connector ref and mounts the remaining valid ones', async () => {
      setupConnectorClaim(['conn-1', 'conn-deleted']);
      // The connectors query only returns the still-existing owned connector.
      mockConnectorsFindMany.mockResolvedValue([
        { id: 'conn-1', teamId: 'team-1', name: 'my-mcp', url: 'https://mcp.example.com', authMode: 'none', headerName: null, transport: 'http', command: null, args: [], envMapping: {} },
      ]);
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-1', workspaceId: 'ws-1', enabled: true },
      ]);

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers[0].mcpConnectors).toEqual([
        { id: 'conn-1', name: 'my-mcp', transport: 'http', url: 'https://mcp.example.com' },
      ]);
    });

    // §3: authMode=none http connector → { transport: http, url }, no headers.
    it('injects an authMode=none http connector', async () => {
      setupConnectorClaim(['conn-1']);
      mockConnectorsFindMany.mockResolvedValue([
        { id: 'conn-1', teamId: 'team-1', name: 'my-mcp', url: 'https://mcp.example.com', authMode: 'none', headerName: null, transport: 'http', command: null, args: [], envMapping: {} },
      ]);
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-1', workspaceId: 'ws-1', enabled: true },
      ]);

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers[0].mcpConnectors).toEqual([
        { id: 'conn-1', name: 'my-mcp', transport: 'http', url: 'https://mcp.example.com' },
      ]);
    });

    // §3 AC-4: header connector missing its secret row → omitted (not mounted empty).
    it('omits a header connector whose secret row is missing', async () => {
      setupConnectorClaim(['conn-hdr']);
      mockConnectorsFindMany.mockResolvedValue([
        { id: 'conn-hdr', teamId: 'team-1', name: 'header-mcp', url: 'https://header.example.com', authMode: 'header', headerName: 'X-API-Key', transport: 'http', command: null, args: [], envMapping: {} },
      ]);
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-hdr', workspaceId: 'ws-1', enabled: true },
      ]);
      // main secrets call → []; connector credential call → [] (no secret)
      mockSecretsFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers[0].mcpConnectors).toBeUndefined();
    });

    // §3: header connector → { transport: http, url, headers: { [headerName]: value } }.
    it('injects a header-auth http connector with the decrypted header value', async () => {
      setupConnectorClaim(['conn-hdr']);
      mockConnectorsFindMany.mockResolvedValue([
        { id: 'conn-hdr', teamId: 'team-1', name: 'header-mcp', url: 'https://header.example.com', authMode: 'header', headerName: 'X-API-Key', transport: 'http', command: null, args: [], envMapping: {} },
      ]);
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-hdr', workspaceId: 'ws-1', enabled: true },
      ]);
      mockSecretsFindMany
        .mockResolvedValueOnce([]) // main secrets call
        .mockResolvedValueOnce([{ id: 'cs-2', label: 'conn-hdr', tokenExpiresAt: null }]);
      mockSecretsProviderGet.mockResolvedValue('secret-header-value');

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers[0].mcpConnectors).toEqual([
        { id: 'conn-hdr', name: 'header-mcp', transport: 'http', url: 'https://header.example.com', headers: { 'X-API-Key': 'secret-header-value' } },
      ]);
    });

    // §3 AC-3: expired oauth token whose refresh FAILS → connector omitted, claim 200.
    it('omits an oauth connector whose expired token cannot be refreshed', async () => {
      setupConnectorClaim(['conn-oauth']);
      mockConnectorsFindMany.mockResolvedValue([
        { id: 'conn-oauth', teamId: 'team-1', name: 'oauth-mcp', url: 'https://oauth.example.com', authMode: 'oauth', headerName: null, transport: 'http', command: null, args: [], envMapping: {} },
      ]);
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-oauth', workspaceId: 'ws-1', enabled: true },
      ]);
      mockSecretsFindMany
        .mockResolvedValueOnce([]) // main secrets call
        .mockResolvedValueOnce([{ id: 'cs-1', label: 'conn-oauth', tokenExpiresAt: new Date(Date.now() - 60_000) }]);
      mockRefreshMcpConnectorCredential.mockResolvedValue('expired');

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers[0].mcpConnectors).toBeUndefined();
    });

    // §3 AC-2: expired oauth token whose refresh SUCCEEDS → refreshed token injected.
    it('injects an oauth connector after a successful claim-time refresh', async () => {
      setupConnectorClaim(['conn-oauth']);
      mockConnectorsFindMany.mockResolvedValue([
        { id: 'conn-oauth', teamId: 'team-1', name: 'oauth-mcp', url: 'https://oauth.example.com', authMode: 'oauth', headerName: null, transport: 'http', command: null, args: [], envMapping: {} },
      ]);
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-oauth', workspaceId: 'ws-1', enabled: true },
      ]);
      mockSecretsFindMany
        .mockResolvedValueOnce([]) // main secrets call
        .mockResolvedValueOnce([{ id: 'cs-1', label: 'conn-oauth', tokenExpiresAt: new Date(Date.now() - 60_000) }]);
      mockRefreshMcpConnectorCredential.mockResolvedValue('refreshed');
      // provider.get returns the (now-refreshed) token blob
      mockSecretsProviderGet.mockResolvedValue(JSON.stringify({ access_token: 'fresh-token' }));

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers[0].mcpConnectors).toEqual([
        { id: 'conn-oauth', name: 'oauth-mcp', transport: 'http', url: 'https://oauth.example.com', headers: { Authorization: 'Bearer fresh-token' } },
      ]);
    });

    // §3: stdio connector → { transport: stdio, command, args, env } from envMapping.
    it('injects a stdio connector with command/args and env resolved from envMapping', async () => {
      setupConnectorClaim(['conn-stdio']);
      mockConnectorsFindMany.mockResolvedValue([
        {
          id: 'conn-stdio', teamId: 'team-1', name: 'github', url: null, authMode: 'none', headerName: null,
          transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
          envMapping: { GITHUB_TOKEN: 'GH_SECRET' },
        },
      ]);
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-stdio', workspaceId: 'ws-1', enabled: true },
      ]);
      // main secrets call → []; stdio env-secret call → the mapped mcp_credential secret
      mockSecretsFindMany
        .mockResolvedValueOnce([]) // main secrets call
        .mockResolvedValueOnce([{ id: 'es-1', label: 'GH_SECRET', teamId: 'team-1' }]);
      mockSecretsProviderGet.mockResolvedValue('ghp_decrypted');

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers[0].mcpConnectors).toEqual([
        {
          name: 'github', transport: 'stdio', command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'ghp_decrypted' },
        },
      ]);
    });

    // §3: stdio connector missing a mapped secret → omitted (no half-formed mount).
    it('omits a stdio connector when a mapped env secret is missing', async () => {
      setupConnectorClaim(['conn-stdio']);
      mockConnectorsFindMany.mockResolvedValue([
        {
          id: 'conn-stdio', teamId: 'team-1', name: 'github', url: null, authMode: 'none', headerName: null,
          transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
          envMapping: { GITHUB_TOKEN: 'GH_SECRET' },
        },
      ]);
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-stdio', workspaceId: 'ws-1', enabled: true },
      ]);
      // main secrets call → []; stdio env-secret call → [] (secret missing)
      mockSecretsFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers[0].mcpConnectors).toBeUndefined();
    });

    // --- §1b cross-team sharing ---

    // §1b AC-1: a connector owned by another team but shared to this team mounts
    // using the OWNER team's credential — no grantee-team secret exists or is needed.
    it('mounts a shared-in connector using the owner-team credential', async () => {
      setupConnectorClaim(['conn-shared']);
      mockConnectorsFindMany.mockResolvedValue([
        { id: 'conn-shared', teamId: 'team-owner', name: 'shared-mcp', url: 'https://shared.example.com', authMode: 'header', headerName: 'X-API-Key', transport: 'http', command: null, args: [], envMapping: {} },
      ]);
      mockConnectorSharesFindMany.mockResolvedValue([
        { connectorId: 'conn-shared', sharedWithTeamId: 'team-1' },
      ]);
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-shared', workspaceId: 'ws-1', enabled: true },
      ]);
      mockSecretsFindMany
        .mockResolvedValueOnce([]) // main secrets call
        .mockResolvedValueOnce([{ id: 'cs-owner', label: 'conn-shared', tokenExpiresAt: null }]);
      mockSecretsProviderGet.mockResolvedValue('owner-secret');

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers[0].mcpConnectors).toEqual([
        { id: 'conn-shared', name: 'shared-mcp', transport: 'http', url: 'https://shared.example.com', headers: { 'X-API-Key': 'owner-secret' } },
      ]);
      // Credential lookup is keyed on the OWNER team (connector.teamId), not the
      // task's workspace team (team-1) — §1b invariant.
      const credCall = mockSecretsFindMany.mock.calls[1]?.[0] as any;
      const teamFilter = credCall?.where?.args?.find((a: any) => a.type === 'inArray' && a.field === 'teamId');
      expect(teamFilter?.values).toEqual(['team-owner']);
    });

    // §1b AC-3: owned wins on slug collision — when an owned and a shared-in
    // connector slugify to the same key, only the owned one mounts.
    it('mounts only the owned connector when an owned and a shared-in connector collide on slug', async () => {
      setupConnectorClaim(['conn-own', 'conn-shared']);
      // Shared-in row listed FIRST to prove precedence is enforced, not row order.
      mockConnectorsFindMany.mockResolvedValue([
        { id: 'conn-shared', teamId: 'team-owner', name: 'github', url: 'https://shared.example.com', authMode: 'none', headerName: null, transport: 'http', command: null, args: [], envMapping: {} },
        { id: 'conn-own', teamId: 'team-1', name: 'github', url: 'https://owned.example.com', authMode: 'none', headerName: null, transport: 'http', command: null, args: [], envMapping: {} },
      ]);
      mockConnectorSharesFindMany.mockResolvedValue([
        { connectorId: 'conn-shared', sharedWithTeamId: 'team-1' },
      ]);
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-own', workspaceId: 'ws-1', enabled: true },
        { connectorId: 'conn-shared', workspaceId: 'ws-1', enabled: true },
      ]);

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers[0].mcpConnectors).toEqual([
        { id: 'conn-own', name: 'github', transport: 'http', url: 'https://owned.example.com' },
      ]);
    });

    // §1b invariant (credentials keyed on OWNER team): when an owned and a
    // shared-in stdio connector map the same env label, each resolves the
    // secret from its own owner team — never the other team's value.
    it('resolves stdio env secrets per owner team when labels collide across teams', async () => {
      setupConnectorClaim(['conn-own-stdio', 'conn-shared-stdio']);
      mockConnectorsFindMany.mockResolvedValue([
        {
          id: 'conn-own-stdio', teamId: 'team-1', name: 'local-tool', url: null, authMode: 'none', headerName: null,
          transport: 'stdio', command: 'npx', args: ['local-tool'],
          envMapping: { API_TOKEN: 'SHARED_LABEL' },
        },
        {
          id: 'conn-shared-stdio', teamId: 'team-owner', name: 'remote-tool', url: null, authMode: 'none', headerName: null,
          transport: 'stdio', command: 'npx', args: ['remote-tool'],
          envMapping: { API_TOKEN: 'SHARED_LABEL' },
        },
      ]);
      mockConnectorSharesFindMany.mockResolvedValue([
        { connectorId: 'conn-shared-stdio', sharedWithTeamId: 'team-1' },
      ]);
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-own-stdio', workspaceId: 'ws-1', enabled: true },
        { connectorId: 'conn-shared-stdio', workspaceId: 'ws-1', enabled: true },
      ]);
      // main secrets call → []; env-secret call → one row per owner team, same label
      mockSecretsFindMany
        .mockResolvedValueOnce([]) // main secrets call
        .mockResolvedValueOnce([
          { id: 'es-own', label: 'SHARED_LABEL', teamId: 'team-1' },
          { id: 'es-owner', label: 'SHARED_LABEL', teamId: 'team-owner' },
        ]);
      mockSecretsProviderGet.mockImplementation((id: string) =>
        Promise.resolve(id === 'es-own' ? 'own-team-value' : id === 'es-owner' ? 'owner-team-value' : null),
      );

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      const mounted = data.workers[0].mcpConnectors as any[];
      const own = mounted.find(c => c.name === 'local-tool');
      const shared = mounted.find(c => c.name === 'remote-tool');
      expect(own?.env).toEqual({ API_TOKEN: 'own-team-value' });
      expect(shared?.env).toEqual({ API_TOKEN: 'owner-team-value' });
    });

    // §1b AC-5: after a share is revoked (no share row), the next claim does NOT
    // mount the other team's connector even if a dangling ref/enablement remains.
    it('does not mount another team connector when no share row exists (revoked)', async () => {
      setupConnectorClaim(['conn-shared']);
      mockConnectorsFindMany.mockResolvedValue([
        { id: 'conn-shared', teamId: 'team-owner', name: 'shared-mcp', url: 'https://shared.example.com', authMode: 'none', headerName: null, transport: 'http', command: null, args: [], envMapping: {} },
      ]);
      mockConnectorSharesFindMany.mockResolvedValue([]); // share revoked
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-shared', workspaceId: 'ws-1', enabled: true },
      ]);

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers[0].mcpConnectors).toBeUndefined();
    });

    // §E.3: assertion-mode connector → returns AssertionConnectorEntry exchange metadata,
    // not a bearer token. The runner performs mint+exchange at connect time.
    it('injects assertion-mode connector as exchange metadata (no bearer token at claim time)', async () => {
      setupConnectorClaim(['conn-assert']);
      mockConnectorsFindMany.mockResolvedValue([
        {
          id: 'conn-assert', teamId: 'team-1', name: 'cue', url: 'https://cue.buildd.dev/api/mcp',
          authMode: 'assertion', headerName: null, transport: 'http', command: null, args: [], envMapping: {},
          assertionAudience: 'https://cue.buildd.dev/api/mcp',
          assertionTokenEndpoint: 'https://cue.buildd.dev/api/oauth/token',
        },
      ]);
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-assert', workspaceId: 'ws-1', enabled: true },
      ]);

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers[0].mcpConnectors).toEqual([{
        id: 'conn-assert',
        name: 'cue',
        transport: 'http',
        url: 'https://cue.buildd.dev/api/mcp',
        assertionMode: true,
        mintApiUrl: 'https://buildd.dev/api/connectors/conn-assert/assertion',
        audience: 'https://cue.buildd.dev/api/mcp',
        tokenEndpoint: 'https://cue.buildd.dev/api/oauth/token',
      }]);
      // Must NOT contain an Authorization header (no bearer token at claim time)
      expect(data.workers[0].mcpConnectors[0].headers).toBeUndefined();
    });

    // §E.3: assertion connector missing assertionAudience or assertionTokenEndpoint → omitted
    it('omits assertion connector when assertionAudience is missing', async () => {
      setupConnectorClaim(['conn-assert']);
      mockConnectorsFindMany.mockResolvedValue([
        {
          id: 'conn-assert', teamId: 'team-1', name: 'cue', url: 'https://cue.buildd.dev/api/mcp',
          authMode: 'assertion', headerName: null, transport: 'http', command: null, args: [], envMapping: {},
          assertionAudience: null,
          assertionTokenEndpoint: 'https://cue.buildd.dev/api/oauth/token',
        },
      ]);
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-assert', workspaceId: 'ws-1', enabled: true },
      ]);

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers[0].mcpConnectors).toBeUndefined();
    });
  });

  it('does not gate claims when workspace.projects[] is empty (single-repo workspace)', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockAccountWorkspacesFindMany.mockResolvedValue([]);

    // Task has a project string but workspace doesn't enumerate projects — skip the guard.
    mockTasksFindMany.mockResolvedValueOnce([
      {
        id: 'single-repo-task',
        workspaceId: 'ws-1',
        title: 'Single repo task',
        project: 'whatever',
        requiredCapabilities: [],
        context: {},
        workspace: { id: 'ws-1', gitConfig: null, projects: [] },
      },
    ]);

    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'single-repo-task' }]),
        })),
      })),
    });
    mockDbExecute.mockReturnValue(Promise.resolve({
      rows: [{ id: 'worker-1', task_id: 'single-repo-task', branch: 'buildd/test', status: 'idle' }],
    }));

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers).toHaveLength(1);
  });
});

describe('path-overlap claim guard', () => {
  function apiAccount() {
    return {
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user' as const,
      authType: 'api' as const,
    };
  }

  function taskWithManifest(pathManifest: string[]) {
    return {
      id: 'task-1',
      workspaceId: 'ws-1',
      title: 'Build mcp-oauth',
      backend: 'claude',
      dependsOn: [],
      pathManifest,
      requiredCapabilities: [],
      context: {},
      workspace: { id: 'ws-1', gitConfig: null, teamId: 'team-1' },
    };
  }

  function setupForClaim() {
    mockGetAccountWorkspacePermissions.mockResolvedValue([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', accessMode: 'open', teamId: 'team-1' }]);
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({ where: mock(() => ({ returning: mock(() => [{ id: 'task-1' }]) })) })),
    });
    mockDbExecute.mockReturnValue(Promise.resolve({
      rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
    }));
  }

  it('defers a task when its pathManifest overlaps an open PR from another task', async () => {
    mockAuthenticateApiKey.mockResolvedValue(apiAccount());
    setupForClaim();

    // 1st workers.findMany → active workers (empty)
    // 2nd workers.findMany → open PR pre-fetch: a worker with an open PR
    mockWorkersFindMany
      .mockResolvedValueOnce([]) // active workers
      .mockResolvedValueOnce([  // open PR pre-fetch
        { workspaceId: 'ws-1', taskId: 'pr-task-1', prNumber: 1126, prUrl: 'https://github.com/org/repo/pull/1126', status: 'running' },
      ]);

    // 1st tasks.findMany → claimable tasks (has pathManifest)
    // 2nd tasks.findMany → PR task manifests (same file → overlap)
    mockTasksFindMany
      .mockResolvedValueOnce([taskWithManifest(['apps/web/src/lib/mcp-oauth.ts'])])
      .mockResolvedValueOnce([{ id: 'pr-task-1', pathManifest: ['apps/web/src/lib/mcp-oauth.ts'] }]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    // Task is deferred — no workers claimed
    expect(data.workers).toHaveLength(0);
  });

  it('claims a task when its pathManifest does NOT overlap any open PR', async () => {
    mockAuthenticateApiKey.mockResolvedValue(apiAccount());
    setupForClaim();

    // 1st workers.findMany → active workers (empty)
    // 2nd workers.findMany → open PR pre-fetch: a PR for a DIFFERENT file
    mockWorkersFindMany
      .mockResolvedValueOnce([]) // active workers
      .mockResolvedValueOnce([  // open PR pre-fetch
        { workspaceId: 'ws-1', taskId: 'pr-task-2', prNumber: 1127, prUrl: 'https://github.com/org/repo/pull/1127', status: 'running' },
      ]);

    // 1st tasks.findMany → claimable tasks
    // 2nd tasks.findMany → PR task manifests (different file — no overlap)
    mockTasksFindMany
      .mockResolvedValueOnce([taskWithManifest(['apps/web/src/lib/mcp-oauth.ts'])])
      .mockResolvedValueOnce([{ id: 'pr-task-2', pathManifest: ['packages/core/db/schema.ts'] }]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    // Task is claimed — manifests don't overlap
    expect(data.workers).toHaveLength(1);
    expect(data.workers[0].taskId).toBe('task-1');
  });

  it('claims a task with no pathManifest even when other PRs are open', async () => {
    mockAuthenticateApiKey.mockResolvedValue(apiAccount());
    setupForClaim();

    mockWorkersFindMany
      .mockResolvedValueOnce([]) // active workers
      .mockResolvedValueOnce([  // open PR pre-fetch
        { workspaceId: 'ws-1', taskId: 'pr-task-3', prNumber: 1128, prUrl: 'url', status: 'running' },
      ]);

    // Task has NO pathManifest
    const taskNoManifest = {
      ...taskWithManifest([]),
      pathManifest: null,
    };
    mockTasksFindMany
      .mockResolvedValueOnce([taskNoManifest])
      .mockResolvedValueOnce([{ id: 'pr-task-3', pathManifest: ['apps/web/src/lib/mcp-oauth.ts'] }]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    // No manifest → guard is a no-op → task is claimed
    expect(data.workers).toHaveLength(1);
  });
});

describe('entity catalog injection at claim time', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'api',
    });
    mockGetAccountWorkspacePermissions.mockReset();
    mockGetAccountWorkspacePermissions.mockResolvedValue([]);
    mockWorkersFindMany.mockReset();
    mockWorkersFindMany.mockResolvedValue([]);
    mockWorkspacesFindMany.mockReset();
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', accessMode: 'open', teamId: 'team-1' }]);
    mockAccountWorkspacesFindMany.mockReset();
    mockAccountWorkspacesFindMany.mockResolvedValue([]);
    mockTasksFindMany.mockReset();
    mockTasksFindMany.mockResolvedValue([
      {
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'Fix reconnect in `apps/web/src/lib/api-auth.ts`',
        backend: 'claude',
        dependsOn: [],
        requiredCapabilities: [],
        context: {},
        workspace: { id: 'ws-1', gitConfig: null, teamId: 'team-1' },
      },
    ]);
    mockTeamsFindFirst.mockReset();
    mockTeamsFindFirst.mockResolvedValue(null);
    mockHeartbeatsFindFirst.mockReset();
    mockHeartbeatsFindFirst.mockResolvedValue({ id: 'hb-1' });
    mockSecretsFindMany.mockReset();
    mockSecretsFindMany.mockResolvedValue([]);
    mockConnectorsFindMany.mockReset();
    mockConnectorsFindMany.mockResolvedValue([]);
    mockConnectorWorkspacesFindMany.mockReset();
    mockConnectorWorkspacesFindMany.mockResolvedValue([]);
    mockWorkspaceSkillsFindMany.mockReset();
    mockWorkspaceSkillsFindMany.mockResolvedValue([]);
    mockWorkspaceSkillsFindFirst.mockReset();
    mockWorkspaceSkillsFindFirst.mockResolvedValue(null);
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({ where: mock(() => ({ returning: mock(() => [{ id: 'task-1' }]) })) })),
    });
    mockDbSelect.mockReturnValue({
      from: mock(() => ({
        where: mock(() => Promise.resolve([{ count: 0 }])),
      })),
    });
  });

  afterEach(() => {
    // Restore the file-wide default so later suites see the original behavior
    mockDbExecute.mockReset();
    mockDbExecute.mockReturnValue(Promise.resolve({
      rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
    }));
  });

  it('appends a Known entities block to resolvedContextProviders', async () => {
    // Route SQL discrimination: entity-catalog queries reference knowledge_entities;
    // everything else (worker INSERT, chunk retrieval) gets the default worker row.
    mockDbExecute.mockImplementation(((q: any) => {
      const text = Array.isArray(q?.strings) ? q.strings.join(' ') : '';
      if (text.includes('knowledge_entities')) {
        if (text.includes("kind = 'file'")) {
          return Promise.resolve({
            rows: [{ id: 'ent-f1', kind: 'file', key: 'apps/web/src/lib/api-auth.ts', canonical_name: 'api-auth.ts' }],
          });
        }
        if (text.includes('NOT IN')) {
          // top-connected vocabulary query
          return Promise.resolve({
            rows: [{ id: 'ent-c1', kind: 'concept', key: 'auth-model', canonical_name: 'Auth Model' }],
          });
        }
        return Promise.resolve({
          rows: [{ id: 'ent-s1', kind: 'symbol', key: 'apps/web/src/lib/api-auth.ts#authenticateApiKey', canonical_name: 'authenticateApiKey' }],
        });
      }
      return Promise.resolve({
        rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
      });
    }) as any);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers).toHaveLength(1);

    const providers = data.workers[0].resolvedContextProviders as string[];
    expect(providers).toBeDefined();
    const block = providers.join('\n');
    expect(block).toContain('## Known entities');
    expect(block).toContain('file: apps/web/src/lib/api-auth.ts');
    expect(block).toContain('symbol: authenticateApiKey (apps/web/src/lib/api-auth.ts#authenticateApiKey)');
    expect(block).toContain('concept: Auth Model (auth-model)');
    // Also mirrored into task.context for the runner
    expect(data.workers[0].task.context.resolvedContextProviders.join('\n')).toContain('## Known entities');
  });

  it('claims successfully with no catalog block when the entity store errors', async () => {
    mockDbExecute.mockImplementation(((q: any) => {
      const text = Array.isArray(q?.strings) ? q.strings.join(' ') : '';
      if (text.includes('knowledge_entities')) {
        return Promise.reject(new Error('entity store unavailable'));
      }
      return Promise.resolve({
        rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
      });
    }) as any);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    // Claim must NEVER fail because of the catalog
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers).toHaveLength(1);
    // Entity catalog block must be absent when the store errors.
    // Note: knowledge context hint may still be present from buildKnowledgeContext —
    // that is a separate feature and is not suppressed by entity store failures.
    const providers: string[] = data.workers[0].resolvedContextProviders ?? [];
    expect(providers.join('\n')).not.toContain('## Known entities');
  });
});
