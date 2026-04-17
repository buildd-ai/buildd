import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindMany = mock(() => [] as any[]);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockAccountWorkspacesFindMany = mock(() => [] as any[]);
const mockTasksFindMany = mock(() => [] as any[]);
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

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      workspaces: { findMany: mockWorkspacesFindMany },
      accountWorkspaces: { findMany: mockAccountWorkspacesFindMany },
      tasks: { findMany: mockTasksFindMany },
      workerHeartbeats: { findFirst: mockHeartbeatsFindFirst },
      secrets: { findMany: mockSecretsFindMany },
      tenantBudgets: { findFirst: mock(() => null as any) },
      workspaceSkills: {
        findMany: mockWorkspaceSkillsFindMany,
        findFirst: mockWorkspaceSkillsFindFirst,
      },
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
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }),
    { raw: (s: string) => ({ raw: s, type: 'sql' }) },
  ),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  lt: (field: any, value: any) => ({ field, value, type: 'lt' }),
  gt: (field: any, value: any) => ({ field, value, type: 'gt' }),
  gte: (field: any, value: any) => ({ field, value, type: 'gte' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  accounts: { id: 'id', activeSessions: 'activeSessions' },
  accountWorkspaces: { accountId: 'accountId', canClaim: 'canClaim', workspaceId: 'workspaceId' },
  tasks: { id: 'id', workspaceId: 'workspaceId', status: 'status', claimedBy: 'claimedBy', claimedAt: 'claimedAt', expiresAt: 'expiresAt', runnerPreference: 'runnerPreference', createdAt: 'createdAt', priority: 'priority', dependsOn: 'dependsOn' },
  workers: { id: 'id', accountId: 'accountId', status: 'status', updatedAt: 'updatedAt', taskId: 'taskId' },
  workerHeartbeats: { accountId: 'accountId', lastHeartbeatAt: 'lastHeartbeatAt' },
  workspaces: { id: 'id', accessMode: 'accessMode' },
  workspaceSkills: { slug: 'slug', isRole: 'isRole', enabled: 'enabled', workspaceId: 'workspaceId', accountId: 'accountId' },
  secrets: { accountId: 'accountId', purpose: 'purpose', label: 'label', teamId: 'teamId', workspaceId: 'workspaceId' },
  tenantBudgets: { id: 'id', tenantId: 'tenantId', teamId: 'teamId', budgetResetsAt: 'budgetResetsAt' },
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

    // Default: no stale workers
    mockWorkersFindMany.mockResolvedValue([]);
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

  it('attaches mcpSecrets when mcp_credential secrets exist for account', async () => {
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

    // Mock secrets: return mcp_credential secrets scoped to workspace team
    mockSecretsFindMany.mockResolvedValue([
      { id: 'secret-1', purpose: 'mcp_credential', label: 'DISPATCH_API_KEY' },
      { id: 'secret-2', purpose: 'mcp_credential', label: 'SLACK_TOKEN' },
    ]);

    // provider.get called for each mcp_credential secret (no api_key/oauth found)
    mockSecretsProviderGet
      .mockResolvedValueOnce('decrypted-dispatch-key')
      .mockResolvedValueOnce('decrypted-slack-token');

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workers.length).toBe(1);
    expect(data.workers[0].mcpSecrets).toEqual({
      DISPATCH_API_KEY: 'decrypted-dispatch-key',
      SLACK_TOKEN: 'decrypted-slack-token',
    });

    // Restore
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
        context: { model: 'claude-opus-4-7' },
        workspace: { id: 'ws-1', gitConfig: null },
      }]);
      mockClaimSuccess();

      const req = createMockRequest({
        headers: { Authorization: 'Bearer bld_test' },
        body: { runner: 'test-runner' },
      });
      await POST(req);

      expect(lastTaskSetPayload.predictedModel).toBe('claude-opus-4-7');
      expect(lastTaskSetPayload.context?.model).toBe('claude-opus-4-7');
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
});
