import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockAccountsFindMany = mock(() => [] as any[]);
const mockAccountWorkspacesFindMany = mock(() => [] as any[]);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockHeartbeatsFindMany = mock(() => [] as any[]);
const mockWorkersFindMany = mock(() => [] as any[]);
const mockGetCachedOpenWorkspaceIds = mock(() => Promise.resolve(null));
const mockSetCachedOpenWorkspaceIds = mock(() => Promise.resolve());
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1']));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  hashApiKey: (key: string) => `hashed_${key}`,
}));

mock.module('@/lib/redis', () => ({
  getCachedOpenWorkspaceIds: mockGetCachedOpenWorkspaceIds,
  setCachedOpenWorkspaceIds: mockSetCachedOpenWorkspaceIds,
}));

mock.module('@/lib/team-access', () => ({
  getUserWorkspaceIds: mockGetUserWorkspaceIds,
  getUserTeamIds: mockGetUserTeamIds,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: mockAccountsFindFirst, findMany: mockAccountsFindMany },
      accountWorkspaces: { findMany: mockAccountWorkspacesFindMany },
      workspaces: { findMany: mockWorkspacesFindMany },
      workerHeartbeats: { findMany: mockHeartbeatsFindMany },
      workers: { findMany: mockWorkersFindMany },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  gt: (field: any, value: any) => ({ field, value, type: 'gt' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  accounts: { apiKey: 'apiKey', id: 'id', teamId: 'teamId' },
  accountWorkspaces: { accountId: 'accountId' },
  workers: { accountId: 'accountId', status: 'status' },
  workspaces: { id: 'id', teamId: 'teamId', accessMode: 'accessMode' },
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
    mockWorkersFindMany.mockReset();
    mockGetCachedOpenWorkspaceIds.mockReset();
    mockSetCachedOpenWorkspaceIds.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockGetUserTeamIds.mockReset();

    // Default mocks for Redis
    mockGetCachedOpenWorkspaceIds.mockResolvedValue(null);
    mockSetCachedOpenWorkspaceIds.mockResolvedValue(undefined);
    // Default mocks for team access
    mockGetUserWorkspaceIds.mockResolvedValue([]);
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    // Default: no active workers in DB
    mockWorkersFindMany.mockResolvedValue([]);
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
    mockGetUserWorkspaceIds.mockResolvedValue([]);
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
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    // Team workspaces query for names, then open workspaces in getWorkspaceIdsAndNames, then open workspaces during heartbeat filtering
    mockWorkspacesFindMany
      .mockResolvedValueOnce([{ id: 'ws-1', name: 'My Workspace' }]) // team workspace names
      .mockResolvedValueOnce([]) // open workspaces in getWorkspaceIdsAndNames
      .mockResolvedValueOnce([]); // open workspaces during heartbeat filtering
    mockAccountsFindMany.mockResolvedValue([]);
    // Mock accountWorkspaces for heartbeat filtering
    mockAccountWorkspacesFindMany.mockResolvedValue([
      { workspaceId: 'ws-1' },
    ]);

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
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkspacesFindMany
      .mockResolvedValueOnce([{ id: 'ws-1', name: 'Workspace 1' }]) // team workspace names
      .mockResolvedValueOnce([]) // open workspaces in getWorkspaceIdsAndNames
      .mockResolvedValueOnce([]); // open workspaces during heartbeat filtering
    mockAccountsFindMany.mockResolvedValue([]);
    // Mock accountWorkspaces for heartbeat filtering - returns different workspace
    mockAccountWorkspacesFindMany.mockResolvedValue([
      { workspaceId: 'ws-other' },
    ]);

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

  it('adjusts capacity using actual DB worker count when higher than heartbeat', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkspacesFindMany
      .mockResolvedValueOnce([{ id: 'ws-1', name: 'My Workspace' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockAccountsFindMany.mockResolvedValue([]);
    mockAccountWorkspacesFindMany.mockResolvedValue([
      { workspaceId: 'ws-1' },
    ]);

    mockHeartbeatsFindMany.mockResolvedValue([
      {
        localUiUrl: 'http://localhost:8766',
        viewerToken: 'token-1',
        accountId: 'account-1',
        maxConcurrentWorkers: 3,
        activeWorkerCount: 0, // Heartbeat says 0 active
        workspaceIds: ['ws-1'],
        lastHeartbeatAt: new Date(),
        account: { id: 'account-1', name: 'Runner', maxConcurrentWorkers: 3 },
      },
    ]);

    // DB shows 2 active workers (worker runner went offline without reporting)
    mockWorkersFindMany.mockResolvedValue([
      { accountId: 'account-1' },
      { accountId: 'account-1' },
    ]);

    const req = createMockRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activeLocalUis).toHaveLength(1);
    // Should use DB count (2) instead of heartbeat count (0)
    expect(data.activeLocalUis[0].activeWorkers).toBe(2);
    expect(data.activeLocalUis[0].capacity).toBe(1); // 3 - 2 = 1
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
