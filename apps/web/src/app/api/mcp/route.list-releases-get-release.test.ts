/**
 * Tests for list_releases and get_release MCP actions.
 *
 * Both are handled inline in route.ts (like list_connectors) because they need
 * direct DB access at worker token level without a dedicated REST route.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEAM_ID      = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OTHER_TEAM   = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const RELEASE_ID_1 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const RELEASE_ID_2 = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const TASK_ID_1    = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const MISSION_ID   = '11111111-1111-1111-1111-111111111111';

// ── Mocks must be declared before import ─────────────────────────────────────

const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null as any));
const mockReleasesFindFirst = mock(() => Promise.resolve(null as any));
const mockTeamsFindFirst = mock(() => Promise.resolve(null as any));
const mockWorkersFindFirst = mock(() => Promise.resolve(null as any));
const mockTasksFindFirst = mock(() => Promise.resolve(null as any));

const mockDbSelect = mock(() => null as any);

const mockResolveWorkspace = mock(() => Promise.resolve(null as any));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/workspace-resolver', () => ({
  resolveWorkspace: mockResolveWorkspace,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces:  { findFirst: mockWorkspacesFindFirst },
      teams:       { findFirst: mockTeamsFindFirst },
      workers:     { findFirst: mockWorkersFindFirst },
      tasks:       { findFirst: mockTasksFindFirst },
      releases:    { findFirst: mockReleasesFindFirst },
      connectors:  { findMany: mock(() => Promise.resolve([])) },
      connectorShares: { findMany: mock(() => Promise.resolve([])) },
      connectorWorkspaces: { findMany: mock(() => Promise.resolve([])) },
      secrets:     { findMany: mock(() => Promise.resolve([])) },
    },
    update: mock(() => ({ set: mock(() => ({ where: mock(() => ({ returning: mock(() => Promise.resolve([])) })) })) })),
    insert: mock(() => ({ values: mock(() => Promise.resolve([])) })),
    // Chainable select builder used by list_releases and get_release
    select: mockDbSelect,
  },
}));

mock.module('@buildd/core/path-claim', () => ({
  checkPathClaimConflict: mock(async () => null),
  insertClaims: mock(async () => []),
  registerWaiter: mock(async () => ({ registered: true })),
}));

mock.module('@buildd/core/knowledge-store', () => ({
  PgVectorStore: class {
    upsert() { return Promise.resolve([]); }
    search() { return Promise.resolve([]); }
  },
  getVoyageEmbedder: () => null,
  getVoyageReranker: () => null,
}));

mock.module('@buildd/core/memory-client', () => ({
  MemoryClient: class {
    getContext() { return Promise.resolve({ markdown: '' }); }
  },
}));

mock.module('@buildd/core/mcp-tools', () => ({
  handleBuilddAction: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  handleMemoryAction: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  handleRecallAction: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  handleLearnAction:  async () => ({ content: [{ type: 'text', text: '{}' }] }),
  triggerActions: [],
  workerActions: ['list_releases', 'get_release'],
  adminActions: [],
  allActions: ['list_releases', 'get_release'],
  memoryActions: [],
  buildToolDescription:  () => 'description',
  buildParamsDescription: () => 'params',
  buildMemoryDescription: () => 'memory',
}));

import { POST } from './route';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRelease(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    archetype: 'continuous',
    unit: null,
    strategy: 'branch_merge',
    sourceRef: 'dev',
    targetRef: 'main',
    headSha: 'abc123',
    previousSha: 'def456',
    version: null,
    state: 'healthy',
    verificationStrategy: 'none',
    dispatchedAt: null,
    deployedAt: null,
    healthyAt: null,
    runUrl: null,
    deployUrl: null,
    triggeredBy: 'agent',
    failureReason: null,
    ciStateAtDispatch: null,
    commitsAheadAtDispatch: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/**
 * Build a chainable drizzle select mock that supports:
 * .select().from().where().orderBy().limit() → returns finalValue
 * .select().from().leftJoin().where() → returns finalValue
 */
function makeSelectChain(finalValue: unknown[]) {
  const chain: any = {
    from:     () => chain,
    where:    () => chain,
    orderBy:  () => chain,
    limit:    () => Promise.resolve(finalValue),
    leftJoin: () => chain,
    // For .select({ ... }).from().where() → Promise (used in get_release edges)
    then: (resolve: any) => Promise.resolve(finalValue).then(resolve),
  };
  return chain;
}

