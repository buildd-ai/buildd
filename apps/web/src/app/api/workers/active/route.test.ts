import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockAccountsFindMany = mock(() => [] as any[]);
const mockAccountWorkspacesFindMany = mock(() => [] as any[]);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockHeartbeatsFindMany = mock(() => [] as any[]);

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  hashApiKey: (key: string) => `hashed_${key}`,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: mockAccountsFindFirst, findMany: mockAccountsFindMany },
      accountWorkspaces: { findMany: mockAccountWorkspacesFindMany },
      workspaces: { findMany: mockWorkspacesFindMany },
      workerHeartbeats: { findMany: mockHeartbeatsFindMany },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  gt: (field: any, value: any) => ({ field, value, type: 'gt' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  accounts: { apiKey: 'apiKey', id: 'id', ownerId: 'ownerId' },
  accountWorkspaces: { accountId: 'accountId' },
  workspaces: { id: 'id', ownerId: 'ownerId', accessMode: 'accessMode' },
  workerHeartbeats: { lastHeartbeatAt: 'lastHeartbeatAt' },
}));

import { GET } from './route';

function createMockRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/workers/active', {
    method: 'GET',
    headers: new Headers(headers),
  });
}

describe('GET /api/workers/active', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockAccountsFindMany.mockReset();
    mockAccountWorkspacesFindMany.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockHeartbeatsFindMany.mockReset();
  });

  it('returns 401 when no auth', async () => {
    mockAccountsFindFirst.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);

    const req = createMockRequest();
    const res = await GET(req);

    expect(res.status).toBe(401);
  });

  it('returns empty list when no workspaces', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockWorkspacesFindMany.mockResolvedValue([]);
    mockAccountsFindMany.mockResolvedValue([]);

    const req = createMockRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activeLocalUis).toEqual([]);
  });

  it('returns active local-ui instances for session auth', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAccountsFindFirst.mockResolvedValue(null);
    // Owned workspaces
    mockWorkspacesFindMany
      .mockResolvedValueOnce([{ id: 'ws-1', name: 'My Workspace' }]) // owned
      .mockResolvedValueOnce([]); // open
    mockAccountsFindMany.mockResolvedValue([]);

    mockHeartbeatsFindMany.mockResolvedValue([
      {
        localUiUrl: 'http://localhost:8766',
        viewerToken: 'token-1',
        accountId: 'account-1',
        maxConcurrentWorkers: 3,
        activeWorkerCount: 1,
        workspaceIds: ['ws-1'],
        lastHeartbeatAt: new Date(),
        account: { id: 'account-1', name: 'Runner', maxConcurrentWorkers: 3 },
      },
    ]);

    const req = createMockRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activeLocalUis).toHaveLength(1);
    expect(data.activeLocalUis[0].localUiUrl).toBe('http://localhost:8766');
    expect(data.activeLocalUis[0].capacity).toBe(2);
  });

  it('filters heartbeats with no overlapping workspaces', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockWorkspacesFindMany
      .mockResolvedValueOnce([{ id: 'ws-1', name: 'Workspace 1' }])
      .mockResolvedValueOnce([]);
    mockAccountsFindMany.mockResolvedValue([]);

    mockHeartbeatsFindMany.mockResolvedValue([
      {
        localUiUrl: 'http://localhost:8766',
        viewerToken: 'token-1',
        accountId: 'account-1',
        maxConcurrentWorkers: 3,
        activeWorkerCount: 0,
        workspaceIds: ['ws-other'], // No overlap
        lastHeartbeatAt: new Date(),
        account: { id: 'account-1', name: 'Runner', maxConcurrentWorkers: 3 },
      },
    ]);

    const req = createMockRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activeLocalUis).toHaveLength(0);
  });

  it('supports API key auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-1' });
    mockAccountWorkspacesFindMany.mockResolvedValue([
      { workspace: { id: 'ws-1', name: 'WS' } },
    ]);
    mockWorkspacesFindMany.mockResolvedValue([]);
    mockHeartbeatsFindMany.mockResolvedValue([]);

    const req = createMockRequest({ Authorization: 'Bearer bld_test' });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activeLocalUis).toEqual([]);
  });
});
