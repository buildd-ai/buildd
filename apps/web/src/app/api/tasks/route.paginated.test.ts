/**
 * Tests for the paginated lean path of GET /api/tasks (?limit=N).
 * Separate file so the db.select() chain mock doesn't collide with
 * the existing route.test.ts that mocks db.query only.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';

// ── Mock helpers ──────────────────────────────────────────────────────────────

const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockGetAccountWorkspacePermissions = mock(() => Promise.resolve([] as any[]));
const mockGetUserWorkspaceIds = mock(() => Promise.resolve(['ws-1'] as string[]));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockTasksFindMany = mock(() => [] as any[]);
const mockTasksFindFirst = mock(() => null as any);
const mockMissionsFindFirst = mock(() => null as any);
const mockWorkspaceSkillsFindFirst = mock(() => null as any);
const mockTasksInsert = mock(() => ({ values: mock(() => ({ returning: mock(() => []) })) }));
const mockTasksUpdate = mock(() => ({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) }));

// Lean select results: [countsResult, leanRows]
let mockSelectResult: any[] = [{ total: 0, pendingCount: 0 }];
let mockSelectRowsResult: any[] = [];
let selectCallIndex = 0;

function makeSelectChain(result: () => any[]) {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    offset: () => chain,
    then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject),
    catch: (fn: any) => Promise.resolve(result()).catch(fn),
  };
  return chain;
}

const mockDbSelect = mock((_cols?: any) => {
  const idx = selectCallIndex++;
  // First select call in Promise.all is the counts query
  if (idx % 2 === 0) return makeSelectChain(() => mockSelectResult);
  return makeSelectChain(() => mockSelectRowsResult);
});

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: async (key: string | null) => key ? mockAccountsFindFirst() : null,
  hashApiKey: (k: string) => `hashed_${k}`,
  extractApiKeyPrefix: (k: string) => k.substring(0, 12),
}));
mock.module('@/lib/account-workspace-cache', () => ({
  getAccountWorkspacePermissions: mockGetAccountWorkspacePermissions,
}));
mock.module('@/lib/team-access', () => ({
  getUserWorkspaceIds: mockGetUserWorkspaceIds,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));
mock.module('@/lib/task-service', () => ({
  resolveCreatorContext: mock(() => Promise.resolve({ createdByAccountId: null, createdByWorkerId: null, creationSource: 'api', parentTaskId: null })),
}));
mock.module('@/lib/task-dispatch', () => ({ dispatchNewTask: mock(() => Promise.resolve()) }));
mock.module('@/lib/workspace-resolver', () => ({
  resolveWorkspace: mock(() => null),
  autoResolveAccountWorkspace: mock(() => Promise.resolve({ workspaceId: 'ws-1' })),
}));
mock.module('@/lib/pusher', () => ({
  triggerEvent: mock(() => Promise.resolve()),
  channels: { workspace: (id: string) => `workspace-${id}`, task: (id: string) => `task-${id}`, worker: (id: string) => `worker-${id}` },
  events: { TASK_CREATED: 'task:created', TASK_ASSIGNED: 'task:assigned', TASK_CLAIMED: 'task:claimed', TASK_COMPLETED: 'task:completed', TASK_FAILED: 'task:failed', WORKER_STARTED: 'worker:started', WORKER_PROGRESS: 'worker:progress', WORKER_COMPLETED: 'worker:completed', WORKER_FAILED: 'worker:failed' },
}));
mock.module('@/lib/pr-state-refresh', () => ({ refreshStaleWorkersForWorkspaces: mock(() => Promise.resolve()) }));
mock.module('@/lib/change-intent', () => ({ resolveAnchorInjections: mock(() => []) }));
mock.module('@/lib/deferred-start', () => ({
  resolveDeferredStart: mock(() => ({ startAt: null, resolution: null })),
  laterStartAt: mock(() => null),
}));
mock.module('@/lib/subject-intake', () => ({ intakeSubject: mock(() => Promise.resolve({ task: { id: 't1' }, outcome: { action: 'filed' } })) }));
mock.module('@/lib/subject-intake-db', () => ({ createSubjectIntakeRepository: mock(() => ({})) }));
mock.module('@/lib/subject-anchor-observer', () => ({
  prepareSubjectFiling: mock(() => Promise.resolve({ anchor: null, match: null, taskValues: {} })),
  recordSubjectMatchObserved: mock(() => Promise.resolve()),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: mockAccountsFindFirst },
      accountWorkspaces: { findMany: mock(() => []) },
      workspaces: { findMany: mockWorkspacesFindMany, findFirst: mock(() => null) },
      tasks: { findMany: mockTasksFindMany, findFirst: mockTasksFindFirst },
      missions: { findFirst: mockMissionsFindFirst },
      workspaceSkills: { findFirst: mockWorkspaceSkillsFindFirst },
    },
    insert: mockTasksInsert,
    update: mockTasksUpdate,
    select: mockDbSelect,
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (f: any, v: any) => ({ f, v, type: 'eq' }),
  desc: (f: any) => ({ f, type: 'desc' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  or: (...args: any[]) => ({ args, type: 'or' }),
  inArray: (f: any, v: any[]) => ({ f, v, type: 'inArray' }),
  notInArray: (f: any, v: any[]) => ({ f, v, type: 'notInArray' }),
  gte: (f: any, v: any) => ({ f, v, type: 'gte' }),
  isNotNull: (f: any) => ({ f, type: 'isNotNull' }),
  like: (f: any, p: any) => ({ f, p, type: 'like' }),
  sql: (strings: any, ...values: any[]) => ({ strings, values, type: 'sql' }),
  count: () => ({ type: 'count' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  accounts: { apiKey: 'apiKey', id: 'id' },
  accountWorkspaces: { accountId: 'accountId' },
  workspaces: { id: 'id', teamId: 'teamId', accessMode: 'accessMode' },
  tasks: { id: 'id', workspaceId: 'workspaceId', createdAt: 'createdAt', title: 'title', status: 'status', description: 'description', context: 'context', updatedAt: 'updatedAt', pathManifest: 'pathManifest', priority: 'priority', category: 'category' },
  systemCache: { key: 'key', expiresAt: 'expiresAt' },
  missions: { id: 'id' },
  workspaceSkills: { id: 'id', slug: 'slug', workspaceId: 'workspaceId', enabled: 'enabled' },
}));

mock.module('@buildd/core/path-overlap', () => ({ pathsOverlap: mock(() => false) }));
mock.module('@buildd/core/friction-manifest', () => ({ inferFrictionManifest: mock(() => []) }));
mock.module('@buildd/core/loop-config', () => ({ parseLoopConfig: mock(() => undefined) }));
mock.module('@buildd/core/mission-helpers', () => ({ deriveMissionHealth: mock(() => 'healthy') }));
mock.module('@buildd/core/subject-anchor-observe', () => ({
  resolveSubjectPolicy: mock(() => ({ mode: 'none' })),
  extractSubjectAnchor: mock(() => ({ anchor: null })),
}));
mock.module('@buildd/core/subject-anchor-extractor', () => ({ extractSubjectAnchor: mock(() => ({ anchor: null })) }));
mock.module('@buildd/core/task-category', () => ({ classifyTask: mock(() => null) }));
mock.module('@buildd/shared', () => ({ TaskCategory: {} }));
mock.module('@buildd/core/report-ops', () => ({ reportOps: mock(() => Promise.resolve(true)) }));

// Import AFTER mocks
const { GET } = await import('./route');

function makeRequest(searchParams: Record<string, string> = {}, headers: Record<string, string> = {}): NextRequest {
  const url = 'http://localhost:3000/api/tasks' + (Object.keys(searchParams).length ? '?' + new URLSearchParams(searchParams).toString() : '');
  return new NextRequest(url, { method: 'GET', headers: new Headers(headers) });
}

describe('GET /api/tasks — paginated lean path (?limit=N)', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'u@test.com' });
    mockAccountsFindFirst.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockGetAccountWorkspacePermissions.mockReset();
    mockGetAccountWorkspacePermissions.mockResolvedValue([]);
    mockWorkspacesFindMany.mockReset();
    mockWorkspacesFindMany.mockResolvedValue([]);
    mockDbSelect.mockReset();
    selectCallIndex = 0;
    mockSelectResult = [{ total: 0, pendingCount: 0 }];
    mockSelectRowsResult = [];
    // Re-bind the mock: reset creates a new identity, so re-register the impl
    mockDbSelect.mockImplementation((_cols?: any) => {
      const idx = selectCallIndex++;
      if (idx % 2 === 0) return makeSelectChain(() => mockSelectResult);
      return makeSelectChain(() => mockSelectRowsResult);
    });
  });

  it('returns lean shape with total/pendingCount/hasMore when ?limit is present', async () => {
    mockSelectResult = [{ total: 10, pendingCount: 3 }];
    mockSelectRowsResult = [
      { id: 't1', workspaceId: 'ws-1', title: 'Pending task', status: 'pending', priority: 5, category: 'bug', descriptionPreview: 'Fix the bug' },
      { id: 't2', workspaceId: 'ws-1', title: 'Running task', status: 'in_progress', priority: 3, category: null, descriptionPreview: 'Doing something' },
    ];

    const req = makeRequest({ limit: '5', status: 'active', workspaceId: 'ws-1' });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks).toHaveLength(2);
    expect(body.total).toBe(10);
    expect(body.pendingCount).toBe(3);
    expect(body.hasMore).toBe(true); // offset(0) + limit(5) < total(10)
    // Lean shape — no budget windows unless API key auth
    expect(body.budgetWindows).toBeUndefined();
  });

  it('sets hasMore=false when all rows fit in the page', async () => {
    mockSelectResult = [{ total: 3, pendingCount: 2 }];
    mockSelectRowsResult = [
      { id: 't1', workspaceId: 'ws-1', title: 'T1', status: 'pending', priority: 1, category: null, descriptionPreview: 'desc' },
    ];

    const req = makeRequest({ limit: '5', status: 'active' });
    const res = await GET(req);
    const body = await res.json();
    expect(body.hasMore).toBe(false); // offset(0) + limit(5) >= total(3)
  });

  it('exposes descriptionPreview on each row', async () => {
    mockSelectResult = [{ total: 1, pendingCount: 1 }];
    mockSelectRowsResult = [
      { id: 't1', workspaceId: 'ws-1', title: 'T', status: 'pending', priority: 0, category: null, descriptionPreview: 'First 150 chars of description' },
    ];

    const req = makeRequest({ limit: '5' });
    const res = await GET(req);
    const body = await res.json();
    expect(body.tasks[0].descriptionPreview).toBe('First 150 chars of description');
  });

  it('uses db.select() not db.query.tasks.findMany() in paginated mode', async () => {
    mockSelectResult = [{ total: 0, pendingCount: 0 }];
    mockSelectRowsResult = [];

    const req = makeRequest({ limit: '5' });
    await GET(req);

    expect(mockDbSelect).toHaveBeenCalled();
    expect(mockTasksFindMany).not.toHaveBeenCalled();
  });

  it('falls through to findMany (unpaginated) when ?limit is absent', async () => {
    mockTasksFindMany.mockResolvedValue([
      { id: 't1', title: 'T', workspaceId: 'ws-1', workspace: { id: 'ws-1' } },
    ]);

    const req = makeRequest({ status: 'active' });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks).toHaveLength(1);
    expect(body.total).toBeUndefined();
    expect(mockTasksFindMany).toHaveBeenCalledTimes(1);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('returns empty tasks with zero total when workspace list is empty', async () => {
    mockGetUserWorkspaceIds.mockResolvedValue([]);

    const req = makeRequest({ limit: '5', status: 'active' });
    const res = await GET(req);
    const body = await res.json();

    expect(body.tasks).toHaveLength(0);
    expect(body.total).toBe(0);
    expect(body.hasMore).toBe(false);
    // No db.select() calls when workspaceIds is empty
    expect(mockDbSelect).not.toHaveBeenCalled();
  });
});
