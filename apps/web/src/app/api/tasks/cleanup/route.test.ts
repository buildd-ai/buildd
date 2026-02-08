import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindMany = mock(() => [] as any[]);
const mockTasksFindMany = mock(() => [] as any[]);
const mockWorkersUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockTasksUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockHeartbeatsDelete = mock(() => ({
  where: mock(() => ({
    returning: mock(() => []),
  })),
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      tasks: { findMany: mockTasksFindMany },
    },
    update: (table: any) => {
      if (table === 'workers') return mockWorkersUpdate();
      return mockTasksUpdate();
    },
    delete: () => mockHeartbeatsDelete(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  lt: (field: any, value: any) => ({ field, value, type: 'lt' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers',
  tasks: 'tasks',
  workerHeartbeats: { id: 'id', lastHeartbeatAt: 'lastHeartbeatAt' },
}));

import { POST } from './route';

function createMockRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/tasks/cleanup', {
    method: 'POST',
    headers: new Headers(headers),
  });
}

describe('POST /api/tasks/cleanup', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindMany.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockHeartbeatsDelete.mockReset();

    // Default mock chains
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
    mockHeartbeatsDelete.mockReturnValue({
      where: mock(() => ({
        returning: mock(() => []),
      })),
    });
  });

  it('returns 401 when no session and no admin token', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest();
    const res = await POST(req);

    expect(res.status).toBe(401);
  });

  it('returns 401 when API key is worker level', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', level: 'worker' });

    const req = createMockRequest({ Authorization: 'Bearer bld_test' });
    const res = await POST(req);

    expect(res.status).toBe(401);
  });

  it('allows session auth', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockWorkersFindMany.mockResolvedValue([]);
    mockTasksFindMany.mockResolvedValue([]);

    const req = createMockRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cleaned).toBeDefined();
  });

  it('allows admin API token', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', level: 'admin' });
    mockWorkersFindMany.mockResolvedValue([]);
    mockTasksFindMany.mockResolvedValue([]);

    const req = createMockRequest({ Authorization: 'Bearer bld_admin' });
    const res = await POST(req);

    expect(res.status).toBe(200);
  });

  it('returns cleanup counts when nothing to clean', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockWorkersFindMany.mockResolvedValue([]); // No stalled workers
    mockTasksFindMany.mockResolvedValue([]); // No orphaned tasks

    const req = createMockRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cleaned.stalledWorkers).toBe(0);
    expect(data.cleaned.orphanedTasks).toBe(0);
    expect(data.cleaned.expiredPlans).toBe(0);
    expect(data.cleaned.staleHeartbeats).toBe(0);
  });

  it('cleans up stalled workers', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);

    // First findMany: stalled running workers
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'w1', status: 'running', updatedAt: new Date(0) },
        { id: 'w2', status: 'starting', updatedAt: new Date(0) },
      ])
      // Second findMany: expired plan workers
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([]);

    const req = createMockRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cleaned.stalledWorkers).toBe(2);
  });
});
