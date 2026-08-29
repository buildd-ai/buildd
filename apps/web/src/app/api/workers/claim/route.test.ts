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
      catch: mock(() => {}),
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
const mockMissionsFindMany = mock(() => [] as any[]);
const mockOauthEpisodesFindMany = mock(() => [] as any[]);
const mockBackendPausesFindMany = mock(() => Promise.resolve([] as any[]));
const mockAccountsFindFirst = mock(() => Promise.resolve(null as any));

function makeSelectChain(result: any[] = []) {
  const chain: any = {};
  chain.from = () => chain;
  chain.innerJoin = () => chain;
  chain.where = () => chain;
  chain.groupBy = () => Promise.resolve(result);
  chain.limit = () => Promise.resolve(result);
  chain.then = (resolve: any, reject?: any) => Promise.resolve(result).then(resolve, reject);
  chain.catch = (re: any) => Promise.resolve(result).catch(re);
  chain.finally = (cb: any) => Promise.resolve(result).finally(cb);
  return chain;
}
const mockDbSelect = mock(() => makeSelectChain([]));

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

const mockLoadOauthEpisodes = mock(() => Promise.resolve([] as any[]));
const mockMeasureOauthWindow = mock(() => Promise.resolve({
  windowStartedAt: new Date(),
  usage: { workerCount: 0, turns: 0, tokens: 0, weightedTurns: 0, weightedTokens: 0 },
}));
mock.module('@/lib/oauth-budget-window', () => ({
  loadOauthEpisodes: mockLoadOauthEpisodes,
  measureOauthWindow: mockMeasureOauthWindow,
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
      // Provider pause log (backend_pauses) — empty means every pool is open.
      backendPauses: { findMany: (...a: any[]) => mockBackendPausesFindMany(...a) },
      accounts: { findFirst: (...a: any[]) => mockAccountsFindFirst(...a) },
      workspaceSkills: {
        findMany: mockWorkspaceSkillsFindMany,
        findFirst: mockWorkspaceSkillsFindFirst,
      },
      connectors: { findMany: mockConnectorsFindMany },
      connectorWorkspaces: { findMany: mockConnectorWorkspacesFindMany },
      connectorShares: { findMany: mockConnectorSharesFindMany },
      missions: { findMany: mockMissionsFindMany },
      oauthBudgetEpisodes: { findMany: mockOauthEpisodesFindMany },
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
  tasks: { id: 'id', workspaceId: 'workspaceId', missionId: 'missionId', status: 'status', claimedBy: 'claimedBy', claimedAt: 'claimedAt', expiresAt: 'expiresAt', runnerPreference: 'runnerPreference', createdAt: 'createdAt', priority: 'priority', dependsOn: 'dependsOn', backend: 'backend', pathManifest: 'pathManifest' },
  workers: { id: 'id', accountId: 'accountId', status: 'status', updatedAt: 'updatedAt', createdAt: 'createdAt', taskId: 'taskId', prUrl: 'prUrl', mergedAt: 'mergedAt', workspaceId: 'workspaceId', turns: 'turns', inputTokens: 'inputTokens', outputTokens: 'outputTokens' },
  missions: { id: 'id', status: 'status', maxConcurrentTasks: 'maxConcurrentTasks', pacingMode: 'pacingMode', pacingMaxPerHour: 'pacingMaxPerHour', lastTaskStartedAt: 'lastTaskStartedAt', updatedAt: 'updatedAt' },
  workerHeartbeats: { accountId: 'accountId', lastHeartbeatAt: 'lastHeartbeatAt' },
  workspaces: { id: 'id', accessMode: 'accessMode' },
  workspaceSkills: { slug: 'slug', isRole: 'isRole', enabled: 'enabled', workspaceId: 'workspaceId', accountId: 'accountId', teamId: 'teamId', connectorRefs: 'connectorRefs' },
  secrets: { accountId: 'accountId', purpose: 'purpose', label: 'label', teamId: 'teamId', workspaceId: 'workspaceId' },
  tenantBudgets: { id: 'id', tenantId: 'tenantId', teamId: 'teamId', budgetResetsAt: 'budgetResetsAt' },
  backendPauses: { teamId: 'teamId', backend: 'backend', resetsAt: 'resetsAt' },
  oauthBudgetEpisodes: { accountId: 'accountId', exhaustedAt: 'exhaustedAt' },
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
    // Default: no missions
    mockMissionsFindMany.mockReset();
    mockMissionsFindMany.mockResolvedValue([]);
    // Default: no learned OAuth budget episodes (pacing inert)
    mockOauthEpisodesFindMany.mockReset();
    mockOauthEpisodesFindMany.mockResolvedValue([]);
    // Default: empty select chain (role lookups, mission concurrency counts)
    mockDbSelect.mockReturnValue(makeSelectChain([]));
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

    // Reverse direction. Codex has its own pool, so a Codex rate-limit must not
    // strand the task the way it did on 2026-08-25 — Claude is right there.
    it('routes a Codex-walled task to Claude while the Claude pool is open', async () => {
      mockBackendPausesFindMany.mockResolvedValue([
        { backend: 'codex', resetsAt: new Date(Date.now() + 60 * 60 * 1000), reason: 'budget' },
      ]);
      mockAuthenticateApiKey.mockResolvedValue({
        id: 'account-1', maxConcurrentWorkers: 5, type: 'user' as const, authType: 'oauth' as const,
        maxConcurrentSessions: 10, activeSessions: 0,
      });
      mockWorkersFindMany.mockResolvedValue([]);
      mockTasksFindMany.mockResolvedValueOnce([{ ...pendingClaudeTask(), backend: 'codex' }]);
      mockHasCodexCredential.mockResolvedValue(true);
      setupClaim();

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner', capabilities: ['backend:codex', 'CODEX_HOME'] },
      }));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.workers.length).toBe(1);
      expect(data.workers[0].task.backend).toBe('claude');
      mockBackendPausesFindMany.mockResolvedValue([]);
    });

    // The capability filter drops Codex tasks on runners without Codex, so the
    // escape has to happen before it or a walled Codex task is invisible fleet-wide.
    it('lets a Claude-only runner pick up a Codex-walled task', async () => {
      mockBackendPausesFindMany.mockResolvedValue([
        { backend: 'codex', resetsAt: new Date(Date.now() + 60 * 60 * 1000), reason: 'budget' },
      ]);
      mockAuthenticateApiKey.mockResolvedValue({
        id: 'account-1', maxConcurrentWorkers: 5, type: 'user' as const, authType: 'oauth' as const,
        maxConcurrentSessions: 10, activeSessions: 0,
      });
      mockWorkersFindMany.mockResolvedValue([]);
      mockTasksFindMany.mockResolvedValueOnce([{ ...pendingClaudeTask(), backend: 'codex' }]);
      mockHasCodexCredential.mockResolvedValue(false);   // this runner has no Codex at all
      setupClaim();

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'claude-only-runner' },   // no backend:codex capability
      }));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.workers.length).toBe(1);
      expect(data.workers[0].task.backend).toBe('claude');
      mockBackendPausesFindMany.mockResolvedValue([]);
    });

    it('leaves a Codex-walled task pending when Claude is walled too', async () => {
      mockBackendPausesFindMany.mockResolvedValue([
        { backend: 'codex', resetsAt: new Date(Date.now() + 60 * 60 * 1000), reason: 'budget' },
        { backend: 'claude', resetsAt: new Date(Date.now() + 4 * 60 * 60 * 1000), reason: 'budget' },
      ]);
      mockAuthenticateApiKey.mockResolvedValue({
        id: 'account-1', maxConcurrentWorkers: 5, type: 'user' as const, authType: 'oauth' as const,
        maxConcurrentSessions: 10, activeSessions: 0,
      });
      mockWorkersFindMany.mockResolvedValue([]);
      mockTasksFindMany.mockResolvedValueOnce([{ ...pendingClaudeTask(), backend: 'codex' }]);
      mockHasCodexCredential.mockResolvedValue(true);
      setupClaim();

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner', capabilities: ['backend:codex', 'CODEX_HOME'] },
      }));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.workers.length).toBe(0);
      // The runner must learn WHEN to come back — the earliest of the two walls,
      // not a bare race_lost (2026-07-11 stall class).
      expect(data.diagnostics.reason).toBe('budget_exhausted');
      expect(new Date(data.budgetResetsAt).getTime()).toBeLessThan(Date.now() + 2 * 60 * 60 * 1000);
      mockBackendPausesFindMany.mockResolvedValue([]);
    });

    // A Claude-walled task must not be funnelled onto a Codex pool that is also dry.
    it('does not fail over to Codex while Codex is rate-limited', async () => {
      mockBackendPausesFindMany.mockResolvedValue([
        { backend: 'codex', resetsAt: new Date(Date.now() + 60 * 60 * 1000), reason: 'budget' },
      ]);
      mockAuthenticateApiKey.mockResolvedValue(exhaustedOauthAccount());
      mockWorkersFindMany.mockResolvedValue([]);
      mockTasksFindMany.mockResolvedValueOnce([pendingClaudeTask()]);
      mockHasCodexCredential.mockResolvedValue(true);
      setupClaim();

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      }));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.workers.length).toBe(0);
      mockBackendPausesFindMany.mockResolvedValue([]);
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

  it('does not attach mcpSecrets when mcp_credential decrypt returns null', async () => {
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

    // mcp_credential exists but decrypt returns null → mcpSecrets must not be attached
    // (the code skips entries where provider.get returns null).
    mockSecretsFindMany.mockResolvedValue([
      { id: 'secret-1', purpose: 'mcp_credential', label: 'DISPATCH_API_KEY' },
    ]);
    // mockSecretsProviderGet default is null (set in beforeEach) — no explicit mock needed.

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

  // Regression: mcp_credential secrets (e.g. Cue DISPATCH_API_KEY) must be delivered
  // as a flat mcpSecrets map so the runner can inject them as env vars for .mcp.json
  // ${VAR} expansion. Without this, Codex workers (which can't use arbitrary-header
  // connectors) have no channel to receive multi-header MCP creds.
  it('delivers decrypted mcp_credential secrets as mcpSecrets when decrypt succeeds', async () => {
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
      { id: 'secret-dispatch', purpose: 'mcp_credential', label: 'DISPATCH_API_KEY' },
      { id: 'secret-tenant', purpose: 'mcp_credential', label: 'TENANT_ID' },
    ]);
    // Decrypt returns the plaintext value for each secret id.
    mockSecretsProviderGet.mockImplementation((id: string) => {
      if (id === 'secret-dispatch') return Promise.resolve('actual-api-key');
      if (id === 'secret-tenant') return Promise.resolve('actual-tenant-id');
      return Promise.resolve(null);
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers.length).toBe(1);
    // Both decrypted values must reach the runner as mcpSecrets
    expect(data.workers[0].mcpSecrets).toEqual({
      DISPATCH_API_KEY: 'actual-api-key',
      TENANT_ID: 'actual-tenant-id',
    });

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

  // Defense-in-depth: if a team ever has more than one oauth_token row (legacy
  // duplicate), the resolver must NOT hand a revoked leftover to the worker while
  // a healthy credential exists. It prefers non-revoked, then most recent.
  it('prefers a healthy oauth_token over a revoked duplicate', async () => {
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

    // Two team-wide oauth_token rows: a newer REVOKED one and an older HEALTHY one.
    mockSecretsFindMany.mockResolvedValue([
      { id: 'oauth-revoked', purpose: 'oauth_token', label: null, healthStatus: 'revoked', updatedAt: new Date('2026-07-19T18:00:00Z') },
      { id: 'oauth-healthy', purpose: 'oauth_token', label: null, healthStatus: 'healthy', updatedAt: new Date('2026-07-19T11:00:00Z') },
    ]);
    // provider.get must be called with the HEALTHY row's id, not the revoked one.
    mockSecretsProviderGet.mockImplementation((id: string) =>
      Promise.resolve(id === 'oauth-healthy' ? 'healthy-token' : 'revoked-token'));

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers[0].serverOauthToken).toBe('healthy-token');
    expect(mockSecretsProviderGet).toHaveBeenCalledWith('oauth-healthy');
    expect(mockSecretsProviderGet).not.toHaveBeenCalledWith('oauth-revoked');

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

  // Regression: Codex-backend tasks must NOT receive Anthropic secrets
  // (serverOauthToken / serverApiKey). The Codex CLI uses Claude Code internally,
  // so injecting the team's Claude token caused spurious Claude auth failures
  // (and false "revoked" health marks on the Codex credential) when that token expired.
  it('does not attach Anthropic secrets (serverOauthToken/serverApiKey) for codex-backend tasks', async () => {
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
        title: 'Codex task',
        backend: 'codex',
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

    // Team has both Claude secrets — they must NOT be delivered for Codex tasks.
    mockSecretsFindMany.mockResolvedValue([
      { id: 'oauth-secret-1', purpose: 'oauth_token', label: null },
      { id: 'apikey-secret-1', purpose: 'anthropic_api_key', label: null },
    ]);
    mockSecretsProviderGet.mockResolvedValue('some-claude-credential');

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner', capabilities: ['backend:codex', 'CODEX_HOME'] },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers.length).toBe(1);
    // Anthropic credentials must be absent for Codex-backend tasks.
    expect(data.workers[0].serverOauthToken).toBeUndefined();
    expect(data.workers[0].serverApiKey).toBeUndefined();

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

  // Regression: on 2026-05-25, a task pinned to project "sibling-app" was created
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
        project: 'sibling-app',
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

    // Regression: task in workspace A with a role whose connectorRefs includes connector X
    // must produce a claim response containing X's endpoint AND its decrypted credentials.
    // A mismatch (wrong workspace team, cross-team connector without share grant) must
    // yield no mcpConnectors entry for X. This guards the scenario where Cue MCP
    // credentials were missing because the task ran in the wrong workspace.
    it('delivers connector endpoint and credentials for a task in its correct workspace', async () => {
      // Workspace ws-task (team: team-task) has a role with connector conn-cue.
      // The runner is identified by ws-runner but the TASK belongs to ws-task.
      // Connector and role must be resolved from team-task (task workspace team),
      // not team-runner.
      process.env.ENCRYPTION_KEY = 'test-encryption-key';
      mockAuthenticateApiKey.mockResolvedValue({
        id: 'account-1',
        maxConcurrentWorkers: 5,
        type: 'user',
        authType: 'api',
      });
      mockGetAccountWorkspacePermissions.mockResolvedValue([
        { workspaceId: 'ws-task', canClaim: true },
      ]);
      mockWorkersFindMany.mockResolvedValueOnce([]);
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-task' }]);
      mockTasksFindMany.mockResolvedValueOnce([{
        id: 'task-cue',
        workspaceId: 'ws-task',
        title: 'Classify emails',
        dependsOn: [],
        roleSlug: 'builder',
        workspace: { id: 'ws-task', teamId: 'team-task', gitConfig: null },
      }]);
      mockTasksUpdate.mockReturnValue({
        set: mock(() => ({ where: mock(() => ({ returning: mock(() => [{ id: 'task-cue' }]) })) })),
      });
      mockDbExecute.mockReturnValue(Promise.resolve({
        rows: [{ id: 'worker-cue', task_id: 'task-cue', branch: 'buildd/test', status: 'idle' }],
      }));
      // Role owned by team-task, referencing conn-cue
      mockWorkspaceSkillsFindMany.mockResolvedValue([
        { slug: 'builder', isRole: true, enabled: true, workspaceId: null, model: 'inherit', connectorRefs: ['conn-cue'] },
      ]);
      // Connector owned by team-task (must resolve only for tasks in team-task workspaces)
      mockConnectorsFindMany.mockResolvedValue([
        {
          id: 'conn-cue', teamId: 'team-task', name: 'cue', url: 'https://cue.example.com/api/mcp',
          authMode: 'header', headerName: 'Authorization', transport: 'http', command: null, args: [], envMapping: {},
        },
      ]);
      mockConnectorSharesFindMany.mockResolvedValue([]);
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-cue', workspaceId: 'ws-task', enabled: true },
      ]);
      // main secrets call → []; connector credential call → the connector secret
      mockSecretsFindMany
        .mockResolvedValueOnce([]) // main secrets (anthropic/oauth/mcp_credential)
        .mockResolvedValueOnce([{ id: 'cs-cue', label: 'conn-cue', tokenExpiresAt: null }]);
      mockSecretsProviderGet.mockResolvedValue('Bearer cue-decrypted-token');

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      // Connector endpoint and decrypted credentials must reach the runner
      expect(data.workers[0].mcpConnectors).toEqual([{
        id: 'conn-cue',
        name: 'cue',
        transport: 'http',
        url: 'https://cue.example.com/api/mcp',
        headers: { Authorization: 'Bearer cue-decrypted-token' },
      }]);
    });

    // Regression: a connector owned by a DIFFERENT team (not the task workspace team and
    // not shared-in) must NOT appear in mcpConnectors — cross-team isolation must hold.
    it('excludes connectors owned by a different team when not shared-in', async () => {
      // Task is in ws-task (team-task). Connector is owned by team-other.
      // No share row exists. The connector must not mount.
      process.env.ENCRYPTION_KEY = 'test-encryption-key';
      mockAuthenticateApiKey.mockResolvedValue({
        id: 'account-1',
        maxConcurrentWorkers: 5,
        type: 'user',
        authType: 'api',
      });
      mockGetAccountWorkspacePermissions.mockResolvedValue([
        { workspaceId: 'ws-task', canClaim: true },
      ]);
      mockWorkersFindMany.mockResolvedValueOnce([]);
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-task' }]);
      mockTasksFindMany.mockResolvedValueOnce([{
        id: 'task-cross',
        workspaceId: 'ws-task',
        title: 'Cross-team task',
        dependsOn: [],
        roleSlug: 'builder',
        workspace: { id: 'ws-task', teamId: 'team-task', gitConfig: null },
      }]);
      mockTasksUpdate.mockReturnValue({
        set: mock(() => ({ where: mock(() => ({ returning: mock(() => [{ id: 'task-cross' }]) })) })),
      });
      mockDbExecute.mockReturnValue(Promise.resolve({
        rows: [{ id: 'worker-cross', task_id: 'task-cross', branch: 'buildd/test', status: 'idle' }],
      }));
      // Role in team-task references conn-other
      mockWorkspaceSkillsFindMany.mockResolvedValue([
        { slug: 'builder', isRole: true, enabled: true, workspaceId: null, model: 'inherit', connectorRefs: ['conn-other'] },
      ]);
      // Connector is owned by team-other (not team-task) and not shared-in
      mockConnectorsFindMany.mockResolvedValue([
        {
          id: 'conn-other', teamId: 'team-other', name: 'other-mcp', url: 'https://other.example.com/api/mcp',
          authMode: 'none', headerName: null, transport: 'http', command: null, args: [], envMapping: {},
        },
      ]);
      mockConnectorSharesFindMany.mockResolvedValue([]); // no share grant
      mockConnectorWorkspacesFindMany.mockResolvedValue([
        { connectorId: 'conn-other', workspaceId: 'ws-task', enabled: true },
      ]);
      mockSecretsFindMany.mockResolvedValue([]);

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      // Cross-team connector without a share grant must be excluded
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

  describe('mission pacing gates', () => {
    function apiAccount() {
      return { id: 'account-1', maxConcurrentWorkers: 5, type: 'user' as const, authType: 'api' as const, teamId: 'team-1' };
    }
    function missionTask(id: string, missionId: string) {
      return {
        id,
        workspaceId: 'ws-1',
        missionId,
        title: `Task ${id}`,
        backend: 'claude' as const,
        dependsOn: [],
        workspace: { id: 'ws-1', gitConfig: null, teamId: 'team-1' },
      };
    }
    function setupClaimBase() {
      mockWorkersFindMany.mockResolvedValue([]);
      mockGetAccountWorkspacePermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true }]);
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', accessMode: 'private', teamId: 'team-1' }]);
      mockTasksUpdate.mockReturnValue({
        set: mock(() => ({ where: mock(() => ({ returning: mock(() => [{ id: 'task-1' }]), catch: mock(() => {}) })) })),
      });
      mockDbExecute.mockReturnValue(Promise.resolve({
        rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
      }));
    }

    it('claims tasks from eager missions without restriction', async () => {
      mockAuthenticateApiKey.mockResolvedValue(apiAccount());
      setupClaimBase();
      mockTasksFindMany.mockResolvedValueOnce([missionTask('task-1', 'mission-A')]);
      mockMissionsFindMany.mockResolvedValue([{
        id: 'mission-A',
        status: 'active',
        maxConcurrentTasks: null,
        pacingMode: 'eager',
        pacingMaxPerHour: null,
        lastTaskStartedAt: new Date(),
      }]);

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers.length).toBe(1);
      expect(data.workers[0].taskId).toBe('task-1');
    });

    it('skips task from paced mission when interval has not elapsed', async () => {
      mockAuthenticateApiKey.mockResolvedValue(apiAccount());
      setupClaimBase();
      mockTasksFindMany.mockResolvedValueOnce([missionTask('task-1', 'mission-A')]);
      mockMissionsFindMany.mockResolvedValue([{
        id: 'mission-A',
        status: 'active',
        maxConcurrentTasks: null,
        pacingMode: 'paced',
        pacingMaxPerHour: 2,
        lastTaskStartedAt: new Date(Date.now() - 5 * 60 * 1000),
      }]);

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers.length).toBe(0);
    });

    it('claims task from paced mission when interval has elapsed', async () => {
      mockAuthenticateApiKey.mockResolvedValue(apiAccount());
      setupClaimBase();
      mockTasksFindMany.mockResolvedValueOnce([missionTask('task-1', 'mission-A')]);
      mockMissionsFindMany.mockResolvedValue([{
        id: 'mission-A',
        status: 'active',
        maxConcurrentTasks: null,
        pacingMode: 'paced',
        pacingMaxPerHour: 2,
        lastTaskStartedAt: new Date(Date.now() - 35 * 60 * 1000),
      }]);

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers.length).toBe(1);
    });

    it('claims only one task from a paced mission in a single poll (in-memory stamp)', async () => {
      mockAuthenticateApiKey.mockResolvedValue(apiAccount());
      setupClaimBase();
      mockTasksFindMany.mockResolvedValueOnce([
        missionTask('task-1', 'mission-A'),
        missionTask('task-2', 'mission-A'),
        missionTask('task-3', 'mission-A'),
      ]);
      mockMissionsFindMany.mockResolvedValue([{
        id: 'mission-A',
        status: 'active',
        maxConcurrentTasks: null,
        pacingMode: 'paced',
        pacingMaxPerHour: 1,
        lastTaskStartedAt: null,
      }]);

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers.length).toBe(1);
    });

    it('skips task from budget_exhausted mission', async () => {
      mockAuthenticateApiKey.mockResolvedValue(apiAccount());
      setupClaimBase();
      mockTasksFindMany.mockResolvedValueOnce([missionTask('task-1', 'mission-A')]);
      mockMissionsFindMany.mockResolvedValue([{
        id: 'mission-A',
        status: 'budget_exhausted',
        maxConcurrentTasks: null,
        pacingMode: 'eager',
        pacingMaxPerHour: null,
        lastTaskStartedAt: null,
      }]);

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers.length).toBe(0);
    });

    it('enforces mission-level maxConcurrentTasks cap', async () => {
      mockAuthenticateApiKey.mockResolvedValue(apiAccount());
      setupClaimBase();
      mockTasksFindMany.mockResolvedValueOnce([missionTask('task-1', 'mission-A')]);
      mockMissionsFindMany.mockResolvedValue([{
        id: 'mission-A',
        status: 'active',
        maxConcurrentTasks: 2,
        pacingMode: 'eager',
        pacingMaxPerHour: null,
        lastTaskStartedAt: null,
      }]);
      mockDbSelect.mockReturnValue(makeSelectChain([{ missionId: 'mission-A', count: 2 }]));

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers.length).toBe(0);
    });

    it('claims task when mission active count is below mission maxConcurrentTasks', async () => {
      mockAuthenticateApiKey.mockResolvedValue(apiAccount());
      setupClaimBase();
      mockTasksFindMany.mockResolvedValueOnce([missionTask('task-1', 'mission-A')]);
      mockMissionsFindMany.mockResolvedValue([{
        id: 'mission-A',
        status: 'active',
        maxConcurrentTasks: 3,
        pacingMode: 'eager',
        pacingMaxPerHour: null,
        lastTaskStartedAt: null,
      }]);
      mockDbSelect.mockReturnValue(makeSelectChain([{ missionId: 'mission-A', count: 1 }]));

      const res = await POST(createMockRequest({ headers: { Authorization: 'Bearer bld_test' }, body: { runner: 'r' } }));
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.workers.length).toBe(1);
    });
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

  it('claims a task when the only overlapping PR has prLifecycleStatus=closed', async () => {
    // Regression guard: a closed/abandoned PR must NOT permanently block sibling
    // tasks from claiming. The route filters out workers with prLifecycleStatus=closed
    // before passing them to findBlockingPr() — so a task with an overlapping
    // pathManifest is still claimed when the blocking PR was abandoned.
    mockAuthenticateApiKey.mockResolvedValue(apiAccount());
    setupForClaim();

    // Active workers: none
    // Open PR pre-fetch: a worker whose PR is closed (not merged)
    mockWorkersFindMany
      .mockResolvedValueOnce([]) // active workers
      .mockResolvedValueOnce([  // open PR pre-fetch: closed PR
        {
          workspaceId: 'ws-1',
          taskId: 'pr-task-closed',
          prNumber: 1350,
          prUrl: 'https://github.com/org/repo/pull/1350',
          status: 'completed',
          prLifecycleStatus: 'closed',  // PR was closed without merging
        },
      ]);

    // Claimable task overlaps the closed PR's files
    mockTasksFindMany
      .mockResolvedValueOnce([taskWithManifest(['apps/runner/src/env-scan.ts'])])
      // PR task manifest lookup (would block if the PR were still open)
      .mockResolvedValueOnce([{ id: 'pr-task-closed', pathManifest: ['apps/runner/src/env-scan.ts'] }]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    // Closed PR is excluded from the overlap guard → task is claimed, not deferred
    expect(data.workers).toHaveLength(1);
    expect(data.workers[0].taskId).toBe('task-1');
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

  // --- Connector availability pre-filter tests ---

  // When a task's role declares connectorRefs, the claim route must verify
  // those connectors are available in the claiming workspace BEFORE claiming.
  // Tasks with missing connectors are silently deferred so a correct-workspace
  // worker can pick them up. This prevents the claim→MCP-pre-flight failure loop.
  it('skips task requiring connector unavailable in claiming workspace, claims others normally', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]); // active workers
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-A' }]);
    mockGetAccountWorkspacePermissions.mockResolvedValue([]);

    // Two tasks: task-1 has role 'email-agent' (needs connector), task-2 has no role
    mockTasksFindMany
      .mockResolvedValueOnce([
        {
          id: 'task-1',
          workspaceId: 'ws-A',
          title: 'Email task',
          roleSlug: 'email-agent',
          workspace: { id: 'ws-A', teamId: 'team-1', gitConfig: null },
        },
        {
          id: 'task-2',
          workspaceId: 'ws-A',
          title: 'Regular task',
          workspace: { id: 'ws-A', gitConfig: null },
        },
      ])
      .mockResolvedValue([]); // sibling/parent queries

    // Pre-filter role lookup: email-agent has connectorRefs: ['connector-cue']
    // Role floor lookup: no override
    mockWorkspaceSkillsFindMany
      .mockResolvedValueOnce([
        {
          slug: 'email-agent',
          teamId: 'team-1',
          workspaceId: null,
          connectorRefs: ['connector-cue'],
        },
      ])  // pre-filter role lookup
      .mockResolvedValue([]); // role floor + subsequent calls

    // connector-cue is owned by team-1 (visible), but disabled for ws-A
    mockConnectorsFindMany.mockResolvedValueOnce([
      { id: 'connector-cue', teamId: 'team-1', name: 'cue' },
    ]);
    mockConnectorSharesFindMany.mockResolvedValueOnce([]); // no cross-team shares
    mockConnectorWorkspacesFindMany.mockResolvedValueOnce([
      { connectorId: 'connector-cue', workspaceId: 'ws-A', enabled: false },
    ]); // disabled → unavailable

    // task-2 gets claimed
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => [{ id: 'task-2' }]),
        })),
      })),
    });
    mockDbExecute.mockReturnValue(Promise.resolve({
      rows: [{ id: 'worker-2', task_id: 'task-2', branch: 'buildd/test', status: 'idle' }],
    }));

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    // task-1 must be skipped; task-2 must be claimed
    expect(data.workers).toHaveLength(1);
    expect(data.workers[0].taskId).toBe('task-2');
  });

  it('returns 422 routing_mismatch when explicit taskId claim has missing connector', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 5,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany.mockResolvedValueOnce([]); // active workers
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-A' }]);
    mockGetAccountWorkspacePermissions.mockResolvedValue([]);

    // Single task with required connector
    mockTasksFindMany
      .mockResolvedValueOnce([
        {
          id: 'task-1',
          workspaceId: 'ws-A',
          title: 'Email task',
          roleSlug: 'email-agent',
          workspace: { id: 'ws-A', teamId: 'team-1', gitConfig: null },
        },
      ])
      .mockResolvedValue([]);

    // email-agent role references a connector that's not shared to team-1
    mockWorkspaceSkillsFindMany
      .mockResolvedValueOnce([
        {
          slug: 'email-agent',
          teamId: 'team-1',
          workspaceId: null,
          connectorRefs: ['connector-cue'],
        },
      ])
      .mockResolvedValue([]);

    // connector-cue owned by a different team and not shared
    mockConnectorsFindMany.mockResolvedValueOnce([
      { id: 'connector-cue', teamId: 'team-other', name: 'cue' },
    ]);
    mockConnectorSharesFindMany.mockResolvedValueOnce([]); // not shared to team-1
    mockConnectorWorkspacesFindMany.mockResolvedValueOnce([]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner', taskId: 'task-1' },
    });
    const res = await POST(req);

    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toBe('routing_mismatch');
    expect(data.detail).toBeTruthy();
  });

  // --- Candidate window starvation tests ---
  // Bug (2026-07-30): claim route fetched only `availableSlots` candidates ordered
  // by (priority DESC, createdAt ASC). If the entire window was filled by tasks that
  // are permanently deferred in the dispatch loop (e.g. connector-mismatch), the
  // runner received `race_lost` forever even with valid tasks behind the prefix.
  //
  // Fix: over-fetch to max(availableSlots*5, 25) so a deferred prefix cannot
  // exhaust the window. Also adds `all_candidates_deferred` diagnostic reason.

  describe('candidate window starvation fix', () => {
    it('claims a clean task even when all tasks inside availableSlots are connector-mismatched', async () => {
      // availableSlots = 1 (maxTasks=1, 0 active workers).
      // Before fix: limit=1, only task-1 (mismatched) returned → race_lost.
      // After fix: limit=max(1*5,25)=25, both tasks returned, task-2 claimed.
      mockAuthenticateApiKey.mockResolvedValue({
        id: 'account-1', maxConcurrentWorkers: 5, type: 'user', authType: 'api',
      });
      mockWorkersFindMany.mockResolvedValueOnce([]); // no active workers
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
      mockGetAccountWorkspacePermissions.mockResolvedValue([]);

      const allTasks = [
        // task-1: email-agent role → connector-mismatched (higher priority, fetched first)
        {
          id: 'task-1', workspaceId: 'ws-1', title: 'Email task',
          roleSlug: 'email-agent', priority: 5,
          workspace: { id: 'ws-1', teamId: 'team-1', gitConfig: null },
        },
        // task-2: no role → clean (lower priority, beyond window at limit=1)
        {
          id: 'task-2', workspaceId: 'ws-1', title: 'Clean task',
          roleSlug: null, priority: 4,
          workspace: { id: 'ws-1', teamId: 'team-1', gitConfig: null },
        },
      ];

      // Simulate real DB behaviour: only return as many tasks as the limit allows.
      // This makes the test fail BEFORE the over-fetch fix and pass AFTER.
      mockTasksFindMany
        .mockImplementationOnce((opts: any) => {
          const lim = typeof opts?.limit === 'number' ? opts.limit : Infinity;
          return Promise.resolve(allTasks.slice(0, lim));
        })
        .mockResolvedValue([]); // subsequent calls (siblings, parent, etc.)

      // Pre-filter role lookup: email-agent role has connectorRefs pointing to a
      // connector that no longer exists → dangling ref → mismatched.
      mockWorkspaceSkillsFindMany
        .mockResolvedValueOnce([
          { slug: 'email-agent', teamId: 'team-1', workspaceId: null, connectorRefs: ['conn-cue'] },
        ])
        .mockResolvedValue([]);
      mockConnectorsFindMany.mockResolvedValueOnce([]); // conn-cue deleted
      mockConnectorSharesFindMany.mockResolvedValueOnce([]);
      mockConnectorWorkspacesFindMany.mockResolvedValueOnce([]);

      // task-2 passes all gates and gets claimed
      mockTasksUpdate.mockReturnValue({
        set: mock(() => ({ where: mock(() => ({ returning: mock(() => [{ id: 'task-2' }]) })) })),
      });
      mockDbExecute.mockReturnValue(Promise.resolve({
        rows: [{ id: 'worker-2', task_id: 'task-2', branch: 'buildd/test', status: 'idle' }],
      }));

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner', maxTasks: 1 },
      }));

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.workers).toHaveLength(1);
      expect(data.workers[0].taskId).toBe('task-2');
    });

    it('returns all_candidates_deferred diagnostic when every candidate is skipped by connector pre-filter', async () => {
      mockAuthenticateApiKey.mockResolvedValue({
        id: 'account-1', maxConcurrentWorkers: 5, type: 'user', authType: 'api',
      });
      mockWorkersFindMany.mockResolvedValueOnce([]);
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
      mockGetAccountWorkspacePermissions.mockResolvedValue([]);

      // All 2 tasks require email-agent role → all connector-mismatched → none claimed.
      mockTasksFindMany
        .mockResolvedValueOnce([
          {
            id: 'task-1', workspaceId: 'ws-1', title: 'Email task 1',
            roleSlug: 'email-agent',
            workspace: { id: 'ws-1', teamId: 'team-1', gitConfig: null },
          },
          {
            id: 'task-2', workspaceId: 'ws-1', title: 'Email task 2',
            roleSlug: 'email-agent',
            workspace: { id: 'ws-1', teamId: 'team-1', gitConfig: null },
          },
        ])
        .mockResolvedValue([]);

      mockWorkspaceSkillsFindMany
        .mockResolvedValueOnce([
          { slug: 'email-agent', teamId: 'team-1', workspaceId: null, connectorRefs: ['conn-missing'] },
        ])
        .mockResolvedValue([]);
      mockConnectorsFindMany.mockResolvedValueOnce([]); // conn-missing not found
      mockConnectorSharesFindMany.mockResolvedValueOnce([]);
      mockConnectorWorkspacesFindMany.mockResolvedValueOnce([]);

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      }));

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.workers).toHaveLength(0);
      expect(data.diagnostics.reason).toBe('all_candidates_deferred');
      expect(data.diagnostics.deferrals.connector_mismatch).toBe(2);
    });
  });
  // OAuth budget pacing (packages/core/oauth-budget.ts). Seat auth reports no
  // cost, so pressure is learned from past exhaustion episodes and fed to the
  // model router as dailyBudgetPct.
  describe('oauth budget pacing', () => {
    // Several task UPDATEs can fire per claim (claim + post-claim bookkeeping),
    // so keep every payload and pick the one carrying the routing decision.
    let taskSetPayloads: any[] = [];
    const claimPayload = () => taskSetPayloads.find(p => p && 'predictedModel' in p) ?? null;

    function mockClaimSuccess() {
      mockTasksUpdate.mockImplementation(() => ({
        set: mock((payload: any) => {
          taskSetPayloads.push(payload);
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

    /** Five episodes at 600 sonnet-equivalent turns → 'good' confidence, p25 = 600. */
    function learnedWindow() {
      return Array.from({ length: 5 }, (_, i) => ({
        exhaustedAt: new Date(Date.now() - (24 + i) * 60 * 60 * 1000),
        resetsAt: new Date(Date.now() - 23 * 60 * 60 * 1000),
        workerCount: 10,
        turns: 600,
        inputTokens: 0,
        outputTokens: 0,
        weightedTurns: 600,
        weightedTokens: 0,
      }));
    }

    function windowUsage(over: Partial<Record<string, number>> = {}) {
      return {
        windowStartedAt: new Date(Date.now() - 60 * 60 * 1000),
        usage: {
          workerCount: 0, turns: 0, tokens: 0,
          weightedTurns: 0, weightedTokens: 0,
          ...over,
        },
      };
    }

    function pendingTask(over: Record<string, unknown> = {}) {
      return {
        id: 'task-1',
        workspaceId: 'ws-1',
        title: 'background work',
        kind: 'engineering',
        complexity: 'normal',
        priority: 0,
        dependsOn: [],
        workspace: { id: 'ws-1', gitConfig: null },
        ...over,
      };
    }

    beforeEach(() => {
      taskSetPayloads = [];
      delete process.env.OAUTH_BUDGET_PACING;
      mockLoadOauthEpisodes.mockReset();
      mockLoadOauthEpisodes.mockResolvedValue([]);
      mockMeasureOauthWindow.mockReset();
      mockMeasureOauthWindow.mockResolvedValue(windowUsage());
      mockAuthenticateApiKey.mockResolvedValue({
        id: 'account-1', maxConcurrentWorkers: 5, type: 'user',
        authType: 'oauth', maxConcurrentSessions: null,
      });
      mockWorkersFindMany.mockResolvedValueOnce([]);
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
      mockAccountWorkspacesFindMany.mockResolvedValue([]);
      mockTasksFindMany.mockResolvedValue([pendingTask()]);
      mockClaimSuccess();
    });

    afterEach(() => {
      delete process.env.OAUTH_BUDGET_PACING;
    });

    it('stays inert with too few episodes — claims exactly as before', async () => {
      mockLoadOauthEpisodes.mockResolvedValue(learnedWindow().slice(0, 2));
      // Usage that would be way over capacity if it were being applied.
      mockMeasureOauthWindow.mockResolvedValue(windowUsage({ weightedTurns: 99_999 }));

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      }));

      const data = await res.json();
      expect(data.workers).toHaveLength(1);
      expect(claimPayload()).not.toBeNull();
      expect(data.diagnostics?.budgetPressure).toBeUndefined();
      // Below the sample threshold we never even measure the window.
      expect(mockMeasureOauthWindow).not.toHaveBeenCalled();
    });

    it('pauses priority-0 background work once the learned window is full', async () => {
      mockLoadOauthEpisodes.mockResolvedValue(learnedWindow());
      mockMeasureOauthWindow.mockResolvedValue(windowUsage({ workerCount: 6, turns: 600, weightedTurns: 600 }));

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      }));

      const data = await res.json();
      expect(data.workers).toHaveLength(0);
      expect(claimPayload()).toBeNull();
      expect(data.diagnostics.reason).toBe('all_candidates_deferred');
      expect(data.diagnostics.deferrals.routing_paused).toBe(1);
      // Readable: the deferral is attributable, not an unexplained stall.
      expect(data.diagnostics.budgetPressure).toEqual({
        pct: 1,
        limiter: 'turns',
        confidence: 'good',
        samples: 5,
      });
    });

    it('an opus-heavy window fills faster than a haiku-heavy one at equal turn counts', async () => {
      mockLoadOauthEpisodes.mockResolvedValue(learnedWindow());
      // 150 raw turns, but haiku-weighted to ~40 sonnet-equivalents → 7% pressure.
      mockMeasureOauthWindow.mockResolvedValue(windowUsage({ workerCount: 3, turns: 150, weightedTurns: 40 }));

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      }));

      const data = await res.json();
      expect(data.workers).toHaveLength(1);
      // Cheap models do not throttle the queue: no downshift at 7%.
      expect(claimPayload()?.predictedModel).toBe('sonnet');
    });

    it('downshifts rather than pausing while the window is part spent', async () => {
      mockLoadOauthEpisodes.mockResolvedValue(learnedWindow());
      mockMeasureOauthWindow.mockResolvedValue(windowUsage({ workerCount: 5, turns: 480, weightedTurns: 480 }));
      mockTasksFindMany.mockResolvedValue([pendingTask({ complexity: 'complex' })]);

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      }));

      const data = await res.json();
      expect(data.workers).toHaveLength(1);
      // 80% pressure lands in the downshift band: opus baseline → sonnet.
      expect(claimPayload()?.predictedModel).toBe('sonnet');
    });

    // The whole point of the Start button is that it does something. Pacing must
    // never turn an explicit start into a silent no-op (the phantom-stop bug
    // /api/tasks/[id]/start already has for other gates).
    it('never paces an explicit single-task claim, even at 100% pressure', async () => {
      mockLoadOauthEpisodes.mockResolvedValue(learnedWindow());
      mockMeasureOauthWindow.mockResolvedValue(windowUsage({ weightedTurns: 99_999 }));

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner', taskId: 'task-1' },
      }));

      const data = await res.json();
      expect(data.workers).toHaveLength(1);
      expect(claimPayload()).not.toBeNull();
      // Pacing was not even consulted for a targeted claim.
      expect(mockLoadOauthEpisodes).not.toHaveBeenCalled();
    });

    it('OAUTH_BUDGET_PACING=off makes it fully inert', async () => {
      process.env.OAUTH_BUDGET_PACING = 'off';
      mockLoadOauthEpisodes.mockResolvedValue(learnedWindow());
      mockMeasureOauthWindow.mockResolvedValue(windowUsage({ weightedTurns: 99_999 }));

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      }));

      const data = await res.json();
      expect(data.workers).toHaveLength(1);
      expect(mockLoadOauthEpisodes).not.toHaveBeenCalled();
      expect(data.diagnostics?.budgetPressure).toBeUndefined();
    });

    it('does not pace API-billed accounts (they have a real cost signal)', async () => {
      mockAuthenticateApiKey.mockResolvedValue({
        id: 'account-1', maxConcurrentWorkers: 5, type: 'user',
        authType: 'api', maxCostPerDay: '100', totalCost: '1',
      });
      mockLoadOauthEpisodes.mockResolvedValue(learnedWindow());

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      }));

      const data = await res.json();
      expect(data.workers).toHaveLength(1);
      expect(mockLoadOauthEpisodes).not.toHaveBeenCalled();
    });
  });

  // --- connector_advisory_mode workspace flag ---
  // When connector_advisory_mode=true on a workspace, connector failures that
  // don't involve hard-required connectors (task.requiredConnectors) produce a
  // degradedConnectors payload on the claimed worker instead of blocking the claim.
  // Safety bound: total degradation (ALL role connectors failing) still blocks.
  describe('connector_advisory_mode', () => {
    function setupAdvisoryBase() {
      mockAuthenticateApiKey.mockResolvedValue({
        id: 'account-1', maxConcurrentWorkers: 5, type: 'user', authType: 'api',
      });
      mockWorkersFindMany.mockResolvedValueOnce([]); // no active workers
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
      mockGetAccountWorkspacePermissions.mockResolvedValue([]);
    }

    it('flag disabled (default) — connector failure blocks the task (hard mismatch)', async () => {
      setupAdvisoryBase();

      mockTasksFindMany
        .mockResolvedValueOnce([
          {
            id: 'task-1', workspaceId: 'ws-1', title: 'Role task',
            roleSlug: 'researcher', requiredConnectors: null,
            workspace: { id: 'ws-1', teamId: 'team-1', gitConfig: null, connectorAdvisoryMode: false },
          },
        ])
        .mockResolvedValue([]);

      // researcher role references conn-A, which is never-mounted
      mockWorkspaceSkillsFindMany
        .mockResolvedValueOnce([
          { slug: 'researcher', teamId: 'team-1', workspaceId: null, connectorRefs: ['conn-A'] },
        ])
        .mockResolvedValue([]);
      mockConnectorsFindMany.mockResolvedValueOnce([]); // conn-A not found → never_mounted
      mockConnectorSharesFindMany.mockResolvedValueOnce([]);
      mockConnectorWorkspacesFindMany.mockResolvedValueOnce([]);

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      }));

      expect(res.status).toBe(200);
      const data = await res.json();
      // Task blocked: no workers claimed
      expect(data.workers).toHaveLength(0);
      expect(data.diagnostics?.deferrals?.connector_mismatch).toBe(1);
    });

    it('flag enabled, partial degradation — claims task with degradedConnectors in response', async () => {
      setupAdvisoryBase();

      // Role has 2 connectors: conn-A (unavailable) and conn-B (available)
      mockTasksFindMany
        .mockResolvedValueOnce([
          {
            id: 'task-1', workspaceId: 'ws-1', title: 'Role task',
            roleSlug: 'researcher', requiredConnectors: null,
            workspace: { id: 'ws-1', teamId: 'team-1', gitConfig: null, connectorAdvisoryMode: true },
          },
        ])
        .mockResolvedValue([]);

      mockWorkspaceSkillsFindMany
        .mockResolvedValueOnce([
          { slug: 'researcher', teamId: 'team-1', workspaceId: null, connectorRefs: ['conn-A', 'conn-B'] },
        ])
        .mockResolvedValue([]);

      // Only conn-B is found in the DB; conn-A is a dangling ref (never_mounted).
      // Use transport: 'stdio' so the pre-filter skips the HTTP HEAD probe for conn-B
      // (a real fetch to a test URL would fail and make conn-B 'transient', causing
      // total degradation and blocking advisory mode).
      mockConnectorsFindMany.mockResolvedValueOnce([
        { id: 'conn-B', teamId: 'team-1', name: 'GitHub', authMode: 'none', transport: 'stdio', url: null, envMapping: null },
      ]);
      mockConnectorSharesFindMany.mockResolvedValueOnce([]);
      mockConnectorWorkspacesFindMany.mockResolvedValueOnce([]);

      mockTasksUpdate.mockReturnValue({
        set: mock(() => ({ where: mock(() => ({ returning: mock(() => [{ id: 'task-1' }]) })) })),
      });
      mockDbExecute.mockReturnValue(Promise.resolve({
        rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
      }));

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      }));

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.workers).toHaveLength(1);
      expect(data.workers[0].taskId).toBe('task-1');
      // degradedConnectors carries the unavailable connector
      const degraded = data.workers[0].degradedConnectors;
      expect(degraded).toBeDefined();
      expect(degraded).toHaveLength(1);
      expect(degraded[0].name).toBe('conn-A'); // name falls back to connectorId when not in DB
      expect(degraded[0].failureMode).toBe('never_mounted');
      // NOT in the deferral list
      expect(data.diagnostics?.deferrals?.connector_mismatch ?? 0).toBe(0);
    });

    it('flag enabled, total degradation (ALL connectors fail) — still blocks task', async () => {
      setupAdvisoryBase();

      mockTasksFindMany
        .mockResolvedValueOnce([
          {
            id: 'task-1', workspaceId: 'ws-1', title: 'Role task',
            roleSlug: 'researcher', requiredConnectors: null,
            workspace: { id: 'ws-1', teamId: 'team-1', gitConfig: null, connectorAdvisoryMode: true },
          },
        ])
        .mockResolvedValue([]);

      // Role has 1 connector: conn-A (unavailable) — total degradation
      mockWorkspaceSkillsFindMany
        .mockResolvedValueOnce([
          { slug: 'researcher', teamId: 'team-1', workspaceId: null, connectorRefs: ['conn-A'] },
        ])
        .mockResolvedValue([]);
      mockConnectorsFindMany.mockResolvedValueOnce([]); // conn-A not found
      mockConnectorSharesFindMany.mockResolvedValueOnce([]);
      mockConnectorWorkspacesFindMany.mockResolvedValueOnce([]);

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      }));

      expect(res.status).toBe(200);
      const data = await res.json();
      // Safety bound: total degradation → still blocks even with flag on
      expect(data.workers).toHaveLength(0);
      expect(data.diagnostics?.deferrals?.connector_mismatch).toBe(1);
    });

    it('flag enabled, failing connector is in requiredConnectors — hard blocks', async () => {
      setupAdvisoryBase();

      // task explicitly requires conn-A which is unavailable
      mockTasksFindMany
        .mockResolvedValueOnce([
          {
            id: 'task-1', workspaceId: 'ws-1', title: 'Role task',
            roleSlug: 'researcher', requiredConnectors: ['conn-A'],
            workspace: { id: 'ws-1', teamId: 'team-1', gitConfig: null, connectorAdvisoryMode: true },
          },
        ])
        .mockResolvedValue([]);

      // Role has 2 connectors: conn-A (unavailable) and conn-B (available)
      mockWorkspaceSkillsFindMany
        .mockResolvedValueOnce([
          { slug: 'researcher', teamId: 'team-1', workspaceId: null, connectorRefs: ['conn-A', 'conn-B'] },
        ])
        .mockResolvedValue([]);
      mockConnectorsFindMany.mockResolvedValueOnce([
        // Use stdio transport so the pre-filter doesn't issue a real HTTP probe for conn-B
        { id: 'conn-B', teamId: 'team-1', name: 'GitHub', authMode: 'none', transport: 'stdio', url: null, envMapping: null },
      ]);
      mockConnectorSharesFindMany.mockResolvedValueOnce([]);
      mockConnectorWorkspacesFindMany.mockResolvedValueOnce([]);

      const res = await POST(createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      }));

      expect(res.status).toBe(200);
      const data = await res.json();
      // conn-A is in requiredConnectors → hard block despite advisory mode
      expect(data.workers).toHaveLength(0);
      expect(data.diagnostics?.deferrals?.connector_mismatch).toBe(1);
    });
  });
});

