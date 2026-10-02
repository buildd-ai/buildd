import { describe, it, expect, beforeEach, mock } from 'bun:test';
// The gate ledger shares the `db` handle with the route, so an unstubbed
// `recordGateEvent` shows up as an extra `db.insert` in the table-agnostic
// mocks below. Stubbed here because this file asserts route BEHAVIOUR; the
// ledger's own wiring is covered by gate-ledger.test.ts / the gate-events and
// gate-analytics suites in packages/core.
mock.module('@buildd/core/gate-events', () => ({
  GATE_SLUGS: new Proxy({}, { get: (_t, k) => String(k).toLowerCase() }),
  gateFrictionSignature: (gate: string, reason: string) => `gate:${gate}_${Buffer.from(reason).toString('hex').slice(0, 12)}`,
  recordGateEvent: async () => null,
  recordOrCoalesceDeferral: async () => null,
}));
import { NextRequest } from 'next/server';
import { canAccessTokenRoute } from '@/lib/token-route-policy';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockAccountWorkspacesFindMany = mock(() => [] as any[]);
// Link lookup made by the real workspace-access resolver (not mocked here).
const mockAccountWorkspacesFindFirst = mock(() => Promise.resolve({ canClaim: true, canCreate: true } as any));
const mockGetUserTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockTasksFindMany = mock(() => [] as any[]);
const mockTasksFindFirst = mock(() => null as any);
const mockTasksInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() => []),
  })),
}));
// db.update(tasks).set({...}).where(...) chain
const mockTasksUpdateWhere = mock(() => Promise.resolve());
const mockTasksUpdateSet = mock(() => ({ where: mockTasksUpdateWhere }));
const mockTasksUpdate = mock(() => ({ set: mockTasksUpdateSet }));
const mockMissionsFindFirst = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockWorkspaceSkillsFindFirst = mock(() => null as any);
const mockWorkspaceSkillsFindMany = mock(() => Promise.resolve([] as any[]));
const mockTriggerEvent = mock(() => Promise.resolve());
const mockResolveCreatorContext = mock(() =>
  Promise.resolve({
    createdByAccountId: null,
    createdByWorkerId: null,
    creationSource: 'api',
    parentTaskId: null,
  })
);
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));
const mockDispatchNewTask = mock(() => Promise.resolve());
const mockFindIntakeWarnings = mock(() => Promise.resolve([] as any[]));
mock.module('@buildd/core/spec-discrepancy-intake', () => ({
  findIntakeWarnings: mockFindIntakeWarnings,
}));
let resolveCriteriaEscalationCalls: Array<{ missionId: string; reason: string; actor: any }> = [];
const mockResolveCriteriaEscalation = mock((missionId: string, reason: string, actor: any) => {
  resolveCriteriaEscalationCalls.push({ missionId, reason, actor });
  return Promise.resolve({ cleared: false });
});
mock.module('@/lib/criteria-escalation', () => ({
  resolveCriteriaEscalation: mockResolveCriteriaEscalation,
}));
// mission-feed / mission-loop touch DB shapes (missionNotes, workers.update
// chains) this test file's generic db mock doesn't model — mocked directly so
// the fire-and-forget block in POST /api/tasks reaches the escalation resolve
// below instead of throwing on an unrelated missing table.
const mockResolveFeedActor = mock(() => Promise.resolve({ kind: 'mcp' as const, id: 'account-123', label: 'account "account-123"' }));
const mockPostMissionFeedEvent = mock(() => Promise.resolve());
mock.module('@/lib/mission-feed', () => ({
  resolveFeedActor: mockResolveFeedActor,
  postMissionFeedEvent: mockPostMissionFeedEvent,
  systemActor: (predicate: string) => ({ kind: 'system', id: null, label: predicate }),
}));
const mockReopenCompletedMission = mock(() => Promise.resolve({ reopened: false }));
mock.module('@/lib/mission-loop', () => ({
  reopenCompletedMission: mockReopenCompletedMission,
}));

// The category decision is covered by task-category-decision.test.ts; here we
// only assert WHEN the route schedules it and with what, and that it cannot fail
// creation.
const mockScheduleTaskCategorize = mock((..._args: any[]) => {});
mock.module('@/lib/task-category-decision', () => ({
  scheduleTaskCategorize: mockScheduleTaskCategorize,
}));

// The creation-manifest shadow is covered by packages/core manifest-prediction
// tests and task-manifest-prediction.test.ts; here only WHEN the route schedules
// it, with what, and that it can neither change nor fail creation.
const mockScheduleCreationManifestShadow = mock((..._args: any[]) => {});
mock.module('@/lib/task-manifest-prediction', () => ({
  scheduleCreationManifestShadow: mockScheduleCreationManifestShadow,
}));

// Mock auth-helpers
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// Mock api-auth - authenticateApiKey delegates to mockAccountsFindFirst
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: async (apiKey: string | null, req: NextRequest) => {
    if (!apiKey) return null;
    const account = await mockAccountsFindFirst();
    return account && canAccessTokenRoute(account, req) ? account : null;
  },
  hashApiKey: (key: string) => `hashed_${key}`,
  extractApiKeyPrefix: (key: string) => key.substring(0, 12),
}));

const mockGetAccountWorkspacePermissions = mock(() => Promise.resolve([] as any[]));
mock.module('@/lib/account-workspace-cache', () => ({
  getAccountWorkspacePermissions: mockGetAccountWorkspacePermissions,
}));

// Mock team-access
mock.module('@/lib/team-access', () => ({
  getUserWorkspaceIds: mockGetUserWorkspaceIds,
  getUserTeamIds: mockGetUserTeamIds,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

// Mock task-service
mock.module('@/lib/task-service', () => ({
  resolveCreatorContext: mockResolveCreatorContext,
}));

// Mock task-dispatch
mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: mockDispatchNewTask,
}));

// Mock workspace-resolver
const mockResolveWorkspace = mock(() => null as any);
const mockAutoResolveAccountWorkspace = mock(() => Promise.resolve({ workspaceId: 'ws-1' } as any));
mock.module('@/lib/workspace-resolver', () => ({
  resolveWorkspace: mockResolveWorkspace,
  autoResolveAccountWorkspace: mockAutoResolveAccountWorkspace,
}));

// Mock pusher
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: {
    workspace: (id: string) => `workspace-${id}`,
    task: (id: string) => `task-${id}`,
    worker: (id: string) => `worker-${id}`,
  },
  events: {
    TASK_CREATED: 'task:created',
    TASK_ASSIGNED: 'task:assigned',
    TASK_CLAIMED: 'task:claimed',
    TASK_COMPLETED: 'task:completed',
    TASK_FAILED: 'task:failed',
    WORKER_STARTED: 'worker:started',
    WORKER_PROGRESS: 'worker:progress',
    WORKER_COMPLETED: 'worker:completed',
    WORKER_FAILED: 'worker:failed',
  },
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: mockAccountsFindFirst },
      accountWorkspaces: { findMany: mockAccountWorkspacesFindMany, findFirst: mockAccountWorkspacesFindFirst },
      workspaces: { findMany: mockWorkspacesFindMany, findFirst: mockWorkspacesFindFirst },
      tasks: { findMany: mockTasksFindMany, findFirst: mockTasksFindFirst },
      missions: { findFirst: mockMissionsFindFirst },
      workers: { findFirst: mockWorkersFindFirst },
      workspaceSkills: { findFirst: mockWorkspaceSkillsFindFirst, findMany: mockWorkspaceSkillsFindMany },
    },
    insert: mockTasksInsert,
    update: mockTasksUpdate,
  },
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  desc: (field: any) => ({ field, type: 'desc' }),
  asc: (field: any) => ({ field, type: 'asc' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  or: (...args: any[]) => ({ args, type: 'or' }),
  not: (expr: any) => ({ expr, type: 'not' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
  notInArray: (field: any, values: any[]) => ({ field, values, type: 'notInArray' }),
  gte: (field: any, value: any) => ({ field, value, type: 'gte' }),
  gt: (field: any, value: any) => ({ field, value, type: 'gt' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
  isNull: (field: any) => ({ field, type: 'isNull' }),
  like: (field: any, pattern: any) => ({ field, pattern, type: 'like' }),
  sql: (strings: any, ...values: any[]) => ({ strings, values, type: 'sql' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  accounts: { apiKey: 'apiKey', id: 'id' },
  accountWorkspaces: { accountId: 'accountId', workspaceId: 'workspaceId' },
  workspaces: { id: 'id', teamId: 'teamId', accessMode: 'accessMode', repo: 'repo' },
  tasks: {
    id: 'id',
    workspaceId: 'workspaceId',
    createdAt: 'createdAt',
    title: 'title',
    status: 'status',
    description: 'description',
    context: 'context',
    updatedAt: 'updatedAt',
    pathManifest: 'pathManifest',
    requiredConnectors: 'requiredConnectors',
    subjectPrNumber: 'subjectPrNumber',
    subjectHeadSha: 'subjectHeadSha',
    subjectErrorSignature: 'subjectErrorSignature',
    subjectMissionId: 'subjectMissionId',
    missionId: 'missionId',
    mode: 'mode',
    creationSource: 'creationSource',
  },
  taskSubjectReports: 'taskSubjectReports',
  workspaceSkills: {
    slug: 'slug',
    enabled: 'enabled',
    workspaceId: 'workspaceId',
    connectorRefs: 'connectorRefs',
    teamId: 'teamId',
    isRole: 'isRole',
  },
  missions: { id: 'id', teamId: 'teamId', decompositionSkipped: 'decompositionSkipped', orchestrationMode: 'orchestrationMode' },
  workers: { id: 'id', taskId: 'taskId' },
  missionNotes: { id: 'id', missionId: 'missionId' },
}));

// Import handlers AFTER mocks
import { GET, POST } from './route';

// Helper to create mock NextRequest
function createMockRequest(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  searchParams?: Record<string, string>;
} = {}): NextRequest {
  const { method = 'GET', headers = {}, body, searchParams = {} } = options;

  let url = 'http://localhost:3000/api/tasks';
  const params = new URLSearchParams(searchParams);
  if (params.toString()) {
    url += `?${params.toString()}`;
  }

  const init: RequestInit = {
    method,
    headers: new Headers(headers),
  };

  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Headers).set('content-type', 'application/json');
  }

  return new NextRequest(url, init);
}

describe('GET /api/tasks', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockAccountWorkspacesFindMany.mockReset();
    mockGetAccountWorkspacePermissions.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockTasksFindMany.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockMissionsFindFirst.mockReset();
    // Mission links are team-scoped; default to a mission in the test workspace's team.
    mockMissionsFindFirst.mockResolvedValue({ teamId: 'team-1' });

    // Default: session auth gets workspace access
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockGetAccountWorkspacePermissions.mockResolvedValue([]);
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await GET(request);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns tasks for API key auth (linked + open workspaces)', async () => {
    const mockTasks = [
      { id: 'task-1', title: 'Task 1', workspaceId: 'ws-1', workspace: { id: 'ws-1' } },
      { id: 'task-2', title: 'Task 2', workspaceId: 'ws-2', workspace: { id: 'ws-2' } },
    ];

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
    ]);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-2' }, // Open workspace
    ]);
    mockTasksFindMany.mockResolvedValue(mockTasks);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tasks).toHaveLength(2);
    expect(data.tasks[0].id).toBe('task-1');
  });

  it('returns tasks for session auth (owned workspaces)', async () => {
    const mockTasks = [
      { id: 'task-1', title: 'Task 1', workspaceId: 'ws-1', workspace: { id: 'ws-1' } },
    ];

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockTasksFindMany.mockResolvedValue(mockTasks);

    const request = createMockRequest();
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe('task-1');
  });

  it('returns empty array when no workspaces', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockGetUserWorkspaceIds.mockResolvedValue([]);

    const request = createMockRequest();
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tasks).toHaveLength(0);
  });

  it('scopes to a single workspace when ?workspaceId is an accessible workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1', 'ws-2']);
    mockTasksFindMany.mockResolvedValue([
      { id: 'task-1', title: 'Task 1', workspaceId: 'ws-1' },
    ]);

    const request = createMockRequest({ searchParams: { workspaceId: 'ws-1' } });
    const response = await GET(request);

    expect(response.status).toBe(200);
    // The query ran (workspace was accessible), scoped down to ws-1.
    expect(mockTasksFindMany).toHaveBeenCalledTimes(1);
  });

  it('returns empty without querying when ?workspaceId is not accessible', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);

    const request = createMockRequest({ searchParams: { workspaceId: 'ws-other' } });
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tasks).toHaveLength(0);
    // No accessible workspace remained → DB is never hit.
    expect(mockTasksFindMany).not.toHaveBeenCalled();
  });

  it('passes ?status=active through without error', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockTasksFindMany.mockResolvedValue([
      { id: 'task-1', title: 'Task 1', workspaceId: 'ws-1', status: 'in_progress' },
    ]);

    const request = createMockRequest({
      searchParams: { workspaceId: 'ws-1', status: 'active' },
    });
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tasks).toHaveLength(1);
    expect(mockTasksFindMany).toHaveBeenCalledTimes(1);
  });

  it('deduplicates workspace IDs for API key auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    // Same workspace appears in both linked and open
    mockGetAccountWorkspacePermissions.mockResolvedValue([
      { workspaceId: 'ws-1', canClaim: true, canCreate: false },
    ]);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1' }]);
    mockTasksFindMany.mockResolvedValue([
      { id: 'task-1', title: 'Task 1', workspaceId: 'ws-1' },
    ]);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await GET(request);

    expect(response.status).toBe(200);
    // Should still work without errors due to deduplication
  });
});

