import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// --- Mocks ---

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockTasksFindMany = mock(() => [] as any[]);
const mockTasksUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockTasksDelete = mock(() => ({
  where: mock(() => Promise.resolve()),
}));
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockGetAccountWorkspacePermissions = mock(() => Promise.resolve([] as any[]));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/team-access', () => ({
  getUserWorkspaceIds: mockGetUserWorkspaceIds,
  verifyAccountWorkspaceAccess: mock(() => Promise.resolve(true)),
}));

mock.module('@/lib/account-workspace-cache', () => ({
  getAccountWorkspacePermissions: mockGetAccountWorkspacePermissions,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findMany: mockTasksFindMany },
    },
    update: () => mockTasksUpdate(),
    delete: () => mockTasksDelete(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  lt: (field: any, value: any) => ({ field, value, type: 'lt' }),
  not: (arg: any) => ({ arg, type: 'not' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id', status: 'status', workspaceId: 'workspaceId', missionId: 'missionId', createdAt: 'createdAt', result: 'result' },
}));

import { POST } from './route';

function createMockRequest(body: any, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/tasks/bulk', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    body: JSON.stringify(body),
  });
}

describe('POST /api/tasks/bulk', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockTasksFindMany.mockReset();
    mockTasksUpdate.mockReset();
    mockTasksDelete.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockGetAccountWorkspacePermissions.mockReset();

    // Default mock chains
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
    mockTasksDelete.mockReturnValue({
      where: mock(() => Promise.resolve()),
    });
  });

  it('returns 401 when no auth provided', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest({ action: 'cancel' });
    const res = await POST(req);

    expect(res.status).toBe(401);
  });

  it('returns 401 when API key is worker level (not admin)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', level: 'worker' });

    const req = createMockRequest({ action: 'cancel' }, { Authorization: 'Bearer bld_test' });
    const res = await POST(req);

    expect(res.status).toBe(401);
  });

  it('returns 400 when action is missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);

    const req = createMockRequest({});
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it('returns 400 when trying to bulk-modify in_progress tasks', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);

    const req = createMockRequest({ action: 'cancel', status: 'in_progress' });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('in_progress');
  });

  it('returns dry run results without modifying data', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockTasksFindMany.mockResolvedValue([
      { id: 'task-1', status: 'pending' },
      { id: 'task-2', status: 'pending' },
    ]);

    const req = createMockRequest({ action: 'cancel', status: 'pending', dryRun: true });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.affected).toBe(2);
    expect(data.taskIds).toEqual(['task-1', 'task-2']);
    expect(data.dryRun).toBe(true);
  });

  it('cancels matching tasks by setting status to failed', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockTasksFindMany.mockResolvedValue([
      { id: 'task-1', status: 'pending' },
    ]);

    const req = createMockRequest({ action: 'cancel', status: 'pending' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.affected).toBe(1);
    expect(data.dryRun).toBe(false);
  });

  it('deletes matching tasks', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockTasksFindMany.mockResolvedValue([
      { id: 'task-old', status: 'failed' },
    ]);

    const req = createMockRequest({ action: 'delete', status: 'failed', olderThanHours: 48 });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.affected).toBe(1);
    expect(data.dryRun).toBe(false);
  });

  it('returns 0 affected when no workspaces accessible', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue([]);

    const req = createMockRequest({ action: 'cancel' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.affected).toBe(0);
  });

  it('allows admin API key auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1', level: 'admin' });
    mockGetAccountWorkspacePermissions.mockResolvedValue([{ workspaceId: 'ws-1' }]);
    mockTasksFindMany.mockResolvedValue([]);

    const req = createMockRequest({ action: 'cancel' }, { Authorization: 'Bearer bld_admin' });
    const res = await POST(req);

    expect(res.status).toBe(200);
  });
});