function makeMcpRequest(action: string, params: Record<string, unknown>, workspaceParam = WORKSPACE_ID) {
  const wsQuery = workspaceParam ? `?workspace=${workspaceParam}` : '';
  return new Request(`http://localhost/api/mcp${wsQuery}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer bld_test',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'buildd', arguments: { action, params } },
    }),
  });
}

async function callAction(action: string, params: Record<string, unknown> = {}, workspaceParam = WORKSPACE_ID): Promise<any> {
  const res = await POST(makeMcpRequest(action, params, workspaceParam));
  const body = await res.json();
  const text = body?.result?.content?.[0]?.text;
  try { return JSON.parse(text); } catch { return text; }
}

// ── list_releases tests ────────────────────────────────────────────────────────

describe('list_releases MCP action', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockReleasesFindFirst.mockReset();
    mockTeamsFindFirst.mockReset();
    mockWorkersFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockDbSelect.mockReset();
    mockResolveWorkspace.mockReset();

    mockAuthenticateApiKey.mockResolvedValue({
      id: 'acc-1', level: 'worker', teamId: TEAM_ID, authType: 'api',
    });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: TEAM_ID });
  });

  it('returns releases for a workspace', async () => {
    const r1 = makeRelease(RELEASE_ID_1);
    const r2 = makeRelease(RELEASE_ID_2, { state: 'failed' });
    mockDbSelect.mockReturnValue(makeSelectChain([r1, r2]));

    const data = await callAction('list_releases', {});
    expect(data.releases).toHaveLength(2);
    expect(data.releases[0].id).toBe(RELEASE_ID_1);
  });

  it('applies state filter', async () => {
    const r = makeRelease(RELEASE_ID_1, { state: 'healthy' });
    mockDbSelect.mockReturnValue(makeSelectChain([r]));

    const data = await callAction('list_releases', { state: 'healthy' });
    expect(data.releases).toHaveLength(1);
    expect(data.releases[0].state).toBe('healthy');
  });

  it('returns empty array when workspace has no releases', async () => {
    mockDbSelect.mockReturnValue(makeSelectChain([]));

    const data = await callAction('list_releases', {});
    expect(data.releases).toHaveLength(0);
  });

  it('scopes results via missionId join', async () => {
    const r = makeRelease(RELEASE_ID_1);

    let callCount = 0;
    mockDbSelect.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // tasks query
        return makeSelectChain([{ id: TASK_ID_1 }]);
      }
      if (callCount === 2) {
        // releaseTasks query
        return makeSelectChain([{ releaseId: RELEASE_ID_1 }]);
      }
      // releases query
      return makeSelectChain([r]);
    });

    const data = await callAction('list_releases', { missionId: MISSION_ID });
    expect(data.releases).toHaveLength(1);
    expect(data.releases[0].id).toBe(RELEASE_ID_1);
  });

  it('returns empty array when missionId has no tasks', async () => {
    mockDbSelect.mockReturnValue(makeSelectChain([])); // tasks query returns empty

    const data = await callAction('list_releases', { missionId: MISSION_ID });
    expect(data.releases).toEqual([]);
  });

  it('returns empty array when mission tasks have no release edges', async () => {
    let callCount = 0;
    mockDbSelect.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return makeSelectChain([{ id: TASK_ID_1 }]); // tasks
      return makeSelectChain([]); // releaseTasks → empty
    });

    const data = await callAction('list_releases', { missionId: MISSION_ID });
    expect(data.releases).toEqual([]);
  });

  it('returns workspace_required when workspace cannot be resolved', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(null);
    const data = await callAction('list_releases', {}, '');
    expect(data.error).toBe('workspace_required');
  });

  it('returns workspace_not_found when workspace row is missing', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(null);
    // workspace param is set but query returns null
    const data = await callAction('list_releases', {});
    expect(data.error).toBe('workspace_not_found');
  });

  it('returns forbidden when account team does not own the workspace', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'acc-2', level: 'worker', teamId: OTHER_TEAM, authType: 'api',
    });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: TEAM_ID });

    const data = await callAction('list_releases', {});
    expect(data.error).toBe('forbidden');
  });
});

// ── get_release tests ─────────────────────────────────────────────────────────

describe('get_release MCP action', () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockReleasesFindFirst.mockReset();
    mockTeamsFindFirst.mockReset();
    mockWorkersFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockDbSelect.mockReset();
    mockResolveWorkspace.mockReset();

    mockAuthenticateApiKey.mockResolvedValue({
      id: 'acc-1', level: 'worker', teamId: TEAM_ID, authType: 'api',
    });
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: TEAM_ID });
  });

  it('returns release with task edges', async () => {
    const release = makeRelease(RELEASE_ID_1);
    mockReleasesFindFirst.mockResolvedValue(release);
    const edges = [
      {
        taskId: TASK_ID_1,
        prNumber: 42,
        commitSha: 'abc123',
        taskTitle: 'Fix something',
        taskStatus: 'completed',
        missionId: MISSION_ID,
      },
    ];
    mockDbSelect.mockReturnValue(makeSelectChain(edges));

    const data = await callAction('get_release', { releaseId: RELEASE_ID_1 });
    expect(data.id).toBe(RELEASE_ID_1);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].prNumber).toBe(42);
    expect(data.tasks[0].taskTitle).toBe('Fix something');
    expect(data.tasks[0].missionId).toBe(MISSION_ID);
  });

  it('returns release with empty tasks array when no edges exist', async () => {
    const release = makeRelease(RELEASE_ID_1);
    mockReleasesFindFirst.mockResolvedValue(release);
    mockDbSelect.mockReturnValue(makeSelectChain([]));

    const data = await callAction('get_release', { releaseId: RELEASE_ID_1 });
    expect(data.id).toBe(RELEASE_ID_1);
    expect(data.tasks).toHaveLength(0);
  });

  it('returns not_found for unknown releaseId', async () => {
    mockReleasesFindFirst.mockResolvedValue(null);

    const data = await callAction('get_release', { releaseId: 'nonexistent-id' });
    expect(data.error).toBe('not_found');
  });

  it('returns releaseId_required when releaseId is missing', async () => {
    const data = await callAction('get_release', {});
    expect(data.error).toBe('releaseId_required');
  });

  it('returns forbidden when account team does not own the release workspace', async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      id: 'acc-2', level: 'worker', teamId: OTHER_TEAM, authType: 'api',
    });
    mockReleasesFindFirst.mockResolvedValue(makeRelease(RELEASE_ID_1));
    mockWorkspacesFindFirst.mockResolvedValue({ teamId: TEAM_ID });

    const data = await callAction('get_release', { releaseId: RELEASE_ID_1 });
    expect(data.error).toBe('forbidden');
  });
});