describe('POST /api/tasks', () => {
  beforeEach(() => {
    mockWorkspaceSkillsFindMany.mockReset();
    mockWorkspaceSkillsFindMany.mockResolvedValue([]);
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockTasksInsert.mockReset();
    mockTasksUpdate.mockReset();
    mockTasksUpdateSet.mockReset();
    mockTasksUpdateWhere.mockReset();
    mockTriggerEvent.mockReset();
    mockResolveCreatorContext.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockDispatchNewTask.mockReset();
    mockMissionsFindFirst.mockReset();
    // Mission links are team-scoped; default to a mission in the test workspace's team.
    mockMissionsFindFirst.mockResolvedValue({ teamId: 'team-1' });
    mockWorkersFindFirst.mockReset();
    // Default: no calling-worker context — the decomposition re-check guard
    // (missionId + no parentTaskId + createdByWorkerId resolves to the
    // mission's own organizer task) stays a no-op unless a test wires it up.
    mockWorkersFindFirst.mockResolvedValue(null);
    mockResolveWorkspace.mockReset();
    mockAutoResolveAccountWorkspace.mockReset();
    mockFindIntakeWarnings.mockReset();

    // Default: no open spec discrepancies to warn about
    mockFindIntakeWarnings.mockResolvedValue([]);

    // Default: no open friction task (miss path)
    mockTasksFindFirst.mockResolvedValue(null);
    // Default: no in-flight tasks for path-overlap check
    mockTasksFindMany.mockResolvedValue([]);
    // Default: update chain returns cleanly
    mockTasksUpdateWhere.mockResolvedValue(undefined);
    mockTasksUpdateSet.mockReturnValue({ where: mockTasksUpdateWhere });
    mockTasksUpdate.mockReturnValue({ set: mockTasksUpdateSet });

    // Default: API key auth has workspace access
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    // Default: resolveWorkspace returns workspace with matching id, owned by
    // the session user's team; API accounts reach it through a canCreate link.
    mockResolveWorkspace.mockImplementation(async (raw: string) => ({ id: raw, teamId: 'team-1', accessMode: 'restricted' }));
    mockGetUserTeamIds.mockReset();
    mockGetUserTeamIds.mockResolvedValue(['team-1']);
    mockAccountWorkspacesFindFirst.mockReset();
    mockAccountWorkspacesFindFirst.mockResolvedValue({ canClaim: true, canCreate: true });

    // Default mock for resolveCreatorContext
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: null,
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
  });

  it('creates a task with a CI write scope and no administrator level', async () => {
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-ci', level: 'worker', scopes: ['tasks:write'], teamId: 'team-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
    const created = { id: 'task-ci', workspaceId: 'ws-1', title: 'CI task', status: 'pending' };
    mockTasksInsert.mockReturnValue({ values: mock(() => ({ returning: mock(() => [created]) })) });
    const response = await POST(createMockRequest({
      method: 'POST', headers: { Authorization: 'Bearer bld_ci' },
      body: { workspaceId: 'ws-1', title: 'CI task' },
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).id).toBe('task-ci');
  });

  it('rejects analytics readers before inserting a task', async () => {
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-reader', level: 'worker', scopes: ['analytics:read'] });
    const response = await POST(createMockRequest({
      method: 'POST', headers: { Authorization: 'Bearer bld_reader' },
      body: { workspaceId: 'ws-1', title: 'Should not be created' },
    }));
    expect(response.status).toBe(401);
    expect(mockTasksInsert).not.toHaveBeenCalled();
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'POST',
      body: { workspaceId: 'ws-1', title: 'Test Task' },
    });
    const response = await POST(request);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 when workspaceId missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });

    const request = createMockRequest({
      method: 'POST',
      body: { title: 'Test Task' },
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('workspaceId is required');
  });

  it('returns 400 when title missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });

    const request = createMockRequest({
      method: 'POST',
      body: { workspaceId: 'ws-1' },
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Title is required');
  });

  it('returns 400 when workspace not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockResolveWorkspace.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'POST',
      body: { workspaceId: 'non-existent', title: 'Test Task' },
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('No workspace found matching');
  });

  it('resolves the workspace identifier within the session user\'s teams', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockResolveWorkspace.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'POST',
      body: { workspaceId: 'some-project', title: 'Test Task' },
    });
    await POST(request);

    expect(mockResolveWorkspace).toHaveBeenCalledWith('some-project', { userId: 'user-123' });
  });

  describe('workspace reach (shared rule with listing and mission create)', () => {
    const WS = '20000000-0000-4000-8000-000000000001';
    const account = { id: 'acct-a', name: 'runner', apiKey: 'bld_xxx', teamId: 'team-a' };

    function arrangeInsert() {
      mockTasksInsert.mockReturnValue({
        values: mock((values: any) => ({ returning: mock(() => [{ id: 'task-r', ...values }]) })),
      });
    }

    async function createWith(ws: Record<string, unknown> | null, opts: { inScope: boolean; link?: any }) {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAccountsFindFirst.mockResolvedValue(account);
      // resolveWorkspace only sees the account's team + links; a foreign
      // workspace is invisible to it but still exists in the table.
      mockResolveWorkspace.mockResolvedValue(opts.inScope ? ws : null);
      mockWorkspacesFindFirst.mockResolvedValue(ws);
      mockAccountWorkspacesFindFirst.mockResolvedValue(opts.link);
      arrangeInsert();
      return POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_xxx' },
        body: { workspaceId: WS, title: 'Reach' },
      }));
    }

    it("creates in the account's own team's open workspace", async () => {
      const res = await createWith({ id: WS, teamId: 'team-a', accessMode: 'open' }, { inScope: true, link: undefined });
      expect(res.status).toBe(200);
    });

    it('creates in a workspace the account is explicitly linked to (canCreate), in another team', async () => {
      const res = await createWith(
        { id: WS, teamId: 'team-b', accessMode: 'restricted' },
        { inScope: true, link: { canClaim: false, canCreate: true } },
      );
      expect(res.status).toBe(200);
    });

    it("refuses another team's open workspace with 403 \"No access to workspace\"", async () => {
      const res = await createWith({ id: WS, teamId: 'team-b', accessMode: 'open' }, { inScope: false, link: undefined });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain('No access to workspace');
      expect(data.error).not.toContain('No workspace found');
      expect(mockTasksInsert).not.toHaveBeenCalled();
    });

    it('refuses a link that lacks canCreate', async () => {
      const res = await createWith(
        { id: WS, teamId: 'team-b', accessMode: 'restricted' },
        { inScope: true, link: { canClaim: true, canCreate: false } },
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error).toContain('No access to workspace');
    });

    it('still says "No workspace found" when nothing by that id exists', async () => {
      const res = await createWith(null, { inScope: false });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('No workspace found matching');
    });
  });

  it('creates task with API key auth', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      description: null,
      status: 'pending',
      priority: 0,
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' }); // Workspace exists, no webhook

    let insertedValues: any;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      insertedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Test Task' },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('task-123');
    expect(data.title).toBe('Test Task');
  });

  it('surfaces spec discrepancy warnings in the response without blocking creation (§10)', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Rebuild the worker mount allowlist',
      description: 'redo the mount allowlist work',
      status: 'pending',
      priority: 0,
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
    mockTasksInsert.mockReturnValue({ values: mock(() => ({ returning: mock(() => [createdTask]) })) });

    const warning = {
      specPath: 'docs/design/worker-mount-isolation.md',
      assertionId: 'mount-symbol',
      direction: 'code_ahead' as const,
      message: 'docs/design/worker-mount-isolation.md — assertion `mount-symbol` already passes.',
    };
    mockFindIntakeWarnings.mockResolvedValue([warning]);

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: createdTask.title, description: createdTask.description },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('task-123');
    expect(data.specWarnings).toEqual([warning]);
    expect(mockFindIntakeWarnings).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', description: createdTask.description }),
    );
  });

  it('omits specWarnings from the response when there are none', async () => {
    const createdTask = { id: 'task-123', workspaceId: 'ws-1', title: 'Test Task', description: null, status: 'pending', priority: 0 };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
    mockTasksInsert.mockReturnValue({ values: mock(() => ({ returning: mock(() => [createdTask]) })) });
    mockFindIntakeWarnings.mockResolvedValue([]);

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Test Task' },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.specWarnings).toBeUndefined();
  });

  it('still creates the task when the intake check itself fails (warn-only, never blocking)', async () => {
    const createdTask = { id: 'task-123', workspaceId: 'ws-1', title: 'Test Task', description: null, status: 'pending', priority: 0 };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
    mockTasksInsert.mockReturnValue({ values: mock(() => ({ returning: mock(() => [createdTask]) })) });
    mockFindIntakeWarnings.mockImplementation(() => Promise.reject(new Error('knowledge store unavailable')));

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Test Task' },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('task-123');
    expect(data.specWarnings).toBeUndefined();
  });

  it('validates and persists loopConfig using verificationCommand fallback', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
    let inserted: any;
    mockTasksInsert.mockReturnValue({
      values: mock((values: any) => {
        inserted = values;
        return { returning: mock(() => [{ id: 'loop-task', ...values }]) };
      }),
    });

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Loop task',
        context: { verificationCommand: 'bun test' },
        loopConfig: { exitCondition: { type: 'command' }, maxLoops: 3 },
      },
    }));

    expect(response.status).toBe(200);
    expect(inserted.loopConfig).toEqual({
      exitCondition: { type: 'command', command: 'bun test' },
      maxLoops: 3,
      backoffMinutes: 0,
    });
  });

  it('rejects unknown loopConfig keys with a 400', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Bad loop',
        loopConfig: { exitCondition: { type: 'pr_checks_green' }, infinite: true },
      },
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Unknown loopConfig key(s): infinite');
    expect(mockTasksInsert).not.toHaveBeenCalled();
  });

  it('resolves startIn server-side and echoes persisted startAt', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
    let inserted: any;
    mockTasksInsert.mockReturnValue({
      values: mock((values: any) => {
        inserted = values;
        return { returning: mock(() => [{ id: 'task-deferred', ...values }]) };
      }),
    });
    const before = Date.now();

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Later task', startIn: '3h' },
    }));

    expect(response.status).toBe(200);
    expect(inserted.startAt.getTime()).toBeGreaterThanOrEqual(before + 3 * 60 * 60 * 1000);
    expect(inserted.context.startResolution).toBe('relative');
    const data = await response.json();
    expect(new Date(data.startAt).toISOString()).toBe(inserted.startAt.toISOString());
  });

  it('creates task with session auth', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      description: null,
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'user-account-123',
      createdByWorkerId: null,
      creationSource: 'dashboard',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });

    let insertedValues: any;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      insertedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: { workspaceId: 'ws-1', title: 'Test Task' },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('task-123');
  });

  it('creates task with all optional fields', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      description: 'Test description',
      priority: 5,
      status: 'pending',
      context: {
        attachments: [
          { filename: 'test.png', mimeType: 'image/png', data: 'data:image/png;base64,xxx' },
        ],
      },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });

    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: {
        workspaceId: 'ws-1',
        title: 'Test Task',
        description: 'Test description',
        priority: 5,
        attachments: [
          { filename: 'test.png', mimeType: 'image/png', data: 'data:image/png;base64,xxx' },
        ],
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.description).toBe('Test description');
    expect(data.priority).toBe(5);
  });

  it('keeps a task attachment key inside the target workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });

    let insertedValues: any = null;
    const mockValues = mock((vals: any) => {
      insertedValues = vals;
      return { returning: mock(() => [{ id: 'task-123', workspaceId: 'ws-1', title: 'T' }]) };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: {
        workspaceId: 'ws-1',
        title: 'T',
        attachments: [
          {
            filename: 'shot.png',
            mimeType: 'image/png',
            storageKey: 'attachments/ws-1/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/shot.png',
          },
        ],
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(insertedValues?.context?.attachments).toHaveLength(1);
  });

  it('rejects a task attachment key that points outside the target workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });

    const mockValues = mock(() => ({
      returning: mock(() => [{ id: 'task-123', workspaceId: 'ws-1', title: 'T' }]),
    }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const foreign = [
      'attachments/ws-2/u1/shot.png',
      'roles/builder/deadbeef.json',
      'attachments/ws-1/../ws-2/u1/shot.png',
      'artifacts/ws-2/u1/report.pdf',
    ];

    for (const storageKey of foreign) {
      const request = createMockRequest({
        method: 'POST',
        body: {
          workspaceId: 'ws-1',
          title: 'T',
          attachments: [{ filename: 'shot.png', mimeType: 'image/png', storageKey }],
        },
      });
      const response = await POST(request);
      expect(response.status).toBe(400);
    }

    expect(mockValues).not.toHaveBeenCalled();
  });

  it('creates task with assignToLocalUiUrl and triggers dispatch', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });

    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: {
        workspaceId: 'ws-1',
        title: 'Test Task',
        assignToLocalUiUrl: 'http://localhost:3456',
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);

    // dispatchNewTask should be called with the task, workspace, and options
    expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
    expect(mockDispatchNewTask.mock.calls[0][0]).toEqual(createdTask);
    expect(mockDispatchNewTask.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        assignToLocalUiUrl: 'http://localhost:3456',
      })
    );
  });

  it('dispatches task on successful creation', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });

    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: { workspaceId: 'ws-1', title: 'Test Task' },
    });
    await POST(request);

    expect(mockDispatchNewTask).toHaveBeenCalledWith(
      createdTask,
      expect.objectContaining({ id: 'ws-1' }),
      expect.any(Object)
    );
  });

  it('sets createdByAccountId from resolveCreatorContext', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      createdByAccountId: 'account-123',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Test Task' },
    });
    await POST(request);

    expect(capturedValues.createdByAccountId).toBe('account-123');
  });

  it('sets creationSource correctly', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      creationSource: 'mcp',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'mcp',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Test Task', creationSource: 'mcp' },
    });
    await POST(request);

    expect(capturedValues.creationSource).toBe('mcp');
  });

  it('validates createdByWorkerId belongs to account', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      createdByWorkerId: 'worker-1',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: 'worker-1',
      creationSource: 'mcp',
      parentTaskId: 'parent-task-1',
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });

    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Test Task',
        createdByWorkerId: 'worker-1',
      },
    });
    await POST(request);

    // resolveCreatorContext is called with the worker ID
    expect(mockResolveCreatorContext).toHaveBeenCalledWith(
      expect.objectContaining({
        createdByWorkerId: 'worker-1',
      })
    );
  });

  it('auto-derives parentTaskId from worker', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      parentTaskId: 'parent-task-1',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: 'worker-1',
      creationSource: 'mcp',
      parentTaskId: 'parent-task-1', // Derived from worker's current task
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Test Task',
        createdByWorkerId: 'worker-1',
      },
    });
    await POST(request);

    expect(capturedValues.parentTaskId).toBe('parent-task-1');
  });

  it('passes workspace with webhook config to dispatchNewTask', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      description: 'Test description',
      status: 'pending',
    };

    const workspace = {
      id: 'ws-1',
      webhookConfig: {
        enabled: true,
        url: 'https://webhook.example.com',
        token: 'webhook-token',
      },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue(workspace);

    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: {
        workspaceId: 'ws-1',
        title: 'Test Task',
        description: 'Test description',
      },
    });
    await POST(request);

    // dispatchNewTask receives the workspace with webhook config
    expect(mockDispatchNewTask).toHaveBeenCalledWith(
      createdTask,
      workspace,
      expect.any(Object)
    );
  });

  it('creates task with project field set', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      project: '@mono/web',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });

    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: { workspaceId: 'ws-1', title: 'Test Task', project: '@mono/web' },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.project).toBe('@mono/web');
  });

  it('creates task without project (remains null)', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });

    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      body: { workspaceId: 'ws-1', title: 'Test Task' },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.project).toBeUndefined();
  });

  it('passes project field through to db.insert values', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      project: '@mono/web',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Test Task', project: '@mono/web' },
    });
    await POST(request);

    expect(capturedValues.project).toBe('@mono/web');
  });

  // ── task category decision shadow ────────────────────────────────────
  describe('category decision', () => {
    async function postWithBody(
      body: Record<string, unknown>,
      workspace: Record<string, unknown> = {},
      opts: { keepMock?: boolean } = {},
    ) {
      if (!opts.keepMock) mockScheduleTaskCategorize.mockReset();
      mockGetCurrentUser.mockResolvedValue(null);
      mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
      mockResolveCreatorContext.mockResolvedValue({
        createdByAccountId: 'account-123',
        createdByWorkerId: null,
        creationSource: 'api',
        parentTaskId: null,
      });
      mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1', ...workspace });
      let capturedValues: any = null;
      mockTasksInsert.mockReturnValue({
        values: mock((values: any) => {
          capturedValues = values;
          return { returning: mock(() => [{ id: 'task-shadow', ...values }]) };
        }),
      });
      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_xxx' },
        body: { workspaceId: 'ws-1', ...body },
      }));
      return { response, capturedValues };
    }

    it('schedules a look at a keyword-picked category, after the response', async () => {
      const { response, capturedValues } = await postWithBody({
        title: 'Fix crash on save',
        description: 'Throws on click.',
      });
      expect(response.status).toBe(200);
      expect(capturedValues.category).toBe('bug');
      expect(mockScheduleTaskCategorize).toHaveBeenCalledTimes(1);
      const [input, schedule] = mockScheduleTaskCategorize.mock.calls[0] as any[];
      expect(input).toEqual({
        taskId: capturedValues.id,
        teamId: 'team-1',
        workspaceId: 'ws-1',
        accountId: 'account-123',
        title: 'Fix crash on save',
        description: 'Throws on click.',
        stored: 'bug',
        callerSet: false,
        dataClass: null,
      });
      expect(typeof schedule).toBe('function');
    });

    it('also looks when the keyword classifier abstained', async () => {
      const { capturedValues } = await postWithBody({ title: 'Quarterly thing' });
      expect(capturedValues.category).toBeUndefined();
      expect((mockScheduleTaskCategorize.mock.calls[0] as any[])[0]).toMatchObject({ stored: null, callerSet: false });
    });

    it('marks a caller-supplied category as the caller\'s, so it is never changed', async () => {
      const { capturedValues } = await postWithBody({ title: 'Fix crash on save', category: 'docs' });
      expect(capturedValues.category).toBe('docs');
      expect((mockScheduleTaskCategorize.mock.calls[0] as any[])[0]).toMatchObject({ stored: 'docs', callerSet: true });
    });

    it('passes the workspace data class so sensitive content can be withheld', async () => {
      await postWithBody({ title: 'Fix crash' }, { gitConfig: { dataClass: 'sensitive' } });
      expect((mockScheduleTaskCategorize.mock.calls[0] as any[])[0].dataClass).toBe('sensitive');
    });

    it('never fails task creation when scheduling throws', async () => {
      mockScheduleTaskCategorize.mockImplementationOnce(() => { throw new Error('boom'); });
      const { response } = await postWithBody({ title: 'Fix crash on save' }, {}, { keepMock: true });
      expect(response.status).toBe(200);
    });
  });

  // ── short display label ──────────────────────────────────────────────
  describe('label', () => {
    async function postWithBody(body: Record<string, unknown>) {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
      mockResolveCreatorContext.mockResolvedValue({
        createdByAccountId: 'account-123',
        createdByWorkerId: null,
        creationSource: 'api',
        parentTaskId: null,
      });
      mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
      let capturedValues: any = null;
      mockTasksInsert.mockReturnValue({
        values: mock((values: any) => {
          capturedValues = values;
          return { returning: mock(() => [{ id: 'task-lbl', ...values }]) };
        }),
      });
      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_xxx' },
        body: { workspaceId: 'ws-1', ...body },
      }));
      return { response, capturedValues };
    }

    it('stores a creator-supplied label (whitespace-normalized)', async () => {
      const { capturedValues } = await postWithBody({
        title: 'feat(fx): rates service with a 15-minute cache',
        label: '  FX   rates ',
      });
      expect(capturedValues.label).toBe('FX rates');
    });

    it('classifier fills the label from the title when the creator omits it', async () => {
      const { capturedValues } = await postWithBody({
        title: 'feat(fx): rates service with a 15-minute cache and stale-rate fallback',
      });
      expect(capturedValues.label).toBe('rates service');
    });

    it('classifier fills a blank label too', async () => {
      const { capturedValues } = await postWithBody({ title: 'docs: rewrite the testing guide', label: '   ' });
      expect(capturedValues.label).toBe('rewrite testing guide');
    });

    it('caps an overlong supplied label at the column width', async () => {
      const { capturedValues } = await postWithBody({ title: 't', label: 'word '.repeat(30) });
      expect(capturedValues.label.length).toBeLessThanOrEqual(48);
    });

    it('rejects a non-string label with 400', async () => {
      const { response } = await postWithBody({ title: 't', label: 42 });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/label/);
    });
  });

  // ── agent backend resolution ─────────────────────────────────────────

  function backendCase() {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({ createdByAccountId: 'account-123', createdByWorkerId: null, creationSource: 'api', parentTaskId: null });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
    let capturedValues: any = null;
    const mockValues = mock((values: any) => { capturedValues = values; return { returning: mock(() => [{ id: 'task-123', workspaceId: 'ws-1', title: 'T' }]) }; });
    mockTasksInsert.mockReturnValue({ values: mockValues });
    return () => capturedValues;
  }

  it("rejects a missionId owned by another team with 404 and creates nothing", async () => {
    backendCase();
    mockMissionsFindFirst.mockResolvedValue({ teamId: 'team-2' });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', missionId: 'm-1', pathManifest: ['apps/web/src/lib/foo.ts'] },
    });
    const res = await POST(request);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Mission not found' });
    expect(mockTasksInsert).not.toHaveBeenCalled();
  });

  it('rejects a missionId that does not exist with the same 404', async () => {
    backendCase();
    mockMissionsFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', missionId: 'm-1', pathManifest: ['apps/web/src/lib/foo.ts'] },
    });
    const res = await POST(request);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Mission not found' });
    expect(mockTasksInsert).not.toHaveBeenCalled();
  });

  it('links a mission owned by the same team', async () => {
    const captured = backendCase();
    mockMissionsFindFirst.mockResolvedValue({ teamId: 'team-1' });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', missionId: 'm-1', pathManifest: ['apps/web/src/lib/foo.ts'] },
    });
    await POST(request);
    expect(captured().missionId).toBe('m-1');
  });

  it('inherits backend from the role default when not explicitly set', async () => {
    const captured = backendCase();
    mockWorkspaceSkillsFindFirst.mockResolvedValue({ defaultBackend: 'codex' });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', roleSlug: 'builder' },
    });
    await POST(request);
    expect(captured().backend).toBe('codex');
  });

  it('explicit task.backend overrides the role default', async () => {
    const captured = backendCase();
    mockWorkspaceSkillsFindFirst.mockResolvedValue({ defaultBackend: 'codex' });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', roleSlug: 'builder', backend: 'claude' },
    });
    await POST(request);
    expect(captured().backend).toBe('claude');
  });

  it('omits backend (schema default applies) when neither task nor role specify one', async () => {
    const captured = backendCase();
    mockWorkspaceSkillsFindFirst.mockResolvedValue({ defaultBackend: null });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T' },
    });
    await POST(request);
    expect(captured().backend).toBeUndefined();
  });

  it('inherits backend from the mission default when not explicitly set', async () => {
    const captured = backendCase();
    mockMissionsFindFirst.mockResolvedValue({ teamId: 'team-1', defaultBackend: 'codex' });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', missionId: 'm-1', pathManifest: ['apps/web/src/lib/foo.ts'] },
    });
    await POST(request);
    expect(captured().backend).toBe('codex');
  });

  it('mission default backend overrides the role default', async () => {
    const captured = backendCase();
    mockMissionsFindFirst.mockResolvedValue({ teamId: 'team-1', defaultBackend: 'codex' });
    mockWorkspaceSkillsFindFirst.mockResolvedValue({ defaultBackend: 'claude' });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', missionId: 'm-1', roleSlug: 'builder', pathManifest: ['apps/web/src/lib/foo.ts'] },
    });
    await POST(request);
    expect(captured().backend).toBe('codex');
  });

  it('explicit task.backend overrides the mission default', async () => {
    const captured = backendCase();
    mockMissionsFindFirst.mockResolvedValue({ teamId: 'team-1', defaultBackend: 'codex' });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', missionId: 'm-1', backend: 'claude', pathManifest: ['apps/web/src/lib/foo.ts'] },
    });
    await POST(request);
    expect(captured().backend).toBe('claude');
  });

  it('falls through to the role default when the mission has no backend', async () => {
    const captured = backendCase();
    mockMissionsFindFirst.mockResolvedValue({ teamId: 'team-1', defaultBackend: null });
    mockWorkspaceSkillsFindFirst.mockResolvedValue({ defaultBackend: 'codex' });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', missionId: 'm-1', roleSlug: 'builder', pathManifest: ['apps/web/src/lib/foo.ts'] },
    });
    await POST(request);
    expect(captured().backend).toBe('codex');
  });

  it('falls back to the workspace gitConfig.defaultBackend when task, mission, and role do not specify', async () => {
    const captured = backendCase();
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', gitConfig: { defaultBackend: 'codex' } });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T' },
    });
    await POST(request);
    expect(captured().backend).toBe('codex');
  });

  it('role default takes precedence over the workspace default', async () => {
    const captured = backendCase();
    mockWorkspaceSkillsFindFirst.mockResolvedValue({ defaultBackend: 'claude' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', gitConfig: { defaultBackend: 'codex' } });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', roleSlug: 'builder' },
    });
    await POST(request);
    expect(captured().backend).toBe('claude');
  });

  // ── outputRequirement inheritance from missions ──────────────────────

  it('inherits outputRequirement from mission when not explicitly set', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      outputRequirement: 'pr_required',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
    mockMissionsFindFirst.mockResolvedValue({ teamId: 'team-1', defaultOutputRequirement: 'pr_required' });

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Test Task', missionId: 'obj-1', pathManifest: ['apps/web/src/lib/foo.ts'] },
    });
    await POST(request);

    expect(capturedValues.outputRequirement).toBe('pr_required');
  });

  it('uses explicit outputRequirement when provided, ignoring mission default', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      outputRequirement: 'none',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
    // Mission has pr_required, but explicit 'none' should win
    mockMissionsFindFirst.mockResolvedValue({ teamId: 'team-1', defaultOutputRequirement: 'pr_required' });

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Test Task', missionId: 'obj-1', outputRequirement: 'none' },
    });
    await POST(request);

    expect(capturedValues.outputRequirement).toBe('none');
    // Should NOT have queried the mission since explicit value was provided
    // (Note: due to mock structure, findFirst may still be callable but outputRequirement should be 'none')
  });

  it('falls back to auto when mission has no defaultOutputRequirement', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      outputRequirement: 'auto',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
    mockMissionsFindFirst.mockResolvedValue({ teamId: 'team-1', defaultOutputRequirement: null });

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Test Task', missionId: 'obj-1', pathManifest: ['apps/web/src/lib/foo.ts'] },
    });
    await POST(request);

    expect(capturedValues.outputRequirement).toBe('auto');
  });

  it('does not look up mission when no missionId provided', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
    mockMissionsFindFirst.mockClear();

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Test Task' },
    });
    await POST(request);

    // Should NOT have queried missions table
    expect(mockMissionsFindFirst).not.toHaveBeenCalled();
    // outputRequirement should not be set (DB default 'auto' applies)
    expect(capturedValues.outputRequirement).toBeUndefined();
  });

  it('does not dispatch to webhook when assignToLocalUiUrl is set', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Test Task',
      status: 'pending',
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    // Even with webhook config, should not dispatch
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      webhookConfig: {
        enabled: true,
        url: 'https://webhook.example.com',
        token: 'webhook-token',
      },
    });

    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const originalFetch = global.fetch;
    const mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
    );
    global.fetch = mockFetch as any;

    try {
      const request = createMockRequest({
        method: 'POST',
        body: {
          workspaceId: 'ws-1',
          title: 'Test Task',
          assignToLocalUiUrl: 'http://localhost:3456',
        },
      });
      await POST(request);

      // Webhook should NOT be called when assignToLocalUiUrl is set
      // (workspace findFirst is not even called in this case since we skip webhook check)
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('forwards requiresReview: true to the DB insert', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Review Task',
      requiresReview: true,
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Review Task', requiresReview: true },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(capturedValues.requiresReview).toBe(true);
  });

  it('does not set requiresReview in insert when not provided (DB default applies)', async () => {
    const createdTask = {
      id: 'task-123',
      workspaceId: 'ws-1',
      title: 'Normal Task',
      requiresReview: false,
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });

    let capturedValues: any = null;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Normal Task' },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    // requiresReview not set in insert values — DB default (false) applies
    expect(capturedValues.requiresReview).toBeUndefined();
  });

  // ── outputSchema content-field denylist (sensitive workspaces) ──────────────

  it('rejects outputSchema with denylist field "subject" in sensitive workspace', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-sensitive',
      gitConfig: { dataClass: 'sensitive' },
    });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-sensitive',
        title: 'Triage Email',
        outputSchema: {
          type: 'object',
          properties: {
            subject: { type: 'string' },
            messageId: { type: 'string' },
          },
        },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('subject');
    expect(data.error).toContain('sensitive workspaces');
  });

  it('rejects outputSchema with multiple denylist fields in sensitive workspace', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-sensitive',
      gitConfig: { dataClass: 'sensitive' },
    });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-sensitive',
        title: 'Bad Schema Task',
        outputSchema: {
          type: 'object',
          properties: {
            body: { type: 'string' },
            sender: { type: 'string' },
            correlationKey: { type: 'string' },
          },
        },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('body');
    expect(data.error).toContain('sender');
  });

  it('allows operational-only outputSchema in sensitive workspace', async () => {
    const createdTask = { id: 'task-123', workspaceId: 'ws-sensitive', title: 'Heartbeat' };
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-sensitive',
      gitConfig: { dataClass: 'sensitive' },
    });
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-sensitive',
        title: 'Heartbeat',
        outputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok', 'action_taken', 'error'] },
            tasksCreated: { type: 'integer' },
            actionCount: { type: 'integer' },
          },
          required: ['status'],
        },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
  });

  it('allows denylist field names that are non-string typed in sensitive workspace', async () => {
    // e.g. an integer field named "to" should not be flagged
    const createdTask = { id: 'task-123', workspaceId: 'ws-sensitive', title: 'Count Task' };
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-sensitive',
      gitConfig: { dataClass: 'sensitive' },
    });
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-sensitive',
        title: 'Count Task',
        outputSchema: {
          type: 'object',
          properties: {
            // "email" typed as integer (e.g. email count) — not content-bearing
            email: { type: 'integer' },
            status: { type: 'string', enum: ['ok'] },
          },
        },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
  });

  it('allows content-field names in non-sensitive workspace outputSchema', async () => {
    // Standard workspace: denylist check does not apply
    const createdTask = { id: 'task-123', workspaceId: 'ws-standard', title: 'Any Task' };
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-standard',
      gitConfig: { dataClass: 'standard' },
    });
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-standard',
        title: 'Any Task',
        outputSchema: {
          type: 'object',
          properties: {
            subject: { type: 'string' },
            body: { type: 'string' },
          },
        },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
  });

  // ── friction task dedup gate ─────────────────────────────────────────────

  function frictionSetup() {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'mcp',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
  }

  it('bwrap replay: first filing creates a task and stamps frictionSignature', async () => {
    frictionSetup();
    // No existing open task with the same signature
    mockTasksFindFirst.mockResolvedValue(null);

    const createdTask = {
      id: 'task-T1',
      workspaceId: 'ws-1',
      title: '[friction] bwrap namespace denied',
      context: { frictionSignature: 'bwrap_namespace_denied' },
    };
    let insertedValues: any;
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      insertedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] bwrap namespace denied',
        description: 'bwrap: No permissions to create a new namespace',
        context: { frictionSignature: 'bwrap_namespace_denied', frictionExcerpt: 'bwrap: No permissions...' },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('task-T1');
    // No deduplicated flag on fresh create
    expect(data.deduplicated).toBeUndefined();
    // db.insert was called (task was created)
    expect(mockTasksInsert).toHaveBeenCalledTimes(1);
    expect(insertedValues.subjectAnchor).toMatchObject({
      kind: 'error',
      errorSignature: 'bwrap_namespace_denied',
      source: 'context',
    });
    expect(insertedValues.subjectErrorSignature).toBe('bwrap_namespace_denied');
    // db.update was NOT called
    expect(mockTasksUpdate).not.toHaveBeenCalled();
  });

  it('bwrap replay: second filing deduplicates and appends to existing task', async () => {
    frictionSetup();
    const existingTask = {
      id: 'task-T1',
      title: '[friction] bwrap namespace denied',
      description: 'bwrap: No permissions to create a new namespace',
    };
    // Open task with same signature exists
    mockTasksFindFirst.mockResolvedValue(existingTask);

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] bwrap namespace denied',
        description: 'Worker B also hit bwrap namespace denied',
        context: { frictionSignature: 'bwrap_namespace_denied', frictionExcerpt: 'bwrap: No permissions...' },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    // Returns existing task id
    expect(data.id).toBe('task-T1');
    expect(data.deduplicated).toBe(true);
    // The only insert is the observe-mode subject report; no new task is returned.
    expect(mockTasksInsert).toHaveBeenCalledTimes(1);
    // db.update was called to append the report
    expect(mockTasksUpdate).toHaveBeenCalledTimes(1);
    expect(mockTasksUpdateSet).toHaveBeenCalledTimes(1);
    expect(mockTasksUpdateWhere).toHaveBeenCalledTimes(1);
  });

  it('bwrap replay: third filing also deduplicates — still exactly one task', async () => {
    frictionSetup();
    const existingTask = {
      id: 'task-T1',
      title: '[friction] bwrap namespace denied',
      description: 'bwrap: No permissions (+ Worker B report)',
    };
    mockTasksFindFirst.mockResolvedValue(existingTask);

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] bwrap namespace denied',
        description: 'Worker C also hit bwrap namespace denied',
        context: { frictionSignature: 'bwrap_namespace_denied' },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('task-T1');
    expect(data.deduplicated).toBe(true);
    expect(mockTasksInsert).toHaveBeenCalledTimes(1);
    expect(mockTasksUpdate).toHaveBeenCalledTimes(1);
  });

  it('same signature in different workspace creates a fresh task (no dedup cross-workspace)', async () => {
    frictionSetup();
    // Simulate: no match in ws-2 (different workspace from ws-1 where T1 lives)
    mockTasksFindFirst.mockResolvedValue(null);

    const createdTask = {
      id: 'task-T2',
      workspaceId: 'ws-2',
      title: '[friction] bwrap namespace denied',
    };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });
    // ws-2 resolveWorkspace
    mockResolveWorkspace.mockResolvedValue({ id: 'ws-2' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-2' });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-2',
        title: '[friction] bwrap namespace denied',
        description: 'bwrap: No permissions to create a new namespace',
        context: { frictionSignature: 'bwrap_namespace_denied' },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('task-T2');
    expect(data.deduplicated).toBeUndefined();
    // Fresh task created in ws-2
    expect(mockTasksInsert).toHaveBeenCalledTimes(1);
    expect(mockTasksUpdate).not.toHaveBeenCalled();
  });

  it('matched task already completed → files fresh task (open-only dedup window)', async () => {
    frictionSetup();
    // findFirst returns null because the completed task is excluded by the NOT IN filter
    // (the route's query already filters out completed/failed/cancelled)
    mockTasksFindFirst.mockResolvedValue(null);

    const createdTask = {
      id: 'task-T3',
      workspaceId: 'ws-1',
      title: '[friction] bwrap namespace denied',
    };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] bwrap namespace denied',
        context: { frictionSignature: 'bwrap_namespace_denied' },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('task-T3');
    expect(data.deduplicated).toBeUndefined();
    expect(mockTasksInsert).toHaveBeenCalledTimes(1);
  });

  it('friction task without frictionSignature in context bypasses dedup and creates normally', async () => {
    frictionSetup();

    const createdTask = {
      id: 'task-T4',
      workspaceId: 'ws-1',
      title: '[friction] some untraced error',
    };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] some untraced error',
        description: 'Something weird happened',
        // No frictionSignature in context
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    // db.query.tasks.findFirst should NOT have been called (no signature → no dedup check)
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
    expect(mockTasksInsert).toHaveBeenCalledTimes(1);
  });

  it('non-friction task with frictionSignature remains fileable while observe mode checks its anchor', async () => {
    frictionSetup();

    const createdTask = { id: 'task-T5', workspaceId: 'ws-1', title: 'Normal task' };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock(() => ({ returning: mockReturning }));
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Normal task',
        context: { frictionSignature: 'bwrap_namespace_denied' },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    // The legacy friction gate still does not deduplicate this filing. Observe
    // mode performs a read-only subject lookup without changing the response.
    expect(mockTasksFindFirst).toHaveBeenCalledTimes(1);
    expect(mockTasksInsert).toHaveBeenCalledTimes(1);
  });

  // ── manifest inference on the dedup-miss (new friction task) path ─────────

  it('manifest inference: explicit path in frictionExcerpt → pathManifest on created task', async () => {
    frictionSetup();
    mockTasksFindFirst.mockResolvedValue(null); // dedup miss

    let capturedValues: any = null;
    const createdTask = { id: 'task-M1', workspaceId: 'ws-1', title: '[friction] enoent in runner' };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] enoent in runner',
        description: "ENOENT: no such file or directory, 'apps/runner/src/env-scan.ts'",
        context: {
          frictionSignature: 'enoent',
          frictionExcerpt: "ENOENT: no such file or directory, 'apps/runner/src/env-scan.ts'",
        },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    // The inferred manifest must be stamped on the task row
    expect(capturedValues.pathManifest).toEqual(['apps/runner/src/env-scan.ts']);
  });

  it('manifest inference: pathless trace → fallback component table (bwrap_namespace_denied)', async () => {
    frictionSetup();
    mockTasksFindFirst.mockResolvedValue(null);

    let capturedValues: any = null;
    const createdTask = { id: 'task-M2', workspaceId: 'ws-1', title: '[friction] bwrap namespace denied' };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] bwrap namespace denied',
        description: 'bwrap: No permissions to create a new namespace',
        context: {
          frictionSignature: 'bwrap_namespace_denied',
          frictionExcerpt: 'bwrap: No permissions to create a new namespace',
        },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    // Fallback table for bwrap_namespace_denied includes both runner files
    expect(capturedValues.pathManifest).toEqual([
      'apps/runner/src/env-scan.ts',
      'apps/runner/src/workers.ts',
    ]);
  });

  it('bwrap fixture: env-scan.ts origin → manifest contains apps/runner/src/env-scan.ts', async () => {
    frictionSetup();
    mockTasksFindFirst.mockResolvedValue(null);

    let capturedValues: any = null;
    const createdTask = { id: 'task-M3', workspaceId: 'ws-1', title: '[friction] bwrap namespace denied' };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] bwrap namespace denied',
        description: 'bwrap: No permissions to create a new namespace',
        // frictionExcerpt names env-scan.ts explicitly — path extraction wins
        context: {
          frictionSignature: 'bwrap_namespace_denied',
          frictionExcerpt:
            'bwrap: No permissions to create a new namespace — from apps/runner/src/env-scan.ts',
        },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(capturedValues.pathManifest).toContain('apps/runner/src/env-scan.ts');
  });

  it('inferred manifest overlapping a sibling pending task → auto-dependsOn edge created', async () => {
    frictionSetup();
    mockTasksFindFirst.mockResolvedValue(null); // dedup miss

    // Sibling task in-flight that touches apps/runner/src/workers.ts
    mockTasksFindMany.mockResolvedValue([
      { id: 'sibling-task-99', pathManifest: ['apps/runner/src/workers.ts'] },
    ]);

    let capturedValues: any = null;
    const createdTask = { id: 'task-M4', workspaceId: 'ws-1', title: '[friction] bwrap namespace denied' };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] bwrap namespace denied',
        description: 'bwrap: No permissions to create a new namespace',
        context: {
          frictionSignature: 'bwrap_namespace_denied',
          frictionExcerpt: 'bwrap: No permissions to create a new namespace',
        },
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    // pathManifest was inferred (fallback table)
    expect(capturedValues.pathManifest).toEqual([
      'apps/runner/src/env-scan.ts',
      'apps/runner/src/workers.ts',
    ]);
    // The overlap with the sibling task triggered the auto-dependsOn edge
    expect(capturedValues.dependsOn).toContain('sibling-task-99');
  });

  it('manifest inference skipped when caller already provides pathManifest', async () => {
    frictionSetup();
    mockTasksFindFirst.mockResolvedValue(null);

    let capturedValues: any = null;
    const createdTask = { id: 'task-M5', workspaceId: 'ws-1', title: '[friction] bwrap namespace denied' };
    const mockReturning = mock(() => [createdTask]);
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mockReturning };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });

    const request = createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] bwrap namespace denied',
        context: {
          frictionSignature: 'bwrap_namespace_denied',
          frictionExcerpt: 'bwrap: No permissions to create a new namespace',
        },
        // Caller explicitly provides a manifest
        pathManifest: ['apps/runner/src/sandbox.ts'],
      },
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    // The caller-supplied manifest is used as-is; inference is skipped
    expect(capturedValues.pathManifest).toEqual(['apps/runner/src/sandbox.ts']);
  });

  // ── enforceGreenCI loopConfig injection ─────────────────────────────────────

  function greenCiSetup() {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
    let capturedValues: any = null;
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mock(() => [{ id: 'task-gc', workspaceId: 'ws-1', title: 'T', ...values }]) };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });
    return () => capturedValues;
  }

  it('injects pr_checks_green loopConfig when workspace.enforceGreenCI is true and outputRequirement is pr_required', async () => {
    const captured = greenCiSetup();
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      gitConfig: { enforceGreenCI: true },
    });

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', outputRequirement: 'pr_required' },
    }));

    expect(response.status).toBe(200);
    const vals = captured();
    expect(vals.loopConfig).toMatchObject({
      exitCondition: { type: 'pr_checks_green' },
      maxLoops: 3,
    });
  });

  it('does not inject loopConfig when caller already provides one', async () => {
    const captured = greenCiSetup();
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      gitConfig: { enforceGreenCI: true },
    });

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'T',
        outputRequirement: 'pr_required',
        loopConfig: { exitCondition: { type: 'command', command: 'bun test' }, maxLoops: 5 },
      },
    }));

    expect(response.status).toBe(200);
    const vals = captured();
    // Caller's loopConfig wins — not overwritten
    expect(vals.loopConfig?.exitCondition?.type).toBe('command');
  });

  it('does not inject loopConfig when enforceGreenCI is false', async () => {
    const captured = greenCiSetup();
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      gitConfig: { enforceGreenCI: false },
    });

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', outputRequirement: 'pr_required' },
    }));

    expect(response.status).toBe(200);
    expect(captured()?.loopConfig).toBeUndefined();
  });

  it('does not inject loopConfig when outputRequirement is not pr_required', async () => {
    const captured = greenCiSetup();
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-1',
      gitConfig: { enforceGreenCI: true },
    });

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'T', outputRequirement: 'artifact_required' },
    }));

    expect(response.status).toBe(200);
    expect(captured()?.loopConfig).toBeUndefined();
  });

  // ── mission pathManifest defaulting ─────────────────────────────────────────

  function missionPathManifestSetup() {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'mcp',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1', gitConfig: {} });
    // 'none' keeps these tests on the exempt path — they exercise the ['**']
    // sentinel-default and overlap-serialization behavior, not the mandatory-
    // manifest gate (covered separately below for 'pr_required'/'auto').
    mockMissionsFindFirst.mockResolvedValue({ teamId: 'team-1', defaultOutputRequirement: 'none', defaultBackend: null, startAt: null });
    let capturedValues: any = null;
    const mockValues = mock((values: any) => {
      capturedValues = values;
      return { returning: mock(() => [{ id: 'task-mp', workspaceId: 'ws-1', title: 'Mission task', ...values }]) };
    });
    mockTasksInsert.mockReturnValue({ values: mockValues });
    return () => capturedValues;
  }

  it('defaults pathManifest to ["**"] for mission tasks with no explicit pathManifest', async () => {
    const captured = missionPathManifestSetup();
    // No sibling tasks in flight
    mockTasksFindMany.mockResolvedValue([]);

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Build feature X', missionId: 'mission-1' },
    }));

    expect(response.status).toBe(200);
    expect(captured().pathManifest).toEqual(['**']);
  });

  it('preserves explicit pathManifest when provided alongside missionId', async () => {
    const captured = missionPathManifestSetup();
    mockTasksFindMany.mockResolvedValue([]);

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Build feature X',
        missionId: 'mission-1',
        pathManifest: ['apps/web/src/lib/feature.ts'],
      },
    }));

    expect(response.status).toBe(200);
    expect(captured().pathManifest).toEqual(['apps/web/src/lib/feature.ts']);
  });

  it('does not set pathManifest for non-mission tasks with no explicit pathManifest', async () => {
    const captured = missionPathManifestSetup();
    mockMissionsFindFirst.mockResolvedValue(null);
    mockTasksFindMany.mockResolvedValue([]);

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Standalone task' },
    }));

    expect(response.status).toBe(200);
    expect(captured().pathManifest).toBeUndefined();
  });

  it('mission task with ["**"] default does NOT auto-depend on a sibling with explicit paths', async () => {
    // The wildcard is advisory-only at claim time (findBlockingPr returns null for
    // '**', and the path_claims backstop skips it). Authoring must not mint a hard
    // dependsOn edge the runtime gate would refuse to honour.
    const captured = missionPathManifestSetup();
    // A sibling task already in-flight that has explicit paths
    mockTasksFindMany.mockResolvedValue([
      { id: 'sibling-task-A', pathManifest: ['apps/web/src/lib/shared.ts'] },
    ]);

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Mission task B', missionId: 'mission-1' },
    }));

    expect(response.status).toBe(200);
    // Still gets the conservative default manifest…
    expect(captured().pathManifest).toEqual(['**']);
    // …but it buys no dependency edges.
    expect(captured().dependsOn).toBeUndefined();
  });

  it('mission task with explicit paths does NOT auto-depend on a wildcard-scoped sibling', async () => {
    const captured = missionPathManifestSetup();
    // Sibling never declared its scope — it cannot legitimately block every path.
    mockTasksFindMany.mockResolvedValue([
      { id: 'sibling-task-A', pathManifest: ['**'] },
    ]);

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Mission task B',
        missionId: 'mission-1',
        pathManifest: ['apps/web/src/lib/shared.ts'],
      },
    }));

    expect(response.status).toBe(200);
    expect(captured().dependsOn).toBeUndefined();
  });

  it('two mission tasks with ["**"] default do NOT serialise against each other', async () => {
    // This is the FIFO-serialization bug: every manifest-less mission task used to
    // inherit a hard edge to every task alive in the workspace at creation time.
    const captured = missionPathManifestSetup();
    // A sibling mission task that also received the '**' default
    mockTasksFindMany.mockResolvedValue([
      { id: 'sibling-task-A', pathManifest: ['**'] },
      { id: 'sibling-task-B', pathManifest: ['**'] },
    ]);

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Mission task C', missionId: 'mission-1' },
    }));

    expect(response.status).toBe(200);
    expect(captured().pathManifest).toEqual(['**']);
    expect(captured().dependsOn).toBeUndefined();
  });

  it('still auto-depends when two concrete manifests genuinely overlap', async () => {
    const captured = missionPathManifestSetup();
    mockTasksFindMany.mockResolvedValue([
      { id: 'sibling-wildcard', pathManifest: ['**'] },
      { id: 'sibling-real-overlap', pathManifest: ['apps/web/src/lib'] },
      { id: 'sibling-unrelated', pathManifest: ['packages/core/db/schema.ts'] },
    ]);

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Mission task B',
        missionId: 'mission-1',
        pathManifest: ['apps/web/src/lib/shared.ts'],
      },
    }));

    expect(response.status).toBe(200);
    expect(captured().dependsOn).toEqual(['sibling-real-overlap']);
    // Provenance: the declaration as filed, and which edge was inferred.
    expect(captured().pathDeclaration).toMatchObject({
      declared: ['apps/web/src/lib/shared.ts'],
      source: 'creation',
      inferredDependsOn: ['sibling-real-overlap'],
    });
  });

  it('records a caller-supplied edge as explicit, never as inferred', async () => {
    const captured = missionPathManifestSetup();
    const explicitDepId = '11111111-1111-1111-1111-111111111111';
    mockTasksFindMany
      .mockResolvedValueOnce([{ id: explicitDepId }])
      .mockResolvedValueOnce([{ id: explicitDepId, pathManifest: ['apps/web/src/lib'] }]);

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Mission task B',
        missionId: 'mission-1',
        dependsOn: [explicitDepId],
        pathManifest: ['apps/web/src/lib/shared.ts'],
      },
    }));

    expect(response.status).toBe(200);
    expect(captured().dependsOn).toEqual([explicitDepId]);
    expect(captured().pathDeclaration.inferredDependsOn).toBeUndefined();
  });

  it('preserves caller-supplied dependsOn on a wildcard-defaulted mission task', async () => {
    const captured = missionPathManifestSetup();
    // dependsOn validation re-uses findMany; return the referenced dep first,
    // then the in-flight sibling scan result.
    const explicitDepId = '11111111-1111-1111-1111-111111111111';
    mockTasksFindMany
      .mockResolvedValueOnce([{ id: explicitDepId }])
      .mockResolvedValueOnce([
        { id: '22222222-2222-2222-2222-222222222222', pathManifest: ['**'] },
        { id: '33333333-3333-3333-3333-333333333333', pathManifest: ['packages/core/db/schema.ts'] },
      ]);

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Mission task B',
        missionId: 'mission-1',
        dependsOn: [explicitDepId],
      },
    }));

    expect(response.status).toBe(200);
    // Exactly the caller's edge — no inferred wildcard edges bolted on.
    expect(captured().dependsOn).toEqual([explicitDepId]);
  });

  it('rejects dependsOn with invalid UUID format', async () => {
    setupBasicCreation();

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        workspaceId: 'ws-1',
        title: 'Task with bad dependency',
        dependsOn: ['not-a-uuid', 'typo123'],
      },
    }));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain('invalid task IDs');
    expect(json.error).toContain('must be valid UUIDs');
    expect(json.error).toContain('not-a-uuid');
    expect(json.error).toContain('typo123');
  });

  it('rejects dependsOn with mix of valid and invalid UUID formats', async () => {
    setupBasicCreation();

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        workspaceId: 'ws-1',
        title: 'Task with mixed deps',
        dependsOn: ['12345678-1234-1234-1234-123456789abc', 'not-a-uuid'],
      },
    }));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain('invalid task IDs');
  });

  it('rejects dependsOn with valid UUID format that does not exist in workspace', async () => {
    setupBasicCreation();
    // Return empty result — UUID is valid format but not found
    mockTasksFindMany.mockResolvedValueOnce([]);

    const missingId = '12345678-1234-1234-1234-123456789abc';
    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        workspaceId: 'ws-1',
        title: 'Task with nonexistent dependency',
        dependsOn: [missingId],
      },
    }));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain('dependsOn references unknown tasks in this workspace');
    expect(json.error).toContain(missingId);
  });

  it('returns generic 500 error without exposing driver query text on database failure', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
    // Simulate a database driver error with query text and params
    const driverError = new Error(
      'Failed query: INSERT INTO tasks (id, workspace_id, title) VALUES ($1, $2, $3) params: ["task-123", "ws-1", "Test task"]'
    );
    mockTasksInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(async () => {
          throw driverError;
        }),
      })),
    });

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        workspaceId: 'ws-1',
        title: 'Test task',
      },
    }));

    expect(response.status).toBe(500);
    const json = await response.json();
    // Verify no detail field is returned
    expect(json.detail).toBeUndefined();
    // Verify error message is generic
    expect(json.error).toBe('Failed to create task');
    // Verify query text is not leaked
    expect(JSON.stringify(json)).not.toContain('INSERT INTO tasks');
    expect(JSON.stringify(json)).not.toContain('workspace_id');
    expect(JSON.stringify(json)).not.toContain('params:');
  });

  // ── Mandatory pathManifest gate (pr-producing mission tasks) ───────────────

  it('rejects a mission task with pr_required output and no pathManifest', async () => {
    missionPathManifestSetup();
    mockTasksFindMany.mockResolvedValue([]);

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Build feature X',
        missionId: 'mission-1',
        outputRequirement: 'pr_required',
      },
    }));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain('pathManifest');
  });

  it('rejects a mission task with pr_required output and only the ["**"] sentinel', async () => {
    missionPathManifestSetup();
    mockTasksFindMany.mockResolvedValue([]);

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Build feature X',
        missionId: 'mission-1',
        outputRequirement: 'pr_required',
        pathManifest: ['**'],
      },
    }));

    expect(response.status).toBe(400);
  });

  it('accepts a mission task defaulting to auto output requirement with no pathManifest — auto has no creation-time resolution', async () => {
    const captured = missionPathManifestSetup();
    mockMissionsFindFirst.mockResolvedValue({ teamId: 'team-1', defaultOutputRequirement: null, defaultBackend: null, startAt: null });
    mockTasksFindMany.mockResolvedValue([]);

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: '[friction] observed a papercut, no code change intended',
        missionId: 'mission-1',
      },
    }));

    expect(response.status).toBe(200);
    // Falls back to the conservative ['**'] sentinel-default, same as any
    // other manifest-less mission task — the manifest GATE does not fire,
    // but the sentinel-default still applies.
    expect(captured().pathManifest).toEqual(['**']);
  });

  it('still rejects an explicit outputRequirement: pr_required mission task with no pathManifest, and names the none escape hatch', async () => {
    missionPathManifestSetup();
    mockTasksFindMany.mockResolvedValue([]);

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Build feature X',
        missionId: 'mission-1',
        outputRequirement: 'pr_required',
      },
    }));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain('pathManifest');
    expect(json.error).toContain("outputRequirement: 'none'");
  });

  it('rejects a mission task whose manifest is only a repo-root-wide glob wider than one package', async () => {
    missionPathManifestSetup();
    mockTasksFindMany.mockResolvedValue([]);

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Build feature X',
        missionId: 'mission-1',
        outputRequirement: 'pr_required',
        pathManifest: ['apps/**'],
      },
    }));

    expect(response.status).toBe(400);
  });

  // ── Creation-manifest shadow (design §5a) ─────────────────────────────────
  describe('creation-manifest shadow', () => {
    beforeEach(() => { mockScheduleCreationManifestShadow.mockReset(); });

    it('schedules a shadow prediction for a missing-scope mission task, after the response, without changing the stored manifest', async () => {
      const captured = missionPathManifestSetup();
      mockTasksFindMany.mockResolvedValue([]);
      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_xxx' },
        body: { workspaceId: 'ws-1', title: 'Build feature X', description: 'Do it', missionId: 'mission-1' },
      }));
      expect(response.status).toBe(200);
      expect(captured().pathManifest).toEqual(['**']);
      expect(mockScheduleCreationManifestShadow).toHaveBeenCalledTimes(1);
      const [input, schedule] = mockScheduleCreationManifestShadow.mock.calls[0] as any[];
      expect(input).toMatchObject({
        taskId: captured().id,
        teamId: 'team-1',
        workspaceId: 'ws-1',
        missionId: 'mission-1',
        accountId: 'account-123',
        title: 'Build feature X',
        description: 'Do it',
        callerManifest: ['**'],
      });
      expect(input.createdAt instanceof Date).toBe(true);
      expect(typeof schedule).toBe('function');
    });

    it('explicit caller manifests win: no prediction is scheduled', async () => {
      missionPathManifestSetup();
      mockTasksFindMany.mockResolvedValue([]);
      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_xxx' },
        body: { workspaceId: 'ws-1', title: 'Build feature X', missionId: 'mission-1', pathManifest: ['apps/web/src/lib/feature.ts'] },
      }));
      expect(response.status).toBe(200);
      expect(mockScheduleCreationManifestShadow).not.toHaveBeenCalled();
    });

    it('shadow leaves the manifest_required rejection byte-for-byte unchanged and schedules nothing', async () => {
      missionPathManifestSetup();
      mockTasksFindMany.mockResolvedValue([]);
      const body = { workspaceId: 'ws-1', title: 'Build feature X', missionId: 'mission-1', outputRequirement: 'pr_required' };
      const response = await POST(createMockRequest({ method: 'POST', headers: { Authorization: 'Bearer bld_xxx' }, body }));
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(Object.keys(json).sort()).toEqual(['error', 'frictionSignature']);
      expect(json.error).toBe(
        'pathManifest is required for mission tasks that produce a PR — declare at least one concrete path, e.g. pathManifest: ["apps/web/src/lib/foo.ts"]. ' +
        "If this task won't produce a PR, set outputRequirement: 'none' instead.",
      );
      expect(mockScheduleCreationManifestShadow).not.toHaveBeenCalled();
    });

    it('never fails or changes task creation when scheduling throws', async () => {
      const captured = missionPathManifestSetup();
      mockTasksFindMany.mockResolvedValue([]);
      mockScheduleCreationManifestShadow.mockImplementationOnce(() => { throw new Error('boom'); });
      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_xxx' },
        body: { workspaceId: 'ws-1', title: 'Build feature X', missionId: 'mission-1' },
      }));
      expect(response.status).toBe(200);
      expect(captured().pathManifest).toEqual(['**']);
    });

    it('does not add inferred dependsOn for a missing-scope task (the prediction never reaches overlap)', async () => {
      const captured = missionPathManifestSetup();
      mockTasksFindMany.mockResolvedValue([{ id: '00000000-0000-4000-8000-000000000077', pathManifest: ['apps/web/src/lib/feature.ts'] }]);
      await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_xxx' },
        body: { workspaceId: 'ws-1', title: 'Build feature X', missionId: 'mission-1' },
      }));
      expect(captured().dependsOn ?? []).toEqual([]);
    });
  });

  it('accepts a mission task with pr_required output and a concrete pathManifest', async () => {
    const captured = missionPathManifestSetup();
    mockTasksFindMany.mockResolvedValue([]);

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Build feature X',
        missionId: 'mission-1',
        outputRequirement: 'pr_required',
        pathManifest: ['apps/web/src/lib/feature.ts'],
      },
    }));

    expect(response.status).toBe(200);
    expect(captured().pathManifest).toEqual(['apps/web/src/lib/feature.ts']);
  });

  it('exempts artifact_required and none mission tasks from the manifest gate', async () => {
    const captured = missionPathManifestSetup();
    mockTasksFindMany.mockResolvedValue([]);

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: {
        workspaceId: 'ws-1',
        title: 'Write the report',
        missionId: 'mission-1',
        outputRequirement: 'artifact_required',
      },
    }));

    expect(response.status).toBe(200);
    expect(captured().pathManifest).toEqual(['**']);
  });

  it('exempts non-mission tasks from the manifest gate even with pr_required output', async () => {
    const captured = missionPathManifestSetup();
    mockMissionsFindFirst.mockResolvedValue(null);
    mockTasksFindMany.mockResolvedValue([]);

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Standalone task', outputRequirement: 'pr_required' },
    }));

    expect(response.status).toBe(200);
    expect(captured().pathManifest).toBeUndefined();
  });

  // ── Prose-gate lint ────────────────────────────────────────────────────────
  // Verbatim descriptions from the motivating incidents (mission 6dc41ced)
  const INCIDENT_222e9216 =
    'Gated on the spec (b984dedf) merging and on the workspace-scope fix (9bc6ebd6) merging — ' +
    'this task edits the same route files, so it must not run in parallel with them.';
  const INCIDENT_ca0b692e = 'Gated on the spec merging.';

  function setupBasicCreation() {
    const createdTask = { id: 'task-1', workspaceId: 'ws-1', title: 'T', status: 'pending' };
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com' });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
    mockTasksInsert.mockReturnValue({
      values: mock(() => ({ returning: mock(() => [createdTask]) })),
    });
    return createdTask;
  }

  describe('prose-gate lint', () => {
    it('surfaces a prose-gate warning for task 222e9216 description with empty dependsOn (verbatim incident)', async () => {
      setupBasicCreation();

      const response = await POST(createMockRequest({
        method: 'POST',
        body: { workspaceId: 'ws-1', title: 'Gated task', description: INCIDENT_222e9216 },
      }));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.proseGateWarning.message).toContain('dependsOn');
      expect(data.proseGateWarning.message).toContain('Gated on');
    });

    it('surfaces a prose-gate warning for task ca0b692e description with empty dependsOn (verbatim incident)', async () => {
      setupBasicCreation();

      const response = await POST(createMockRequest({
        method: 'POST',
        body: { workspaceId: 'ws-1', title: 'Spec gate', description: INCIDENT_ca0b692e },
      }));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.proseGateWarning.message).toContain('dependsOn');
    });

    it('surfaces a prose-gate warning with empty dependsOn and names extracted task IDs', async () => {
      setupBasicCreation();

      const response = await POST(createMockRequest({
        method: 'POST',
        body: {
          workspaceId: 'ws-1',
          title: 'Gated task',
          description: 'Gated on deadbeef and cafebabe completing.',
        },
      }));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.proseGateWarning.taskIds).toContain('deadbeef');
      expect(data.proseGateWarning.taskIds).toContain('cafebabe');
    });

    it('gate phrase + dependsOn → created', async () => {
      setupBasicCreation();
      // dep validation returns the dep task
      const depTaskId = '44444444-4444-4444-4444-444444444444';
      mockTasksFindMany.mockResolvedValueOnce([{ id: depTaskId }]);

      const response = await POST(createMockRequest({
        method: 'POST',
        body: {
          workspaceId: 'ws-1',
          title: 'Gated task',
          description: INCIDENT_ca0b692e,
          dependsOn: [depTaskId],
        },
      }));

      expect(response.status).toBe(200);
    });

    it('no gate phrase + empty dependsOn → created', async () => {
      setupBasicCreation();

      const response = await POST(createMockRequest({
        method: 'POST',
        body: {
          workspaceId: 'ws-1',
          title: 'Plain task',
          description: 'Implement the new pagination endpoint for the task list.',
        },
      }));

      expect(response.status).toBe(200);
    });

    it('incidental mention of a sibling task without gating language → created', async () => {
      setupBasicCreation();

      const response = await POST(createMockRequest({
        method: 'POST',
        body: {
          workspaceId: 'ws-1',
          title: 'Auth refactor',
          description: 'Implement the new auth flow, similar to what was done in task abc12345.',
        },
      }));

      expect(response.status).toBe(200);
    });

    it('fileAnywayReason bypass → created (lint skipped)', async () => {
      setupBasicCreation();

      const response = await POST(createMockRequest({
        method: 'POST',
        body: {
          workspaceId: 'ws-1',
          title: 'Gated task',
          description: INCIDENT_222e9216,
          fileAnywayReason: 'dependsOn edges will be added once the upstream task IDs are known',
        },
      }));

      expect(response.status).toBe(200);
    });
  });

  describe('requiredConnectors', () => {
    function setupApiKeyAuth() {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'bld_test' });
      mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
      mockResolveCreatorContext.mockResolvedValue({
        createdByAccountId: 'account-1',
        createdByWorkerId: null,
        creationSource: 'api',
        parentTaskId: null,
      });
    }

    it('rejects requiredConnectors without roleSlug', async () => {
      setupApiKeyAuth();

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workspaceId: 'ws-1',
          title: 'Email task',
          requiredConnectors: ['conn-uuid-1'],
        },
      }));

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('requiredConnectors requires a roleSlug');
    });

    it('rejects requiredConnectors not in role connectorRefs', async () => {
      setupApiKeyAuth();
      // Role has connectorRefs: ['conn-uuid-A']
      mockWorkspaceSkillsFindFirst.mockResolvedValueOnce({ connectorRefs: ['conn-uuid-A'] });

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workspaceId: 'ws-1',
          title: 'Email task',
          roleSlug: 'email-agent',
          requiredConnectors: ['conn-uuid-NOT-IN-ROLE'],
        },
      }));

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('not in the role');
    });

    it('creates task with valid requiredConnectors', async () => {
      setupApiKeyAuth();
      // Role has connectorRefs: ['conn-uuid-A', 'conn-uuid-B']
      mockWorkspaceSkillsFindFirst.mockResolvedValueOnce({ connectorRefs: ['conn-uuid-A', 'conn-uuid-B'] });
      // defaultBackend lookup returns null
      mockWorkspaceSkillsFindFirst.mockResolvedValueOnce(null);

      let insertedValues: any;
      const createdTask = { id: 'task-rc', workspaceId: 'ws-1', title: 'Email task', status: 'pending' };
      mockTasksInsert.mockReturnValue({
        values: mock((values: any) => {
          insertedValues = values;
          return { returning: mock(() => [createdTask]) };
        }),
      });

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workspaceId: 'ws-1',
          title: 'Email task',
          roleSlug: 'email-agent',
          requiredConnectors: ['conn-uuid-A'],
        },
      }));

      expect(response.status).toBe(200);
      expect(insertedValues.requiredConnectors).toEqual(['conn-uuid-A']);
      expect(insertedValues.roleSlug).toBe('email-agent');
    });

    it('allows empty requiredConnectors without role validation', async () => {
      setupApiKeyAuth();
      const createdTask = { id: 'task-rc', workspaceId: 'ws-1', title: 'Task', status: 'pending' };
      mockTasksInsert.mockReturnValue({
        values: mock(() => ({ returning: mock(() => [createdTask]) })),
      });

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workspaceId: 'ws-1',
          title: 'Task',
          requiredConnectors: [],
        },
      }));

      // Empty requiredConnectors with no roleSlug is allowed (empty = no requirements)
      expect(response.status).toBe(200);
    });

    it('rejects non-array requiredConnectors', async () => {
      setupApiKeyAuth();

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workspaceId: 'ws-1',
          title: 'Task',
          requiredConnectors: 'not-an-array',
        },
      }));

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('array');
    });
  });
  describe('kind/complexity routing inputs', () => {
    function setupKindAuth() {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'bld_test' });
      mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
      mockResolveCreatorContext.mockResolvedValue({
        createdByAccountId: 'account-1',
        createdByWorkerId: null,
        creationSource: 'api',
        parentTaskId: null,
      });
    }

    function captureInsert() {
      const createdTask = { id: 'task-kc', workspaceId: 'ws-1', title: 'Task', status: 'pending' };
      const captured: { values: any } = { values: null };
      mockTasksInsert.mockReturnValue({
        values: mock((values: any) => {
          captured.values = values;
          return { returning: mock(() => [createdTask]) };
        }),
      });
      return captured;
    }

    it('persists a valid kind/complexity pair on the task row', async () => {
      setupKindAuth();
      const captured = captureInsert();

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: { workspaceId: 'ws-1', title: 'Task', kind: 'research', complexity: 'complex' },
      }));

      expect(response.status).toBe(200);
      expect(captured.values.kind).toBe('research');
      expect(captured.values.complexity).toBe('complex');
      // Explicit caller-supplied routing inputs are attributed to the user.
      expect(captured.values.classifiedBy).toBe('user');
    });

    it('rejects an invalid kind with a 400 instead of dropping it', async () => {
      setupKindAuth();
      captureInsert();

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: { workspaceId: 'ws-1', title: 'Task', kind: 'enginering' },
      }));

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('kind must be one of');
    });

    it('rejects an invalid complexity with a 400 instead of dropping it', async () => {
      setupKindAuth();
      captureInsert();

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: { workspaceId: 'ws-1', title: 'Task', complexity: 'medium' },
      }));

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('complexity must be one of');
    });

    it('leaves kind/complexity/classifiedBy unset when omitted', async () => {
      setupKindAuth();
      const captured = captureInsert();

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: { workspaceId: 'ws-1', title: 'Task' },
      }));

      expect(response.status).toBe(200);
      expect(captured.values.kind).toBeUndefined();
      expect(captured.values.complexity).toBeUndefined();
      expect(captured.values.classifiedBy).toBeUndefined();
    });

    it('accepts a kind on its own without a complexity', async () => {
      setupKindAuth();
      const captured = captureInsert();

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: { workspaceId: 'ws-1', title: 'Task', kind: 'observation' },
      }));

      expect(response.status).toBe(200);
      expect(captured.values.kind).toBe('observation');
      expect(captured.values.complexity).toBeUndefined();
    });
  });

  describe('routing preview + heuristic classification', () => {
    function setupRoutingAuth() {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'bld_test' });
      mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
      mockResolveCreatorContext.mockResolvedValue({
        createdByAccountId: 'account-1',
        createdByWorkerId: null,
        creationSource: 'api',
        parentTaskId: null,
      });
    }

    function captureInsert() {
      const createdTask = { id: 'task-routing', workspaceId: 'ws-1', title: 'Task', status: 'pending' };
      const captured: { values: any } = { values: null };
      mockTasksInsert.mockReturnValue({
        values: mock((values: any) => {
          captured.values = values;
          return { returning: mock(() => [createdTask]) };
        }),
      });
      return captured;
    }

    it("names the stated role's floor when it raises the tier", async () => {
      setupRoutingAuth();
      captureInsert();
      mockWorkspaceSkillsFindMany.mockResolvedValue([
        { slug: 'builder', model: 'opus', workspaceId: null, teamId: 'team-1', metadata: null },
      ]);

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: { workspaceId: 'ws-1', title: 'Task', roleSlug: 'builder' },
      }));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.routing.tier).toBe('premium');
      expect(data.routing.reason).toContain('role "builder" floor premium raised standard → premium');
    });

    it('says an inferred role will not change the model when a role-less task has candidates', async () => {
      setupRoutingAuth();
      captureInsert();
      mockWorkspaceSkillsFindMany.mockResolvedValue([
        { slug: 'builder', model: 'opus', workspaceId: null, teamId: 'team-1', metadata: { routing: { whenToUse: 'Code changes that end in a PR' } } },
        { slug: 'researcher', model: 'sonnet', workspaceId: null, teamId: 'team-1', metadata: { routing: { whenToUse: 'Investigate without changing code' } } },
      ]);

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: { workspaceId: 'ws-1', title: 'Task' },
      }));

      const data = await response.json();
      // The candidates' floors do not leak into a role-less task's preview.
      expect(data.routing.tier).toBe('standard');
      expect(data.routing.reason).toContain('an inferred role does not change the model');
    });

    it('echoes a routing preview naming the default when nothing is given', async () => {
      setupRoutingAuth();
      captureInsert();

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: { workspaceId: 'ws-1', title: 'Task' },
      }));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.routing).toEqual({
        tier: 'standard',
        model: 'claude-sonnet-5',
        reason: expect.stringContaining('no kind/complexity given'),
      });
    });

    it('infers and persists a higher complexity from a wide pathManifest, unrequested', async () => {
      setupRoutingAuth();
      const captured = captureInsert();

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workspaceId: 'ws-1',
          title: 'Task',
          pathManifest: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
        },
      }));

      expect(response.status).toBe(200);
      expect(captured.values.kind).toBeUndefined();
      expect(captured.values.complexity).toBe('complex');
      expect(captured.values.classifiedBy).toBe('classifier');
      expect(captured.values.context.routingInferred).toBe(true);
      expect(captured.values.context.routingInferredReason).toContain('6 files');

      const data = await response.json();
      expect(data.routing.tier).toBe('premium');
    });

    it('never overrides an explicit kind/complexity with an inferred one', async () => {
      setupRoutingAuth();
      const captured = captureInsert();

      await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workspaceId: 'ws-1',
          title: 'Task',
          kind: 'writing',
          complexity: 'simple',
          pathManifest: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
        },
      }));

      expect(captured.values.kind).toBe('writing');
      expect(captured.values.complexity).toBe('simple');
      expect(captured.values.classifiedBy).toBe('user');
      expect(captured.values.context.routingInferred).toBeUndefined();
    });

    it('leaves kind/complexity unset when no heuristic rule fires', async () => {
      setupRoutingAuth();
      const captured = captureInsert();

      await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: { workspaceId: 'ws-1', title: 'Task', pathManifest: ['a.ts'] },
      }));

      expect(captured.values.kind).toBeUndefined();
      expect(captured.values.complexity).toBeUndefined();
      expect(captured.values.classifiedBy).toBeUndefined();
      expect(captured.values.context.routingInferred).toBeUndefined();
    });
  });

  describe('emitsPlan (spec-to-build)', () => {
    function setupEmitsPlanAuth() {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'bld_test' });
      mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
      mockResolveCreatorContext.mockResolvedValue({
        createdByAccountId: 'account-1',
        createdByWorkerId: null,
        creationSource: 'api',
        parentTaskId: null,
      });
    }

    function captureInsert() {
      const createdTask = { id: 'task-ep', workspaceId: 'ws-1', title: 'Task', status: 'pending' };
      const captured: { values: any } = { values: null };
      mockTasksInsert.mockReturnValue({
        values: mock((values: any) => {
          captured.values = values;
          return { returning: mock(() => [createdTask]) };
        }),
      });
      return captured;
    }

    it('forces mode: planning and context.requiresPlanApproval: true, overriding whatever the caller passed', async () => {
      setupEmitsPlanAuth();
      const captured = captureInsert();

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workspaceId: 'ws-1',
          title: 'Spec: something',
          description: 'write a spec and propose a breakdown',
          emitsPlan: true,
          pathManifest: ['docs/design/something.md'],
          // Caller tries to undo the forced fields — both must be ignored.
          mode: 'execution',
          context: { requiresPlanApproval: false },
        },
      }));

      expect(response.status).toBe(200);
      expect(captured.values.mode).toBe('planning');
      expect(captured.values.context.requiresPlanApproval).toBe(true);
    });

    it('rejects creation when pathManifest is missing', async () => {
      setupEmitsPlanAuth();
      captureInsert();

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workspaceId: 'ws-1',
          title: 'Spec: something',
          description: 'write a spec and propose a breakdown',
          emitsPlan: true,
        },
      }));

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('emitsPlan: true');
      expect(data.error).toContain('pathManifest');
    });

    it('rejects creation when pathManifest is an empty array', async () => {
      setupEmitsPlanAuth();
      captureInsert();

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workspaceId: 'ws-1',
          title: 'Spec: something',
          emitsPlan: true,
          pathManifest: [],
        },
      }));

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('pathManifest');
    });

    it('leaves mode and requiresPlanApproval untouched for a plain create_task call', async () => {
      setupEmitsPlanAuth();
      const captured = captureInsert();

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: { workspaceId: 'ws-1', title: 'Ordinary task' },
      }));

      expect(response.status).toBe(200);
      expect(captured.values.mode).toBe('execution');
      expect(captured.values.context?.requiresPlanApproval).toBeUndefined();
    });

    // Regression: a mission with an already-active mode:'planning' task hits
    // the partial unique index tasks_active_planning_per_mission at insert.
    // That used to propagate as a raw Postgres 23505, wrapped by the neon-http
    // driver into an opaque "Failed query: insert into tasks..." message and
    // surfaced as a generic 500 — indistinguishable from a real server error.
    it('returns 409 with an actionable message when the mission already has an active planning task', async () => {
      setupEmitsPlanAuth();
      mockTasksInsert.mockReturnValue({
        values: mock(() => ({
          returning: mock(() => {
            const err = new Error('Failed query: insert into "tasks" ("id", ...) values (...)');
            (err as unknown as { cause: unknown }).cause = {
              code: '23505',
              constraint: 'tasks_active_planning_per_mission',
              message: 'duplicate key value violates unique constraint "tasks_active_planning_per_mission"',
            };
            throw err;
          }),
        })),
      });

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workspaceId: 'ws-1',
          title: 'Spec: something',
          emitsPlan: true,
          pathManifest: ['docs/design/something.md'],
          missionId: 'mission-1',
        },
      }));

      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.error).toMatch(/active planning task/i);
    });

    it('still surfaces an unrelated insert failure as a 500, not as the planning-conflict 409', async () => {
      setupEmitsPlanAuth();
      mockTasksInsert.mockReturnValue({
        values: mock(() => ({
          returning: mock(() => {
            throw new Error('connection reset by peer');
          }),
        })),
      });

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_test' },
        body: {
          workspaceId: 'ws-1',
          title: 'Spec: something',
          emitsPlan: true,
          pathManifest: ['docs/design/something.md'],
        },
      }));

      expect(response.status).toBe(500);
    });
  });

  // ── Pre-dispatch subject dedupe ────────────────────────────────────────────
  //
  // prepareSubjectFiling already resolves the incoming anchor against the live
  // tasks in the workspace. The route used to log that verdict and create the
  // task anyway, so an `attach` verdict still dispatched a second agent.

  describe('subject dedupe at creation', () => {
    const FULL_SHA = 'b'.repeat(40);

    function agentAuth() {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAccountsFindFirst.mockResolvedValue({ id: 'account-1', apiKey: 'bld_xxx' });
      mockResolveCreatorContext.mockResolvedValue({
        createdByAccountId: 'account-1',
        createdByWorkerId: null,
        creationSource: 'mcp',
        parentTaskId: null,
      });
      mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
    }

    function post(body: Record<string, unknown>) {
      return POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_xxx' },
        body: { workspaceId: 'ws-1', ...body },
      }));
    }

    it('attaches to the live task instead of dispatching a second agent on the same PR generation', async () => {
      agentAuth();
      mockTasksFindFirst.mockResolvedValue({
        id: 'task-live',
        creationSource: 'mcp',
        title: 'Instrument the cron route',
        description: 'first filing',
      });

      const response = await post({
        title: 'Instrument the cron route',
        context: { prNumber: 4242, headSha: FULL_SHA },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.id).toBe('task-live');
      expect(data.deduplicated).toBe(true);
      // No task row written. The only insert is the subject report.
      const insertedTables = mockTasksInsert.mock.calls.map((c: any) => c[0]);
      expect(insertedTables).toEqual(['taskSubjectReports']);
    });

    it('scopes the live-task lookup to this workspace and to non-terminal tasks', async () => {
      agentAuth();
      mockTasksFindFirst.mockResolvedValue({
        id: 'task-live',
        creationSource: 'mcp',
        title: 'Instrument the cron route',
        description: null,
      });

      await post({ title: 'Instrument the cron route', context: { prNumber: 4242, headSha: FULL_SHA } });

      // Render the predicate. With a mocked db every WHERE clause is otherwise
      // invisible, so a lookup that deduped across workspaces would still pass.
      const probe = mockTasksFindFirst.mock.calls.at(-1)?.[0];
      const flat = JSON.stringify(probe?.where);
      expect(flat).toContain('workspaceId');
      expect(flat).toContain('ws-1');
      expect(flat).toContain('subjectPrNumber');
      expect(flat).toContain('4242');
      expect(flat).toContain('in_progress');
      expect(flat).not.toContain('cancelled');
    });

    it('files anyway, with a link to the canonical task, when fileAnywayReason is given', async () => {
      agentAuth();
      mockTasksFindFirst.mockResolvedValue({
        id: 'task-live',
        creationSource: 'mcp',
        title: 'Instrument the cron route',
        description: null,
      });
      const created = { id: 'task-new', workspaceId: 'ws-1', title: 'Instrument the cron route' };
      mockTasksInsert.mockReturnValue({ values: mock(() => ({ returning: mock(() => [created]) })) });

      const response = await post({
        title: 'Instrument the cron route',
        context: { prNumber: 4242, headSha: FULL_SHA },
        fileAnywayReason: 'different failure mode on the same commit',
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.id).toBe('task-new');
      expect(data.deduplicated).toBeUndefined();
    });

    it('never attaches on a mission-only match — every task in a mission shares that key', async () => {
      agentAuth();
      // A mission anchor with no planner-issued intent id identifies the MISSION,
      // not the work. Attaching on it would refuse every task after the first.
      mockTasksFindFirst.mockResolvedValue({
        id: 'task-sibling',
        creationSource: 'orchestrator',
        title: 'Some other task in the same mission',
        description: null,
      });
      const created = { id: 'task-new', workspaceId: 'ws-1', title: 'Second mission task' };
      mockTasksInsert.mockReturnValue({ values: mock(() => ({ returning: mock(() => [created]) })) });

      const response = await post({
        title: 'Second mission task',
        context: { subjectMissionId: 'mission-1' },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.id).toBe('task-new');
      expect(data.deduplicated).toBeUndefined();
    });

    it('surfaces a suggestion rather than attaching when only the PR lineage matches', async () => {
      agentAuth();
      mockTasksFindFirst.mockResolvedValue({
        id: 'task-live',
        creationSource: 'mcp',
        title: 'Earlier work on the same PR',
        description: null,
      });
      const created = { id: 'task-new', workspaceId: 'ws-1', title: 'Follow-up on PR' };
      mockTasksInsert.mockReturnValue({ values: mock(() => ({ returning: mock(() => [created]) })) });

      // No head SHA → same PR, possibly a different commit. The design is
      // explicit that lineage proposes and never collapses.
      const response = await post({ title: 'Follow-up on PR', context: { prNumber: 4242 } });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.id).toBe('task-new');
      expect(data.deduplicated).toBeUndefined();
      expect(data.duplicateSuggestion).toMatchObject({
        taskId: 'task-live',
        keyType: 'pr_lineage',
        title: 'Earlier work on the same PR',
      });
    });
  });
});

