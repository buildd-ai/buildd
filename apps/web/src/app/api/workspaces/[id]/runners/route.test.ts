import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));

const mockWorkspacesFindFirst = mock(() => null as any);
const mockAccountWorkspacesFindFirst = mock(() => null as any);
const mockWorkerHeartbeatsFindMany = mock(() => [] as any[]);

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));

// Capture the where clause passed to accountWorkspaces.findFirst so we can assert it
let lastAccountWorkspacesWhere: any = null;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      accountWorkspaces: {
        findFirst: (opts: any) => {
          lastAccountWorkspacesWhere = opts?.where;
          return mockAccountWorkspacesFindFirst(opts);
        },
      },
      workerHeartbeats: { findMany: mockWorkerHeartbeatsFindMany },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  gt: (field: any, value: any) => ({ field, value, type: 'gt' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'workspaces.id', accessMode: 'workspaces.accessMode' },
  accountWorkspaces: {
    accountId: 'accountWorkspaces.accountId',
    workspaceId: 'accountWorkspaces.workspaceId',
  },
  workerHeartbeats: {
    accountId: 'workerHeartbeats.accountId',
    lastHeartbeatAt: 'workerHeartbeats.lastHeartbeatAt',
  },
}));

import { GET } from './route';

const WS_ID = 'workspace-A';

function makeRequest(): NextRequest {
  return new NextRequest(`http://localhost:3000/api/workspaces/${WS_ID}/runners`);
}

describe('GET /api/workspaces/[id]/runners', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockAccountWorkspacesFindFirst.mockReset();
    mockWorkerHeartbeatsFindMany.mockReset();
    lastAccountWorkspacesWhere = null;
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(makeRequest(), { params: Promise.resolve({ id: WS_ID }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 when user has no workspace access', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    const res = await GET(makeRequest(), { params: Promise.resolve({ id: WS_ID }) });
    expect(res.status).toBe(404);
  });

  it('returns empty runners list when no recent heartbeats exist', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ id: WS_ID });
    mockWorkspacesFindFirst.mockResolvedValue({ accessMode: 'restricted' });
    mockWorkerHeartbeatsFindMany.mockResolvedValue([]);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: WS_ID }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.runners).toEqual([]);
  });

  it('excludes runners from accounts linked to a different workspace (regression: wrong findFirst filter)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ id: WS_ID });
    mockWorkspacesFindFirst.mockResolvedValue({ accessMode: 'restricted' });

    // Account abc is linked to workspace-B, not workspace-A
    mockWorkerHeartbeatsFindMany.mockResolvedValue([
      {
        id: 'hb-1',
        accountId: 'account-abc',
        lastHeartbeatAt: new Date(),
        maxConcurrentWorkers: 2,
        activeWorkerCount: 0,
        localUiUrl: null,
        environment: null,
        account: { id: 'account-abc', name: 'Other Runner', type: 'service' },
      },
    ]);

    // accountWorkspaces.findFirst returns null — account not linked to THIS workspace
    mockAccountWorkspacesFindFirst.mockResolvedValue(null);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: WS_ID }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.runners).toHaveLength(0);
  });

  it('includes runners from accounts correctly linked to this workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ id: WS_ID });
    mockWorkspacesFindFirst.mockResolvedValue({ accessMode: 'restricted' });

    mockWorkerHeartbeatsFindMany.mockResolvedValue([
      {
        id: 'hb-2',
        accountId: 'account-xyz',
        lastHeartbeatAt: new Date(),
        maxConcurrentWorkers: 4,
        activeWorkerCount: 1,
        localUiUrl: null,
        environment: null,
        account: { id: 'account-xyz', name: 'My Runner', type: 'service' },
      },
    ]);

    // accountWorkspaces.findFirst returns a row — account IS linked to this workspace
    mockAccountWorkspacesFindFirst.mockResolvedValue({ workspaceId: WS_ID });

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: WS_ID }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.runners).toHaveLength(1);
    expect(body.runners[0].accountName).toBe('My Runner');
    expect(body.runners[0].capacity).toBe(3);
  });

  it('includes runners for open-access workspaces even without explicit account link', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ id: WS_ID });
    mockWorkspacesFindFirst.mockResolvedValue({ accessMode: 'open' });

    mockWorkerHeartbeatsFindMany.mockResolvedValue([
      {
        id: 'hb-3',
        accountId: 'account-open',
        lastHeartbeatAt: new Date(),
        maxConcurrentWorkers: 2,
        activeWorkerCount: 0,
        localUiUrl: null,
        environment: null,
        account: { id: 'account-open', name: 'Open Runner', type: 'user' },
      },
    ]);

    // Not linked, but workspace is open
    mockAccountWorkspacesFindFirst.mockResolvedValue(null);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: WS_ID }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.runners).toHaveLength(1);
    expect(body.runners[0].accountName).toBe('Open Runner');
  });

  it('passes both accountId and workspaceId to accountWorkspaces.findFirst query', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockVerifyWorkspaceAccess.mockResolvedValue({ id: WS_ID });
    mockWorkspacesFindFirst.mockResolvedValue({ accessMode: 'restricted' });

    mockWorkerHeartbeatsFindMany.mockResolvedValue([
      {
        id: 'hb-4',
        accountId: 'account-check',
        lastHeartbeatAt: new Date(),
        maxConcurrentWorkers: 1,
        activeWorkerCount: 0,
        localUiUrl: null,
        environment: null,
        account: { id: 'account-check', name: 'Check Runner', type: 'action' },
      },
    ]);

    mockAccountWorkspacesFindFirst.mockResolvedValue(null);

    await GET(makeRequest(), { params: Promise.resolve({ id: WS_ID }) });

    // The where clause should be an `and(...)` combining both accountId and workspaceId filters
    expect(lastAccountWorkspacesWhere).not.toBeNull();
    expect(lastAccountWorkspacesWhere.type).toBe('and');
    const args: any[] = lastAccountWorkspacesWhere.args;
    const accountIdFilter = args.find((a: any) => a.value === 'account-check');
    const workspaceIdFilter = args.find((a: any) => a.value === WS_ID);
    expect(accountIdFilter).toBeDefined();
    expect(workspaceIdFilter).toBeDefined();
  });
});
