import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockAccountsFindMany = mock(() => [] as any[]);
const mockAccountWorkspacesFindMany = mock(() => [] as any[]);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockHeartbeatsFindMany = mock(() => [] as any[]);
const mockWorkersFindMany = mock(() => [] as any[]);
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1']));
const mockWorkspacesFindFirst = mock(() => null as any);
const mockLoadBrowserRunnerHeartbeats = mock(async (..._args: any[]) => null as any);

mock.module('@/lib/runner-heartbeats', () => ({
  loadBrowserRunnerHeartbeats: mockLoadBrowserRunnerHeartbeats,
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

const mockAuthenticateApiKey = mock(() => null as any);
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

const mockGetAccountWorkspacePermissions = mock(() => Promise.resolve([] as any[]));
mock.module('@/lib/account-workspace-cache', () => ({
  getAccountWorkspacePermissions: mockGetAccountWorkspacePermissions,
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
      workspaces: { findMany: mockWorkspacesFindMany, findFirst: mockWorkspacesFindFirst },
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
    mockAuthenticateApiKey.mockReset();
    mockGetAccountWorkspacePermissions.mockReset();
    mockAccountsFindFirst.mockReset();
    mockAccountsFindMany.mockReset();
    mockAccountWorkspacesFindMany.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockHeartbeatsFindMany.mockReset();
    mockWorkersFindMany.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockGetUserTeamIds.mockReset();

    // Default mocks
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetAccountWorkspacePermissions.mockResolvedValue([]);
    mockGetUserWorkspaceIds.mockResolvedValue([]);
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockWorkersFindMany.mockResolvedValue([]);
  });

  it('returns 401 when no auth', async () => {
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockGetCurrentUser.mockResolvedValue(null);

    const req = createMockRequest();
    const res = await GET(req);

    expect(res.status).toBe(401);
  });

  it('returns empty list when no workspaces', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue([]);
    mockWorkspacesFindMany.mockResolvedValue([]);
    mockAccountsFindMany.mockResolvedValue([]);

    const req = createMockRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activeLocalUis).toEqual([]);
  });

  it('returns active runner instances for session auth', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    // Team workspaces query for names, then open workspaces in getWorkspaceIdsAndNames, then open workspaces during heartbeat filtering
    mockWorkspacesFindMany
      .mockResolvedValueOnce([{ id: 'ws-1', name: 'My Workspace' }]) // team workspace names
      .mockResolvedValueOnce([]) // open workspaces in getWorkspaceIdsAndNames
      .mockResolvedValueOnce([]); // open workspaces during heartbeat filtering
    mockAccountsFindMany.mockResolvedValue([]);
    // Mock cached permissions for heartbeat filtering
    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
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
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkspacesFindMany
      .mockResolvedValueOnce([{ id: 'ws-1', name: 'Workspace 1' }]) // team workspace names
      .mockResolvedValueOnce([]) // open workspaces in getWorkspaceIdsAndNames
      .mockResolvedValueOnce([]); // open workspaces during heartbeat filtering
    mockAccountsFindMany.mockResolvedValue([]);
    // Mock cached permissions for heartbeat filtering - returns different workspace
    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-other', canClaim: true, canCreate: false },
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
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkspacesFindMany
      .mockResolvedValueOnce([{ id: 'ws-1', name: 'My Workspace' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockAccountsFindMany.mockResolvedValue([]);
    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
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

  it('includes environment in response when present', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkspacesFindMany
      .mockResolvedValueOnce([{ id: 'ws-1', name: 'Test WS' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
    ]);

    const environment = {
      tools: [{ name: 'node', version: '22.1.0' }, { name: 'docker' }],
      envKeys: ['DATABASE_URL', 'VERCEL_TOKEN'],
      mcp: ['slack'],
      labels: { type: 'local', os: 'darwin', arch: 'arm64', hostname: 'test-mac' },
      scannedAt: '2026-01-01T00:00:00.000Z',
    };

    mockHeartbeatsFindMany.mockResolvedValue([
      {
        localUiUrl: 'http://localhost:8766',
        viewerToken: 'token-1',
        accountId: 'account-1',
        maxConcurrentWorkers: 3,
        activeWorkerCount: 1,
        workspaceIds: ['ws-1'],
        environment,
        lastHeartbeatAt: new Date(),
        account: { id: 'account-1', name: 'Runner', maxConcurrentWorkers: 3 },
      },
    ]);

    const req = createMockRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activeLocalUis).toHaveLength(1);
    expect(data.activeLocalUis[0].environment).toEqual(environment);
  });

  it('returns null environment when not set on heartbeat', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkspacesFindMany
      .mockResolvedValueOnce([{ id: 'ws-1', name: 'Test WS' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
    ]);

    mockHeartbeatsFindMany.mockResolvedValue([
      {
        localUiUrl: 'http://localhost:8766',
        viewerToken: 'token-1',
        accountId: 'account-1',
        maxConcurrentWorkers: 3,
        activeWorkerCount: 0,
        workspaceIds: ['ws-1'],
        environment: null,
        lastHeartbeatAt: new Date(),
        account: { id: 'account-1', name: 'Runner', maxConcurrentWorkers: 3 },
      },
    ]);

    const req = createMockRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activeLocalUis[0].environment).toBeNull();
  });

  it('includes runnerCommit and runnerVersion in response when present', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkspacesFindMany
      .mockResolvedValueOnce([{ id: 'ws-1', name: 'Test WS' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
    ]);

    mockHeartbeatsFindMany.mockResolvedValue([
      {
        localUiUrl: 'http://localhost:8766',
        viewerToken: 'token-1',
        accountId: 'account-1',
        maxConcurrentWorkers: 3,
        activeWorkerCount: 1,
        workspaceIds: ['ws-1'],
        environment: null,
        runnerCommit: '5bfaeef',
        runnerVersion: '0.206.0',
        lastHeartbeatAt: new Date(),
        account: { id: 'account-1', name: 'Runner', maxConcurrentWorkers: 3 },
      },
    ]);

    const req = createMockRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activeLocalUis[0].runnerCommit).toBe('5bfaeef');
    expect(data.activeLocalUis[0].runnerVersion).toBe('0.206.0');
  });

  it('returns null runnerCommit/runnerVersion when not set on heartbeat (legacy runner)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkspacesFindMany
      .mockResolvedValueOnce([{ id: 'ws-1', name: 'Test WS' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
    ]);

    mockHeartbeatsFindMany.mockResolvedValue([
      {
        localUiUrl: 'http://localhost:8766',
        viewerToken: 'token-1',
        accountId: 'account-1',
        maxConcurrentWorkers: 3,
        activeWorkerCount: 0,
        workspaceIds: ['ws-1'],
        environment: null,
        runnerCommit: null,
        runnerVersion: null,
        lastHeartbeatAt: new Date(),
        account: { id: 'account-1', name: 'Runner', maxConcurrentWorkers: 3 },
      },
    ]);

    const req = createMockRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activeLocalUis[0].runnerCommit).toBeNull();
    expect(data.activeLocalUis[0].runnerVersion).toBeNull();
  });

  it('includes the runner update-snapshot fields and computes upToDateWithDeployed for a main-tracking runner', async () => {
    const originalSha = process.env.VERCEL_GIT_COMMIT_SHA;
    process.env.VERCEL_GIT_COMMIT_SHA = 'deployed-sha';
    try {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
      mockWorkspacesFindMany
        .mockResolvedValueOnce([{ id: 'ws-1', name: 'Test WS' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      mockGetAccountWorkspacePermissions.mockResolvedValue([
        { workspaceId: 'ws-1', canClaim: true, canCreate: false },
      ]);

      mockHeartbeatsFindMany.mockResolvedValue([
        {
          localUiUrl: 'http://localhost:8766',
          viewerToken: 'token-1',
          accountId: 'account-1',
          maxConcurrentWorkers: 3,
          activeWorkerCount: 1,
          workspaceIds: ['ws-1'],
          environment: null,
          currentCommit: 'deployed-sha',
          diskCommit: 'deployed-sha',
          commitDrift: false,
          updating: false,
          updateAvailable: false,
          trackedBranch: 'main',
          lastHeartbeatAt: new Date(),
          account: { id: 'account-1', name: 'Runner', maxConcurrentWorkers: 3 },
        },
      ]);

      const req = createMockRequest();
      const res = await GET(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      const row = data.activeLocalUis[0];
      expect(row.currentCommit).toBe('deployed-sha');
      expect(row.diskCommit).toBe('deployed-sha');
      expect(row.commitDrift).toBe(false);
      expect(row.updating).toBe(false);
      expect(row.updateAvailable).toBe(false);
      expect(row.trackedBranch).toBe('main');
      expect(row.upToDateWithDeployed).toBe(true);
    } finally {
      process.env.VERCEL_GIT_COMMIT_SHA = originalSha;
    }
  });

  it('reports upToDateWithDeployed: false for a main-tracking runner whose disk commit differs from the deployed sha', async () => {
    const originalSha = process.env.VERCEL_GIT_COMMIT_SHA;
    process.env.VERCEL_GIT_COMMIT_SHA = 'deployed-sha';
    try {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
      mockWorkspacesFindMany
        .mockResolvedValueOnce([{ id: 'ws-1', name: 'Test WS' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      mockGetAccountWorkspacePermissions.mockResolvedValue([
        { workspaceId: 'ws-1', canClaim: true, canCreate: false },
      ]);

      mockHeartbeatsFindMany.mockResolvedValue([
        {
          localUiUrl: 'http://localhost:8766',
          viewerToken: 'token-1',
          accountId: 'account-1',
          maxConcurrentWorkers: 3,
          activeWorkerCount: 1,
          workspaceIds: ['ws-1'],
          environment: null,
          currentCommit: 'stale-sha',
          diskCommit: 'stale-sha',
          commitDrift: false,
          updating: false,
          updateAvailable: true,
          trackedBranch: 'main',
          lastHeartbeatAt: new Date(),
          account: { id: 'account-1', name: 'Runner', maxConcurrentWorkers: 3 },
        },
      ]);

      const req = createMockRequest();
      const res = await GET(req);
      const data = await res.json();
      expect(data.activeLocalUis[0].upToDateWithDeployed).toBe(false);
    } finally {
      process.env.VERCEL_GIT_COMMIT_SHA = originalSha;
    }
  });

  it('reports upToDateWithDeployed: null for a dev-tracking runner (dev is never deployed)', async () => {
    const originalSha = process.env.VERCEL_GIT_COMMIT_SHA;
    process.env.VERCEL_GIT_COMMIT_SHA = 'deployed-sha';
    try {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
      mockWorkspacesFindMany
        .mockResolvedValueOnce([{ id: 'ws-1', name: 'Test WS' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      mockGetAccountWorkspacePermissions.mockResolvedValue([
        { workspaceId: 'ws-1', canClaim: true, canCreate: false },
      ]);

      mockHeartbeatsFindMany.mockResolvedValue([
        {
          localUiUrl: 'http://localhost:8766',
          viewerToken: 'token-1',
          accountId: 'account-1',
          maxConcurrentWorkers: 3,
          activeWorkerCount: 1,
          workspaceIds: ['ws-1'],
          environment: null,
          currentCommit: 'deployed-sha',
          diskCommit: 'deployed-sha',
          commitDrift: false,
          updating: false,
          updateAvailable: false,
          trackedBranch: 'dev',
          lastHeartbeatAt: new Date(),
          account: { id: 'account-1', name: 'Runner', maxConcurrentWorkers: 3 },
        },
      ]);

      const req = createMockRequest();
      const res = await GET(req);
      const data = await res.json();
      expect(data.activeLocalUis[0].upToDateWithDeployed).toBeNull();
    } finally {
      process.env.VERCEL_GIT_COMMIT_SHA = originalSha;
    }
  });

  it('passes through updateAvailableSince when the runner is behind', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkspacesFindMany
      .mockResolvedValueOnce([{ id: 'ws-1', name: 'Test WS' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
    ]);

    const since = new Date('2026-09-20T12:00:00.000Z');
    mockHeartbeatsFindMany.mockResolvedValue([
      {
        localUiUrl: 'http://localhost:8766',
        viewerToken: 'token-1',
        accountId: 'account-1',
        maxConcurrentWorkers: 3,
        activeWorkerCount: 1,
        workspaceIds: ['ws-1'],
        environment: null,
        currentCommit: 'stale-sha',
        diskCommit: 'stale-sha',
        commitDrift: false,
        updating: false,
        updateAvailable: true,
        updateAvailableSince: since,
        trackedBranch: 'main',
        lastHeartbeatAt: new Date(),
        account: { id: 'account-1', name: 'Runner', maxConcurrentWorkers: 3 },
      },
    ]);

    const req = createMockRequest();
    const res = await GET(req);
    const data = await res.json();
    expect(data.activeLocalUis[0].updateAvailableSince).toBe(since.toISOString());
  });

  it('returns nulls for the update-snapshot fields when absent (legacy runner)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkspacesFindMany
      .mockResolvedValueOnce([{ id: 'ws-1', name: 'Test WS' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
    ]);

    mockHeartbeatsFindMany.mockResolvedValue([
      {
        localUiUrl: 'http://localhost:8766',
        viewerToken: 'token-1',
        accountId: 'account-1',
        maxConcurrentWorkers: 3,
        activeWorkerCount: 0,
        workspaceIds: ['ws-1'],
        environment: null,
        currentCommit: null,
        diskCommit: null,
        commitDrift: null,
        updating: null,
        updateAvailable: null,
        updateAvailableSince: null,
        trackedBranch: null,
        lastHeartbeatAt: new Date(),
        account: { id: 'account-1', name: 'Runner', maxConcurrentWorkers: 3 },
      },
    ]);

    const req = createMockRequest();
    const res = await GET(req);
    const data = await res.json();
    const row = data.activeLocalUis[0];
    expect(row.currentCommit).toBeNull();
    expect(row.diskCommit).toBeNull();
    expect(row.commitDrift).toBeNull();
    expect(row.updating).toBeNull();
    expect(row.updateAvailable).toBeNull();
    expect(row.updateAvailableSince).toBeNull();
    expect(row.trackedBranch).toBeNull();
    expect(row.upToDateWithDeployed).toBeNull();
  });

  describe('open workspaces reach only their own team\'s runners (claim rule)', () => {
    const runner = (accountId: string, teamId: string, url: string) => ({
      localUiUrl: url, viewerToken: 't', accountId,
      maxConcurrentWorkers: 3, activeWorkerCount: 0, lastHeartbeatAt: new Date(),
      account: { id: accountId, name: `Runner ${accountId}`, maxConcurrentWorkers: 3, teamId },
    });

    it('hides a runner from another team whose only overlap is an open workspace', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockGetUserWorkspaceIds.mockResolvedValue(['ws-open']);
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-open', name: 'Open WS', teamId: 'team-1', accessMode: 'open' }]);
      mockGetAccountWorkspacePermissions.mockResolvedValue([]); // no explicit links
      mockHeartbeatsFindMany.mockResolvedValue([
        runner('acct-own', 'team-1', 'http://own'),
        runner('acct-foreign', 'team-2', 'http://foreign'),
      ]);

      const data = await (await GET(createMockRequest())).json();
      const urls = data.activeLocalUis.map((r: any) => r.localUiUrl);
      expect(urls).toEqual(['http://own']);
      expect(data.activeLocalUis[0].workspaceIds).toEqual(['ws-open']);
    });

    it('still shows another team\'s runner reaching the workspace through an explicit link', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockGetUserWorkspaceIds.mockResolvedValue(['ws-open']);
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-open', name: 'Open WS', teamId: 'team-1', accessMode: 'open' }]);
      mockGetAccountWorkspacePermissions.mockResolvedValue([{ workspaceId: 'ws-open', canClaim: true, canCreate: false }]);
      mockHeartbeatsFindMany.mockResolvedValue([runner('acct-foreign', 'team-2', 'http://foreign')]);

      const data = await (await GET(createMockRequest())).json();
      expect(data.activeLocalUis.map((r: any) => r.localUiUrl)).toEqual(['http://foreign']);
    });
  });

  describe('the caller\'s workspace list: open means open within the owning team', () => {
    // A tiny evaluator for the stubbed predicates above, so what the route
    // ASKS for decides what comes back, not a canned row list.
    const table = [
      { id: 'ws-a', name: 'A restricted', teamId: 'team-a', accessMode: 'restricted' },
      { id: 'ws-a-open', name: 'A open', teamId: 'team-a', accessMode: 'open' },
      { id: 'ws-b-open', name: 'B open', teamId: 'team-b', accessMode: 'open' },
    ];
    const matches = (row: any, w: any): boolean => {
      if (!w) return true;
      if (w.type === 'and') return w.args.filter(Boolean).every((a: any) => matches(row, a));
      if (w.type === 'eq') return row[w.field] === w.value;
      if (w.type === 'inArray') return w.values.includes(row[w.field]);
      throw new Error(`unexpected predicate ${w.type}`);
    };
    beforeEach(() => {
      mockWorkspacesFindMany.mockImplementation(async (args: any) => table.filter(r => matches(r, args?.where)));
      mockHeartbeatsFindMany.mockResolvedValue([]);
    });

    it('an API key sees its own team\'s open workspaces and not another team\'s', async () => {
      mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-a', teamId: 'team-a' });
      const ok = await GET(new NextRequest('http://localhost:3000/api/workers/active?workspaceId=ws-a-open', {
        headers: { authorization: 'Bearer bld_test' },
      }));
      expect(ok.status).toBe(200);
      const other = await GET(new NextRequest('http://localhost:3000/api/workers/active?workspaceId=ws-b-open', {
        headers: { authorization: 'Bearer bld_test' },
      }));
      expect(other.status).toBe(404);
      // The open-workspace read itself carries the team predicate.
      const openCall = mockWorkspacesFindMany.mock.calls
        .map((c: any) => c[0]?.where)
        .find((w: any) => w?.type === 'and' && w.args.some((a: any) => a?.type === 'eq' && a.field === 'accessMode'));
      expect(openCall.args).toContainEqual({ field: 'teamId', values: ['team-a'], type: 'inArray' });
    });

    it('an API key with no team reads no open workspaces at all', async () => {
      mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-x' });
      const res = await GET(new NextRequest('http://localhost:3000/api/workers/active?workspaceId=ws-b-open', {
        headers: { authorization: 'Bearer bld_test' },
      }));
      expect(res.status).toBe(404);
      expect(mockWorkspacesFindMany).not.toHaveBeenCalled();
    });

    it('a session user does not get another team\'s open workspace added to their list', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-a' });
      mockGetUserWorkspaceIds.mockResolvedValue(['ws-a', 'ws-a-open']);
      const res = await GET(new NextRequest('http://localhost:3000/api/workers/active?workspaceId=ws-b-open'));
      expect(res.status).toBe(404);
      const own = await GET(new NextRequest('http://localhost:3000/api/workers/active?workspaceId=ws-a-open'));
      expect(own.status).toBe(200);
    });
  });

  it('supports API key auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
    ]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', name: 'WS' }]);
    mockHeartbeatsFindMany.mockResolvedValue([]);

    const req = createMockRequest({ Authorization: 'Bearer bld_test' });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activeLocalUis).toEqual([]);
  });

  describe('browser capability', () => {
    const hb = (envKeys: string[] | null) => ({
      localUiUrl: 'http://localhost:8766', viewerToken: 't', accountId: 'account-1',
      maxConcurrentWorkers: 3, activeWorkerCount: 0, lastHeartbeatAt: new Date(),
      environment: envKeys ? { envKeys } : null,
      account: { id: 'account-1', name: 'Runner', maxConcurrentWorkers: 3 },
    });
    const session = () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', name: 'My Workspace' }]);
      mockGetAccountWorkspacePermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true, canCreate: false }]);
    };

    beforeEach(() => {
      mockWorkspacesFindFirst.mockReset();
      mockLoadBrowserRunnerHeartbeats.mockReset();
      mockLoadBrowserRunnerHeartbeats.mockResolvedValue(null);
    });

    it('marks each runner browser: true only when its env keys advertise it', async () => {
      session();
      mockHeartbeatsFindMany.mockResolvedValue([hb(['node', 'browser']), { ...hb(['node']), localUiUrl: 'http://b' }, { ...hb(null), localUiUrl: 'http://c' }]);
      const data = await (await GET(createMockRequest())).json();
      expect(data.activeLocalUis.map((r: any) => r.browser)).toEqual([true, false, false]);
      // No workspace asked: no per-workspace answer, no extra reads.
      expect(data.browserRunnerOnline).toBeUndefined();
      expect(mockLoadBrowserRunnerHeartbeats).not.toHaveBeenCalled();
    });

    it('with ?workspaceId answers browserRunnerOnline by the claim rule', async () => {
      session();
      mockHeartbeatsFindMany.mockResolvedValue([hb(['browser'])]);
      mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1', accessMode: 'restricted' });
      mockLoadBrowserRunnerHeartbeats.mockResolvedValue([{ lastHeartbeatAt: new Date(), environment: { envKeys: ['browser'] }, workspaceIds: ['ws-1'] }]);
      const req = new NextRequest('http://localhost:3000/api/workers/active?workspaceId=ws-1');
      const data = await (await GET(req)).json();
      expect(data.browserRunnerOnline).toBe(true);
      expect(data.workspace).toEqual({ id: 'ws-1', name: 'My Workspace' });
      expect(mockLoadBrowserRunnerHeartbeats.mock.calls[0][0]).toEqual({ id: 'ws-1', teamId: 'team-1', accessMode: 'restricted' });

      mockLoadBrowserRunnerHeartbeats.mockResolvedValue([{ lastHeartbeatAt: new Date(), environment: { envKeys: ['node'] }, workspaceIds: ['ws-1'] }]);
      expect((await (await GET(req)).json()).browserRunnerOnline).toBe(false);

      // Heartbeat lookup failed: unknown, never "no".
      mockLoadBrowserRunnerHeartbeats.mockResolvedValue(null);
      expect((await (await GET(req)).json()).browserRunnerOnline).toBeNull();
    });

    it('browserOnline per runner is the summary rule: fresh heartbeat within the online window and browser', async () => {
      session();
      const stale = { ...hb(['browser']), localUiUrl: 'http://stale', lastHeartbeatAt: new Date(Date.now() - 20 * 60 * 1000) };
      mockHeartbeatsFindMany.mockResolvedValue([hb(['browser']), stale, { ...hb(['node']), localUiUrl: 'http://b' }]);
      const data = await (await GET(createMockRequest())).json();
      const by = Object.fromEntries(data.activeLocalUis.map((r: any) => [r.localUiUrl, r]));
      expect(by['http://localhost:8766'].browserOnline).toBe(true);
      expect(by['http://stale'].browser).toBe(true);
      expect(by['http://stale'].browserOnline).toBe(false);
      expect(by['http://b'].browserOnline).toBe(false);
      expect(data.onlineWindowMs).toBe(3 * 60 * 1000);
    });

    it('with ?workspaceId, browserOnline also needs the claim reach the summary uses', async () => {
      session();
      mockHeartbeatsFindMany.mockResolvedValue([hb(['browser']), { ...hb(['browser']), accountId: 'account-2', localUiUrl: 'http://other' }]);
      mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1', accessMode: 'restricted' });
      mockLoadBrowserRunnerHeartbeats.mockResolvedValue([
        { accountId: 'account-1', lastHeartbeatAt: new Date(), environment: { envKeys: ['browser'] }, workspaceIds: [] },
        { accountId: 'account-2', lastHeartbeatAt: new Date(), environment: { envKeys: ['browser'] }, workspaceIds: ['ws-1'] },
      ]);
      const data = await (await GET(new NextRequest('http://localhost:3000/api/workers/active?workspaceId=ws-1'))).json();
      const by = Object.fromEntries(data.activeLocalUis.map((r: any) => [r.localUiUrl, r]));
      expect(by['http://localhost:8766'].browserOnline).toBe(false);
      expect(by['http://localhost:8766'].canClaimInWorkspace).toBe(false);
      expect(by['http://other'].browserOnline).toBe(true);
      expect(data.browserRunnerOnline).toBe(true);
    });

    it('404s a workspaceId the caller cannot see', async () => {
      session();
      mockHeartbeatsFindMany.mockResolvedValue([]);
      const res = await GET(new NextRequest('http://localhost:3000/api/workers/active?workspaceId=ws-other'));
      expect(res.status).toBe(404);
      expect(mockLoadBrowserRunnerHeartbeats).not.toHaveBeenCalled();
    });
  });

  describe('ephemeral --once runs (cloud containers)', () => {
    const session = () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
      mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', name: 'My Workspace' }]);
      mockGetAccountWorkspacePermissions.mockResolvedValue([{ workspaceId: 'ws-1', canClaim: true, canCreate: false }]);
    };
    const host = {
      localUiUrl: 'http://atlas.local:8766', viewerToken: 't', accountId: 'account-1',
      maxConcurrentWorkers: 4, activeWorkerCount: 0, lastHeartbeatAt: new Date(), environment: null,
      account: { id: 'account-1', name: 'Runner', maxConcurrentWorkers: 4 },
    };
    const cloud = (task: string, fleet: unknown = { executor: 'cloud', ephemeral: true, concurrency: 1, group: 'my-dispatcher' }) => ({
      ...host, localUiUrl: `headless://container/once/${task}`, maxConcurrentWorkers: 5, activeWorkerCount: 1,
      environment: { envKeys: [], labels: { hostname: 'container' }, ...(fleet ? { fleet } : {}) },
    });

    it('lists a running cloud run as one busy slot with its group, never as spare capacity', async () => {
      session();
      mockHeartbeatsFindMany.mockResolvedValue([host, cloud('a')]);
      mockWorkersFindMany.mockResolvedValue([
        { accountId: 'account-1', localUiUrl: 'headless://container/once/a' },
      ]);
      const data = await (await GET(createMockRequest())).json();
      const by = Object.fromEntries(data.activeLocalUis.map((r: any) => [r.localUiUrl, r]));
      const run = by['headless://container/once/a'];
      expect(run).toMatchObject({ maxConcurrent: 1, activeWorkers: 1, capacity: 0 });
      expect(run.fleet).toEqual({ executor: 'cloud', ephemeral: true, concurrency: 1, group: 'my-dispatcher' });
      // The host runner is unchanged, and its live count is not inflated by the cloud run's worker.
      expect(by['http://atlas.local:8766']).toMatchObject({ maxConcurrent: 4, capacity: 4, activeWorkers: 0 });
      expect(by['http://atlas.local:8766'].fleet).toBeNull();
    });

    it('drops a finished cloud run (fresh heartbeat, nothing running) so no picker targets a dead container', async () => {
      session();
      mockHeartbeatsFindMany.mockResolvedValue([host, cloud('done', null), cloud('done2')]);
      mockWorkersFindMany.mockResolvedValue([]);
      const data = await (await GET(createMockRequest())).json();
      expect(data.activeLocalUis.map((r: any) => r.localUiUrl)).toEqual(['http://atlas.local:8766']);
    });
  });
});
