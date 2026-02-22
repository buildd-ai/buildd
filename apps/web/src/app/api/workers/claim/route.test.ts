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
const mockAccountsUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      workspaces: { findMany: mockWorkspacesFindMany },
      accountWorkspaces: { findMany: mockAccountWorkspacesFindMany },
      tasks: { findMany: mockTasksFindMany },
      workerHeartbeats: { findFirst: mockHeartbeatsFindFirst },
    },
    update: (table: any) => {
      if (table === 'workers') return mockWorkersUpdate();
      if (table === 'tasks') return mockTasksUpdate();
      if (table === 'accounts') return mockAccountsUpdate();
      return mockTasksUpdate();
    },
    insert: (table: any) => mockWorkersInsert(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  or: (...args: any[]) => ({ args, type: 'or' }),
  isNull: (field: any) => ({ field, type: 'isNull' }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  lt: (field: any, value: any) => ({ field, value, type: 'lt' }),
  gt: (field: any, value: any) => ({ field, value, type: 'gt' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  accounts: { id: 'id', activeSessions: 'activeSessions' },
  accountWorkspaces: { accountId: 'accountId', canClaim: 'canClaim', workspaceId: 'workspaceId' },
  tasks: { id: 'id', workspaceId: 'workspaceId', status: 'status', claimedBy: 'claimedBy', expiresAt: 'expiresAt', runnerPreference: 'runnerPreference', createdAt: 'createdAt', priority: 'priority' },
  workers: { id: 'id', accountId: 'accountId', status: 'status', updatedAt: 'updatedAt', taskId: 'taskId' },
  workerHeartbeats: { accountId: 'accountId', lastHeartbeatAt: 'lastHeartbeatAt' },
  workspaces: { id: 'id', accessMode: 'accessMode' },
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
    mockWorkersFindMany.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockAccountWorkspacesFindMany.mockReset();
    mockTasksFindMany.mockReset();
    mockHeartbeatsFindFirst.mockReset();

    // Default: no stale workers
    mockWorkersFindMany.mockResolvedValue([]);
    // Default: fresh heartbeat exists (runner is online)
    mockHeartbeatsFindFirst.mockResolvedValue({ id: 'hb-1' });
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

    // First findMany call (stale workers) returns empty
    // Second findMany call (active workers) returns 2
    mockWorkersFindMany
      .mockResolvedValueOnce([]) // stale workers
      .mockResolvedValueOnce([{ id: 'w1' }, { id: 'w2' }]); // active workers

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toBe('Max concurrent workers limit reached');
    expect(data.limit).toBe(2);
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

    // No stale workers, no active workers
    mockWorkersFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

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

    mockWorkersFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const req = createMockRequest({
      headers: { Authorization: 'Bearer bld_test' },
      body: { runner: 'test-runner' },
    });
    const res = await POST(req);

    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toBe('Max concurrent sessions limit reached');
  });

  it('returns empty workers when no accessible workspaces', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'account-1',
      maxConcurrentWorkers: 3,
      type: 'user',
      authType: 'api',
    });

    mockWorkersFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
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

    mockWorkersFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
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

    mockWorkersFindMany
      .mockResolvedValueOnce([])   // stale workers
      .mockResolvedValueOnce([]);  // active workers
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
    mockWorkersInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(() => [{
          id: 'worker-1',
          taskId: 'task-1',
          branch: 'buildd/test',
          status: 'idle',
        }]),
      })),
    });

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

    mockWorkersFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
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
});