// ── "File the work" resolves a criteria escalation ─────────────────────────
// A task filed against a mission is one of the escalation note's two
// advertised exits. Routed through the single writer (resolveCriteriaEscalation)
// rather than reimplemented here — see criteria-escalation.ts. This exercises
// the fire-and-forget block in POST, which the route never awaits.

/**
 * Let the route's fire-and-forget mission-feed chain finish.
 *
 * NOT a microtask flush, despite what this replaced. The chain awaits three
 * dynamic `import()` calls — mission-feed, then mission-loop, then
 * criteria-escalation — and module resolution does not settle on the microtask
 * queue. A `Promise.resolve()` spin therefore returned while the chain was
 * still two imports away from `resolveCriteriaEscalation`, the assertion read
 * 0 calls, and the test was red from the moment it was written.
 *
 * `predicate` lets the positive case stop as soon as the effect lands instead
 * of paying the full drain, and — more importantly — keeps it from going flaky
 * if a slow module load needs more turns than a fixed count allows. Omit it to
 * drain fully, which is what a "this must NOT happen" assertion needs.
 */
async function settleFireAndForget(predicate?: () => boolean) {
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    if (predicate?.()) return;
  }
}

describe('POST /api/tasks — resolves criteria escalation on mission-scoped task creation', () => {
  beforeEach(() => {
    resolveCriteriaEscalationCalls = [];
    mockResolveCriteriaEscalation.mockClear();
  });

  it('resolves the escalation with reason "work_filed" when a task is created against a mission', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
    mockMissionsFindFirst.mockResolvedValue({ teamId: 'team-1', defaultOutputRequirement: null });
    mockTasksInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(() => [{ id: 'task-1', workspaceId: 'ws-1', title: 'Task', missionId: 'mission-1', status: 'pending' }]),
      })),
    });

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Task', missionId: 'mission-1', pathManifest: ['apps/web/src/lib/foo.ts'] },
    }));
    expect(response.status).toBe(200);

    await settleFireAndForget(() => resolveCriteriaEscalationCalls.length > 0);

    expect(resolveCriteriaEscalationCalls).toHaveLength(1);
    expect(resolveCriteriaEscalationCalls[0].missionId).toBe('mission-1');
    expect(resolveCriteriaEscalationCalls[0].reason).toBe('work_filed');
  });

  it('does not call the helper for a task with no mission', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockResolveCreatorContext.mockResolvedValue({
      createdByAccountId: 'account-123',
      createdByWorkerId: null,
      creationSource: 'api',
      parentTaskId: null,
    });
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1' });
    mockTasksInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(() => [{ id: 'task-2', workspaceId: 'ws-1', title: 'Task', missionId: null, status: 'pending' }]),
      })),
    });

    const response = await POST(createMockRequest({
      method: 'POST',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { workspaceId: 'ws-1', title: 'Task' },
    }));
    expect(response.status).toBe(200);

    // No predicate: a negative assertion has to drain the whole chain, or it
    // passes merely by asserting before the call it is trying to rule out.
    await settleFireAndForget();

    expect(resolveCriteriaEscalationCalls).toHaveLength(0);
  });

  // The organizer's own planning task is created in the SAME request as
  // mission creation (manage_missions create -> runMission()), before the
  // creator who files tasks right after create gets a chance to — so the
  // pre-filed-task heuristic that prompt was frozen with is always stale by
  // the time the organizer actually tries to decompose. This gate re-runs
  // that same check at decomposition time, inside POST /api/tasks itself.
  describe('decomposition re-check gate', () => {
    function organizerCallSetup(overrides: {
      missionRow?: Partial<{ decompositionSkipped: boolean; orchestrationMode: string }>;
      callingTask?: Partial<{ missionId: string; mode: string; creationSource: string; createdAt: Date }> | null;
    } = {}) {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
      mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', teamId: 'team-1', gitConfig: {} });
      mockMissionsFindFirst.mockResolvedValue({
        id: 'mission-1',
        teamId: 'team-1',
        defaultOutputRequirement: 'none',
        defaultBackend: null,
        startAt: null,
        decompositionSkipped: false,
        orchestrationMode: 'auto',
        ...overrides.missionRow,
      });
      mockWorkersFindFirst.mockResolvedValue({ taskId: 'organizer-task-1' });
      const callingTaskOverride = overrides.callingTask;
      mockTasksFindFirst.mockResolvedValue(
        callingTaskOverride === null
          ? null
          : {
              id: 'organizer-task-1',
              missionId: 'mission-1',
              mode: 'planning',
              creationSource: 'orchestrator',
              createdAt: new Date('2026-01-01T00:00:00Z'),
              ...callingTaskOverride,
            },
      );
    }

    it('refuses a decomposition create when sibling tasks were pre-filed after the organizer planning task started', async () => {
      organizerCallSetup();
      mockTasksFindMany.mockResolvedValue([{ id: 'sibling-1' }, { id: 'sibling-2' }]);

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_xxx' },
        body: {
          workspaceId: 'ws-1',
          title: 'Decomposed build task',
          missionId: 'mission-1',
          createdByWorkerId: 'worker-organizer',
        },
      }));

      // 409 (rather than the 200 a successful create_task returns) is itself
      // the proof the task was never inserted — db.insert is one shared mock
      // for every table this route writes (tasks AND missionNotes), so a call
      // count on it conflates "the guard's own note insert ran" with "a task
      // insert ran" and can't distinguish them.
      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.error).toMatch(/decomposition refused/i);
      expect(data.decompositionSkipped).toBe(true);
      expect(data.preFiledTaskIds).toEqual(['sibling-1', 'sibling-2']);
    });

    it('keeps refusing later decomposition creates in the same pass even after decompositionSkipped is already set', async () => {
      // The exact shape of the original incident: the organizer creates
      // several sibling build tasks back to back in one decomposition pass.
      // The first refusal persists decompositionSkipped=true; a naive guard
      // that re-reads the flag before deciding whether to check at all would
      // let every create AFTER the first one through.
      organizerCallSetup({ missionRow: { decompositionSkipped: true } });
      mockTasksFindMany.mockResolvedValue([{ id: 'sibling-1' }]);

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_xxx' },
        body: {
          workspaceId: 'ws-1',
          title: 'Second decomposed build task',
          missionId: 'mission-1',
          createdByWorkerId: 'worker-organizer',
        },
      }));

      expect(response.status).toBe(409);
    });

    it('allows a retry child even when sibling tasks exist, as long as parentTaskId is explicit', async () => {
      organizerCallSetup();
      mockTasksFindMany.mockResolvedValue([{ id: 'sibling-1' }]);
      mockTasksInsert.mockReturnValue({
        values: mock(() => ({
          returning: mock(() => [{ id: 'retry-task', workspaceId: 'ws-1', title: 'Retry failed build', missionId: 'mission-1' }]),
        })),
      });

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_xxx' },
        body: {
          workspaceId: 'ws-1',
          title: 'Retry failed build',
          missionId: 'mission-1',
          createdByWorkerId: 'worker-organizer',
          parentTaskId: 'failed-task-1',
        },
      }));

      expect(response.status).toBe(200);
      expect(mockTasksInsert).toHaveBeenCalled();
    });

    it('does not refuse a creator filing their own pre-filed tasks (calling worker is not the organizer)', async () => {
      // The guard must only fire when the CALLER is the mission's own
      // planning/organizer task — otherwise the creator's own second and
      // third pre-filed tasks would trip over the first one they just filed.
      organizerCallSetup({ callingTask: { mode: 'execution', creationSource: 'mcp' } });
      mockTasksFindMany.mockResolvedValue([{ id: 'sibling-1' }]);
      mockTasksInsert.mockReturnValue({
        values: mock(() => ({
          returning: mock(() => [{ id: 'creator-task-2', workspaceId: 'ws-1', title: 'Second pre-filed task', missionId: 'mission-1' }]),
        })),
      });

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_xxx' },
        body: {
          workspaceId: 'ws-1',
          title: 'Second pre-filed task',
          missionId: 'mission-1',
          createdByWorkerId: 'creator-worker',
        },
      }));

      expect(response.status).toBe(200);
      expect(mockTasksInsert).toHaveBeenCalled();
    });

    it('does not refuse on a manual-orchestration mission', async () => {
      organizerCallSetup({ missionRow: { orchestrationMode: 'manual' } });
      mockTasksFindMany.mockResolvedValue([{ id: 'sibling-1' }]);
      mockTasksInsert.mockReturnValue({
        values: mock(() => ({
          returning: mock(() => [{ id: 'manual-task', workspaceId: 'ws-1', title: 'Manual mission task', missionId: 'mission-1' }]),
        })),
      });

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_xxx' },
        body: {
          workspaceId: 'ws-1',
          title: 'Manual mission task',
          missionId: 'mission-1',
          createdByWorkerId: 'worker-organizer',
        },
      }));

      expect(response.status).toBe(200);
      expect(mockTasksInsert).toHaveBeenCalled();
    });

    it('allows decomposition when no sibling tasks were pre-filed (regression)', async () => {
      organizerCallSetup();
      mockTasksFindMany.mockResolvedValue([]);
      mockTasksInsert.mockReturnValue({
        values: mock(() => ({
          returning: mock(() => [{ id: 'first-build-task', workspaceId: 'ws-1', title: 'First build task', missionId: 'mission-1' }]),
        })),
      });

      const response = await POST(createMockRequest({
        method: 'POST',
        headers: { Authorization: 'Bearer bld_xxx' },
        body: {
          workspaceId: 'ws-1',
          title: 'First build task',
          missionId: 'mission-1',
          createdByWorkerId: 'worker-organizer',
        },
      }));

      expect(response.status).toBe(200);
      expect(mockTasksInsert).toHaveBeenCalled();
    });
  });
});