// Regression (2026-08-28): a claim burst minted worker rows that no runner ever
// started; they rotted for ~12 minutes and were then booked as infra failures.
// The insert had no atomic guard against a task that already owned a live
// worker, and a no-op insert always rolled the task back to pending — which is
// what let the next poll mint yet another row for the same task.
describe('claim insert — atomic duplicate-worker guard', () => {
  function apiAccount() {
    return {
      id: 'account-1',
      name: 'acct',
      maxConcurrentWorkers: 5,
      type: 'user' as const,
      authType: 'api' as const,
    };
  }

  function claimableTask() {
    return {
      id: 'task-1',
      workspaceId: 'ws-1',
      title: 'Classify emails',
      backend: 'claude',
      dependsOn: [],
      requiredCapabilities: [],
      context: {},
      workspace: { id: 'ws-1', gitConfig: null, teamId: 'team-1' },
    };
  }

  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindMany.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockDbExecute.mockReset();
    mockTasksUpdate.mockReset();
    mockGetAccountWorkspacePermissions.mockResolvedValue([]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', accessMode: 'open', teamId: 'team-1' }]);
    mockTasksFindMany.mockResolvedValue([claimableTask()]);
    mockWorkersFindMany.mockResolvedValue([]);
    mockAuthenticateApiKey.mockResolvedValue(apiAccount());
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({ where: mock(() => ({ returning: mock(() => [{ id: 'task-1' }]) })) })),
    });
  });

  it('requires the task to have no live worker inside the insert statement', async () => {
    mockDbExecute.mockReturnValue(Promise.resolve({
      rows: [{ id: 'worker-1', task_id: 'task-1', branch: 'buildd/test', status: 'idle' }],
    }));

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    await POST(req);

    expect(mockDbExecute).toHaveBeenCalled();
    const insertSql = (mockDbExecute.mock.calls[0][0] as any).strings.join('?');
    expect(insertSql).toContain('INSERT INTO');
    // The guard must live in the same statement as the insert — a pre-read is
    // exactly the TOCTOU that produced the duplicate rows.
    expect(insertSql).toContain('NOT EXISTS');
    expect(insertSql).toContain('w_dup.task_id');
  });

  it('does not roll the task back to pending when the dup guard blocks the insert', async () => {
    // Insert no-ops...
    mockDbExecute.mockReturnValue(Promise.resolve({ rows: [] }));
    // ...because a live worker already owns this task (limit:1 lookup).
    mockWorkersFindMany.mockImplementation((args: any) =>
      args?.limit === 1 ? Promise.resolve([{ id: 'live-w' }]) : Promise.resolve([]),
    );

    const taskUpdates: any[] = [];
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdates.push(vals);
        return { where: mock(() => ({ returning: mock(() => [{ id: 'task-1' }]) })) };
      }),
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);
    const data = await res.json();

    expect(data.workers).toHaveLength(0);
    expect(data.diagnostics.deferrals?.duplicate_worker).toBe(1);
    // The live worker owns the task — no rollback to pending.
    expect(taskUpdates.some(u => u.status === 'pending')).toBe(false);
  });

  it('still rolls the task back to pending when the insert no-ops on the concurrency cap', async () => {
    mockDbExecute.mockReturnValue(Promise.resolve({ rows: [] }));
    // No live worker for the task → the no-op was the concurrency guard.
    mockWorkersFindMany.mockImplementation(() => Promise.resolve([]));

    const taskUpdates: any[] = [];
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdates.push(vals);
        return { where: mock(() => ({ returning: mock(() => [{ id: 'task-1' }]) })) };
      }),
    });

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);
    const data = await res.json();

    expect(data.workers).toHaveLength(0);
    expect(taskUpdates.some(u => u.status === 'pending' && u.claimedBy === null)).toBe(true);
  });
});
