import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Model-tier ceilings (docs/specs/model-tier-ceilings.md): the real rule over
// a per-test policy instead of the DB. No ceiling unless a test sets one.
const { resolveTierCeiling: realResolveTierCeiling } = await import('@buildd/shared');
const ceilingTest = { inputs: {} as Record<string, any> };
const fakeCeiling = async (s: any, surface: any) => {
  const userId = typeof s.userId === 'function' ? await s.userId() : s.userId ?? null;
  return realResolveTierCeiling({
    team: ceilingTest.inputs.team ?? null, workspaceId: s.workspaceId ?? null, userId,
    member: userId ? ceilingTest.inputs.members?.[userId] ?? null : null,
  }, surface);
};
mock.module('@buildd/core/model-tier-ceiling-store', () => ({
  loadTierCeiling: fakeCeiling,
  tierCeilingLoader: () => fakeCeiling,
}));
// No network: an exact model pin is banded by family when the catalog is empty.
mock.module('@buildd/core/model-catalog-cache', () => ({ getCachedOpenRouterCatalog: async () => [] }));


const TASK_ID = '11111111-1111-1111-1111-111111111111';
const MISSING_TASK_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockWorkersFindFirst = mock(() => Promise.resolve(null as any));
const mockWorkersFindMany = mock(() => Promise.resolve([] as any[]));
const mockArtifactsFindMany = mock(() => Promise.resolve([] as any[]));
const mockTasksUpdate = mock(() => ({ set: mock(() => ({ where: mock(() => ({ returning: mock(() => []) })) })) }));
const mockTasksDelete = mock(() => ({ where: mock(() => Promise.resolve()) }));
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));
const mockTriggerEvent = mock(() => Promise.resolve());
const mockReleaseAndNotify = mock(() => Promise.resolve());
const mockResolveCompletedTask = mock(() => Promise.resolve());
const mockWakeTask = mock(async (_id: string, _cause: string) => {});
const mockTasksFindMany = mock(() => Promise.resolve([] as any[]));
const mockWorkspaceSkillsFindMany = mock((_args?: any) => Promise.resolve([] as any[]));

// Who a task is for (task → parents → mission → schedule); the walk itself is
// covered in packages/core. Records what it was asked about.
let requesterAnswer: string | null = null;
const requesterLookups: any[] = [];
mock.module('@buildd/core/task-requester', () => ({
  resolveTaskRequesterUserId: async (task: any) => { requesterLookups.push(task); return requesterAnswer; },
  requesterOf: async (task: any) => { requesterLookups.push(task); return requesterAnswer; },
}));

const mockDispatchHistory = mock(async (_taskId: string) => [] as any[]);
mock.module('@buildd/core/dispatch-outbox', () => ({ dispatchHistoryForTask: mockDispatchHistory }));
const mockReadTaskEstimate = mock(async (_taskId: string) => null as any);
mock.module('@buildd/core/task-estimate-source', () => ({ readTaskEstimate: mockReadTaskEstimate }));

mock.module('@/lib/task-dependencies', () => ({
  resolveCompletedTask: mockResolveCompletedTask,
}));
mock.module('@/lib/dispatch-authority', () => ({
  wakeTask: mockWakeTask,
  wakeTasks: async () => {},
  announceTaskCreated: async () => {},
  kickDispatch: () => {},
  enqueueTaskDispatch: async () => {},
  drainDispatchOutbox: async () => ({}),
  deliverTaskDispatch: async () => 'skipped:test',
  routeForCause: () => ({}),
  webhookWants: () => false,
  primaryCause: (_c: readonly string[], fallback: string) => fallback,
  reseedDispatchTimer: async () => {},
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
}));

// Mock auth-helpers
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// Mock api-auth - authenticateApiKey delegates to mockAccountsFindFirst
mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: async (apiKey: string | null) => {
    if (!apiKey) return null;
    return mockAccountsFindFirst();
  },
  hashApiKey: (key: string) => `hashed_${key}`,
  extractApiKeyPrefix: (key: string) => key.substring(0, 12),
}));

// Mock task-token functions to allow testing without real tokens
mock.module('@/lib/task-token', () => ({
  isTaskToken: (key: string | null) => key?.startsWith('bldt_') || false,
  verifyTaskToken: (token: string) => {
    // For test purposes, parse a mock token format bldt_<taskId>_<workspaceId>
    if (!token.startsWith('bldt_')) return null;
    return {
      taskId: 'task-1',  // Default mock value
      workspaceId: 'ws-1',  // Will be overridden by test setup
      accountId: 'account-123',
      keyBinding: 'hash-1',
      level: 'worker',
      expiresAt: Date.now() + 60_000,
    };
  },
  taskTokenKeyBinding: (apiKey: string) => 'hash-1',
  canMintAdminTaskToken: () => false,
  missingTaskTokenScopes: () => [],
}));

// Mock team-access
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

const mockIsMissionLinkable = mock(() => Promise.resolve(true));
const mockEmit = mock(async (_event: any) => {});
mock.module('@/lib/core-emit', () => ({ emit: mockEmit }));
const leftMission = () => mockEmit.mock.calls.map(c => c[0]).filter((e: any) => e.type === 'task.left_mission');
mock.module('@/lib/mission-link-scope', () => ({
  isMissionLinkable: mockIsMissionLinkable,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: mockAccountsFindFirst },
      tasks: { findFirst: mockTasksFindFirst, findMany: mockTasksFindMany },
      workers: { findFirst: mockWorkersFindFirst, findMany: mockWorkersFindMany },
      artifacts: { findMany: mockArtifactsFindMany },
      workspaceSkills: { findMany: mockWorkspaceSkillsFindMany },
    },
    update: mockTasksUpdate,
    delete: mockTasksDelete,
  },
}));

// Mock path-claim-release
mock.module('@/lib/path-claim-release', () => ({
  releaseAndNotify: mockReleaseAndNotify,
}));

// Mock Pusher
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: {
    workspace: (id: string) => `workspace-${id}`,
    task: (id: string) => `task-${id}`,
    worker: (id: string) => `worker-${id}`,
    mission: (id: string) => `mission-${id}`,
  },
  events: {
    WORKER_COMMAND: 'worker:command',
    TASK_UPDATED: 'task:updated',
  },
}));

// Mock path-claim-release
mock.module('@/lib/path-claim-release', () => ({
  releaseAndNotify: mockReleaseAndNotify,
}));

// Mock drizzle-orm
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ type: 'and', args }),
  inArray: (field: any, values: any) => ({ field, values, type: 'inArray' }),
  desc: (field: any) => ({ field, type: 'desc' }),
  or: (...args: any[]) => ({ type: 'or', args }),
  isNull: (field: any) => ({ field, type: 'isNull' }),
}));

// Mock schema
mock.module('@buildd/core/db/schema', () => ({
  accounts: { apiKey: 'apiKey' },
  tasks: { id: 'id' },
  workers: { taskId: 'taskId', createdAt: 'createdAt' },
  artifacts: { workerId: 'workerId', updatedAt: 'updatedAt' },
  workspaces: {},
  workspaceSkills: {
    teamId: 'ws_skills.team_id', workspaceId: 'ws_skills.workspace_id', slug: 'ws_skills.slug',
    isRole: 'ws_skills.is_role', ownerUserId: 'ws_skills.owner_user_id', visibility: 'ws_skills.visibility',
  },
}));

// Import handlers AFTER mocks
import { GET, PATCH, DELETE } from './route';

// Helper to create mock NextRequest
function createMockRequest(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  search?: string;
} = {}): NextRequest {
  const { method = 'GET', headers = {}, body, search = '' } = options;

  const url = `http://localhost:3000/api/tasks/test-task-id${search}`;
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

// Helper to call route handler with params
async function callHandler(
  handler: Function,
  request: NextRequest,
  id: string
) {
  return handler(request, { params: Promise.resolve({ id }) });
}

describe('GET /api/tasks/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();

    // Default: grant access
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await callHandler(GET, request, TASK_ID);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns task for API key auth', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      description: 'Test description',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await callHandler(GET, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe(TASK_ID);
    expect(data.title).toBe('Test Task');
  });

  it('hides every other task from a per-task token, and still serves its own', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
      parentTaskId: null,
    };
    mockGetCurrentUser.mockResolvedValue(null);
    mockTasksFindFirst.mockResolvedValue(mockTask);

    mockAccountsFindFirst.mockResolvedValue({
      id: 'account-123', level: 'worker', taskScope: { taskId: 'some-other-task', expiresAt: Date.now() + 60_000 },
    });
    const refused = await callHandler(GET, createMockRequest({ headers: { Authorization: 'Bearer bld_xxx' } }), TASK_ID);
    expect(refused.status).toBe(404);
    // Now that we support child tasks, the route must fetch the task to check if it's a child task

    mockAccountsFindFirst.mockResolvedValue({
      id: 'account-123', level: 'worker', taskScope: { taskId: TASK_ID, expiresAt: Date.now() + 60_000 },
    });
    const served = await callHandler(GET, createMockRequest({ headers: { Authorization: 'Bearer bld_xxx' } }), TASK_ID);
    expect(served.status).toBe(200);
  });

  it('allows a per-task token to read its own child tasks', async () => {
    const parentTaskId = '22222222-2222-2222-2222-222222222222';
    const childTaskId = '33333333-3333-3333-3333-333333333333';
    const mockChildTask = {
      id: childTaskId,
      title: 'Child Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
      parentTaskId,
      missionId: null,
      mission: null,
    };
    mockGetCurrentUser.mockResolvedValue(null);
    mockTasksFindFirst.mockResolvedValue(mockChildTask);

    mockAccountsFindFirst.mockResolvedValue({
      id: 'account-123', level: 'worker', taskScope: { taskId: parentTaskId, workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 },
    });
    // Use regular API key format (bld_xxx), not task token format, so authenticateApiKey handles it
    const response = await callHandler(GET, createMockRequest({ headers: { Authorization: 'Bearer bld_xxx' } }), childTaskId);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe(childTaskId);
    expect(data.parentTaskId).toBe(parentTaskId);
  });

  it("lets a task token read any task in its own workspace, and nothing outside it", async () => {
    const OWN = '22222222-2222-4222-8222-222222222222';
    const sibling = (over: Record<string, unknown>) => ({
      id: TASK_ID, title: 'Sibling', status: 'pending', workspaceId: 'ws-1', missionId: 'm-1',
      workspace: { id: 'ws-1', teamId: 'team-1' }, ...over,
    });
    let row: any = sibling({});
    // The route's read of the task, and the scope helper's read of the token's own task.
    mockTasksFindFirst.mockImplementation(async (args: any) =>
      args?.with?.mission?.columns?.initiativeId ? { missionId: 'm-1', workspaceId: 'ws-1', mission: { initiativeId: null } } : row);
    mockGetCurrentUser.mockResolvedValue(null);
    const get = () => callHandler(GET, createMockRequest({ headers: { Authorization: 'Bearer bld_xxx' } }), TASK_ID);
    const taskScope = { taskId: OWN, workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 };

    // Any task token may READ any task in its own workspace (the tasks
    // list_tasks shows it), on its mission or not, and nothing outside it.
    for (const level of ['admin', 'worker']) {
      mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', level, taskScope });
      row = sibling({});
      expect((await get()).status).toBe(200);
      row = sibling({ missionId: 'm-2' });
      expect((await get()).status).toBe(200);
      row = sibling({ missionId: null });
      expect((await get()).status).toBe(200);
      row = sibling({ workspaceId: 'ws-2' });
      expect((await get()).status).toBe(404);
    }
    mockTasksFindFirst.mockReset();
  });

  it('never returns the workspace dispatch token, to a per-task token or an account key', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1', webhookConfig: { url: 'https://dispatch.example.invalid/dispatch', token: 'dispatch-secret', enabled: true } },
    };
    mockGetCurrentUser.mockResolvedValue(null);
    for (const caller of [
      { id: 'account-123', level: 'worker', taskScope: { taskId: TASK_ID, workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 } },
      { id: 'account-123', level: 'worker' },
    ]) {
      mockTasksFindFirst.mockResolvedValue(mockTask);
      mockAccountsFindFirst.mockResolvedValue(caller);
      const res = await callHandler(GET, createMockRequest({ headers: { Authorization: 'Bearer bld_xxx' } }), TASK_ID);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain('dispatch-secret');
      expect(JSON.parse(text).workspace.webhookConfig.url).toBe('https://dispatch.example.invalid/dispatch');
    }
  });

  it('returns task for session auth when user owns workspace', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      description: 'Test description',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest();
    const response = await callHandler(GET, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe(TASK_ID);
  });

  it('returns 404 when task not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await callHandler(GET, request, MISSING_TASK_ID);

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('returns 404 when session user does not own workspace', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await callHandler(GET, request, TASK_ID);

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('allows API key auth to access tasks regardless of workspace ownership', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await callHandler(GET, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe(TASK_ID);
  });

  it('returns workers and artifacts when include=workers,artifacts', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w-1', status: 'completed', branch: 'feat/x', prUrl: 'https://github.com/o/r/pull/1' },
    ] as any);
    mockArtifactsFindMany.mockResolvedValue([
      // A shareUrl is only emitted while the artifact is public.
      { id: 'a-1', title: 'Summary', type: 'summary', shareToken: 'tok1', visibility: 'public', workerId: 'w-1' },
    ] as any);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
      search: '?include=workers,artifacts',
    });
    const response = await callHandler(GET, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(Array.isArray(data.workers)).toBe(true);
    expect(data.workers[0].id).toBe('w-1');
    expect(Array.isArray(data.artifacts)).toBe(true);
    expect(data.artifacts[0].id).toBe('a-1');
    expect(data.artifacts[0].shareUrl).toContain('/share/tok1');
  });

  it('surfaces rejectedCompletionPayload for a gate-rejected worker via include=workers', async () => {
    // Regression: a completion refused by the outputRequirement gate
    // (artifact_required, no artifact) persists the agent's summary onto
    // workers.rejectedCompletionPayload, but nothing read it back — get_task
    // showed no trace of a 54-turn run beyond the raw 400 in worker.error.
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockWorkersFindMany.mockReset();
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'w-1',
        status: 'failed',
        branch: 'buildd/recon',
        rejectedCompletionPayload: {
          reason: 'artifact_required',
          summary: 'Findings from a 54-turn research run.',
          structuredOutput: null,
          summarySource: 'fallback',
          rejectedAt: '2026-09-20T12:41:21.137Z',
          salvagedArtifactId: 'art-salvage-1',
        },
      },
    ] as any);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
      search: '?include=workers',
    });
    const response = await callHandler(GET, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.workers[0].rejectedCompletionPayload.reason).toBe('artifact_required');
    expect(data.workers[0].rejectedCompletionPayload.summary).toContain('54-turn research run');
    expect(data.workers[0].rejectedCompletionPayload.salvagedArtifactId).toBe('art-salvage-1');

    // The column must actually be requested from the DB, not just passed
    // through when present by accident.
    const callArgs = mockWorkersFindMany.mock.calls[0]?.[0] as any;
    expect(callArgs?.columns?.rejectedCompletionPayload).toBe(true);
  });

  it('include=dispatch returns the task\'s outbox trail; not read otherwise', async () => {
    const mockTask = { id: TASK_ID, title: 'Test Task', workspaceId: 'ws-1', workspace: { id: 'ws-1', teamId: 'team-1' } };
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockDispatchHistory.mockClear();
    const entry = { id: 'o-1', cause: 'task.created', status: 'handed_off', transport: 'dispatch', handedOffAt: '2026-10-04T12:00:00.000Z', deliveredVia: null, attemptCount: 1, lastError: null };
    mockDispatchHistory.mockResolvedValueOnce([entry]);

    const res = await callHandler(GET, createMockRequest({ headers: { Authorization: 'Bearer bld_xxx' }, search: '?include=dispatch' }), TASK_ID);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.dispatch).toEqual([entry]);
    expect(mockDispatchHistory).toHaveBeenCalledWith(TASK_ID);
    expect(data.workers).toBeUndefined();

    mockDispatchHistory.mockClear();
    const plain = await (await callHandler(GET, createMockRequest({ headers: { Authorization: 'Bearer bld_xxx' } }), TASK_ID)).json();
    expect(plain.dispatch).toBeUndefined();
    expect(mockDispatchHistory).not.toHaveBeenCalled();
  });

  it('include=estimate returns the frozen estimate (task-estimates experiment); absent row or no include = no field', async () => {
    const mockTask = { id: TASK_ID, title: 'Test Task', workspaceId: 'ws-1', workspace: { id: 'ws-1', teamId: 'team-1' } };
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockReadTaskEstimate.mockClear();
    mockReadTaskEstimate.mockResolvedValueOnce({
      id: 'e-1', teamId: 'team-1', workspaceId: 'ws-1', taskId: TASK_ID, estimatorVersion: 'blend-v1',
      p50Minutes: 40, p80Minutes: 70, p50Tokens: 120000, p80Tokens: 220000, expectedRepairs: 0.3,
      explanation: { sources: [], clusterLabel: null, priorWeight: 1, summary: '40m (25-70m), 120k tokens.' },
      createdAt: '2026-10-04T12:00:00.000Z',
    });
    const req = (search?: string) => createMockRequest({ headers: { Authorization: 'Bearer bld_xxx' }, ...(search ? { search } : {}) });

    const data = await (await callHandler(GET, req('?include=estimate'), TASK_ID)).json();
    expect(mockReadTaskEstimate).toHaveBeenCalledWith(TASK_ID);
    expect(data.estimate).toEqual({
      estimatorVersion: 'blend-v1', p50Minutes: 40, p80Minutes: 70, p50Tokens: 120000, p80Tokens: 220000,
      expectedRepairs: 0.3, summary: '40m (25-70m), 120k tokens.', createdAt: '2026-10-04T12:00:00.000Z',
    });

    mockReadTaskEstimate.mockResolvedValueOnce(null);
    expect((await (await callHandler(GET, req('?include=estimate'), TASK_ID)).json()).estimate).toBeUndefined();

    // A read failure is "no estimate", never a failed get_task.
    mockReadTaskEstimate.mockRejectedValueOnce(new Error('db down'));
    const failed = await callHandler(GET, req('?include=estimate'), TASK_ID);
    expect(failed.status).toBe(200);
    expect((await failed.json()).estimate).toBeUndefined();

    mockReadTaskEstimate.mockClear();
    expect((await (await callHandler(GET, req(), TASK_ID)).json()).estimate).toBeUndefined();
    expect(mockReadTaskEstimate).not.toHaveBeenCalled();
  });

  it('omits workers/artifacts when include is not requested', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockWorkersFindMany.mockReset();

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await callHandler(GET, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.workers).toBeUndefined();
    expect(data.artifacts).toBeUndefined();
    expect(mockWorkersFindMany).not.toHaveBeenCalled();
  });

  it('prefers API key auth over session auth when both present', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    // Session auth would fail (different owner), but API key should succeed
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest({
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await callHandler(GET, request, TASK_ID);

    // Should succeed because API key auth bypasses ownership check
    expect(response.status).toBe(200);
  });

  it('returns 400 with helpful message for an 8-character ID prefix', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });

    const request = createMockRequest({ headers: { Authorization: 'Bearer bld_xxx' } });
    const response = await callHandler(GET, request, 'b833be4b');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toMatch(/UUID/);
    expect(data.error).toMatch(/prefix/);
  });

  it('returns 400 for a completely invalid taskId format', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });

    const request = createMockRequest({ headers: { Authorization: 'Bearer bld_xxx' } });
    const response = await callHandler(GET, request, 'not-a-valid-id');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toMatch(/UUID/);
  });
});

describe('PATCH /api/tasks/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockWorkersFindFirst.mockReset();
    mockTasksUpdate.mockReset();
    mockTriggerEvent.mockReset();
    mockTriggerEvent.mockResolvedValue(undefined);
    mockReleaseAndNotify.mockReset();
    mockReleaseAndNotify.mockResolvedValue(undefined);
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();

    // Default: grant access, no active worker
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockWorkersFindFirst.mockResolvedValue(null);
    mockResolveCompletedTask.mockReset();
    mockResolveCompletedTask.mockResolvedValue(undefined);
    mockWakeTask.mockClear();
    mockTasksFindMany.mockReset();
    mockTasksFindMany.mockResolvedValue([]);
    mockIsMissionLinkable.mockReset();
    mockIsMissionLinkable.mockResolvedValue(true);
  });

  // Review of #3053: a dependsOn edge may only name tasks in the task's own
  // workspace (POST already enforces this); PATCH accepted any string.
  describe('dependsOn workspace scope', () => {
    const task = {
      id: TASK_ID, title: 'T', status: 'pending', mode: 'execution', missionId: null,
      dependsOn: [], workspaceId: 'ws-1', workspace: { id: 'ws-1', teamId: 'team-1', name: 'ws' },
    };
    function setup() {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
      mockTasksFindFirst.mockResolvedValue(task);
      mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => ({ returning: mock(() => [task]) })) })) });
    }

    it('refuses a dependency outside the task\'s workspace and writes nothing', async () => {
      setup();
      mockTasksFindMany.mockResolvedValueOnce([{ id: 'dep-own' }]);
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { dependsOn: ['dep-own', 'dep-elsewhere'] } }), TASK_ID);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('dep-elsewhere');
      expect(mockTasksUpdate).not.toHaveBeenCalled();
      const where = (mockTasksFindMany.mock.calls.at(-1) as any[])[0].where;
      expect(JSON.stringify(where)).toContain('ws-1');
    });

    it('accepts dependencies that are all in the workspace', async () => {
      setup();
      mockTasksFindMany.mockResolvedValueOnce([{ id: 'dep-own' }]);
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { dependsOn: ['dep-own'] } }), TASK_ID);
      expect(res.status).toBe(200);
    });

    it('a task cannot depend on itself', async () => {
      setup();
      mockTasksFindMany.mockResolvedValueOnce([{ id: TASK_ID }]);
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { dependsOn: [TASK_ID] } }), TASK_ID);
      expect(res.status).toBe(400);
    });
  });

  // A roleSlug edit is held to the same rule as creation (role-visibility.ts):
  // another member's private role is refused, never saved.
  describe('roleSlug visibility', () => {
    const task = {
      id: TASK_ID, title: 'T', status: 'pending', mode: 'execution', missionId: null,
      roleSlug: null, createdByUserId: 'u-alice', parentTaskId: null, scheduleId: null,
      dependsOn: [], workspaceId: 'ws-1', workspace: { id: 'ws-1', teamId: 'team-1', name: 'ws' },
    };
    const role = (o: Record<string, unknown>) => ({
      id: 'r-1', slug: 'helper', workspaceId: null, teamId: 'team-1', ownerUserId: null,
      visibility: 'team', enabled: true, defaultBackend: null, ...o,
    });
    let setCalls: any[] = [];
    function setup(rows: any[]) {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
      mockTasksFindFirst.mockResolvedValue(task);
      mockWorkspaceSkillsFindMany.mockReset();
      mockWorkspaceSkillsFindMany.mockResolvedValue(rows);
      requesterAnswer = 'u-alice';
      requesterLookups.length = 0;
      setCalls = [];
      mockTasksUpdate.mockReturnValue({
        set: mock((data: any) => { setCalls.push(data); return { where: mock(() => ({ returning: mock(() => [{ ...task, ...data }]) })) }; }),
      });
    }

    it("refuses another member's private role with 400 role_not_visible and writes nothing", async () => {
      setup([role({ id: 'r-bob', slug: 'bobs-helper', ownerUserId: 'u-bob', visibility: 'private' })]);
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { roleSlug: 'bobs-helper' } }), TASK_ID);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.gateReason).toBe('role_not_visible');
      expect(data.error).toContain('private role');
      expect(mockTasksUpdate).not.toHaveBeenCalled();
      // Scoped to the task's team and slug, and decided for the task's requester.
      const where = JSON.stringify((mockWorkspaceSkillsFindMany.mock.calls.at(-1) as any[])[0].where);
      expect(where).toContain('team-1');
      expect(where).toContain('bobs-helper');
      expect(requesterLookups.at(-1)).toMatchObject({ id: TASK_ID, createdByUserId: 'u-alice' });
    });

    it("saves the requester's own private role", async () => {
      setup([role({ id: 'r-alice', slug: 'my-helper', ownerUserId: 'u-alice', visibility: 'private' })]);
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { roleSlug: 'my-helper' } }), TASK_ID);
      expect(res.status).toBe(200);
      expect(setCalls[0].roleSlug).toBe('my-helper');
    });

    it('saves a shared personal role', async () => {
      setup([role({ id: 'r-bob', slug: 'bobs-helper', ownerUserId: 'u-bob', visibility: 'team' })]);
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { roleSlug: 'bobs-helper' } }), TASK_ID);
      expect(res.status).toBe(200);
      expect(setCalls[0].roleSlug).toBe('bobs-helper');
    });

    it('saves a team role without resolving the requester', async () => {
      setup([role({ slug: 'builder' })]);
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { roleSlug: 'builder' } }), TASK_ID);
      expect(res.status).toBe(200);
      expect(setCalls[0].roleSlug).toBe('builder');
      expect(requesterLookups).toEqual([]);
    });

    it('decides for the requester of the mission being linked in the same PATCH', async () => {
      setup([role({ id: 'r-bob', slug: 'bobs-helper', ownerUserId: 'u-bob', visibility: 'private' })]);
      mockTasksFindFirst.mockResolvedValue({ ...task, createdByUserId: null });
      requesterAnswer = 'u-bob';
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { roleSlug: 'bobs-helper', missionId: 'm-bob' } }), TASK_ID);
      expect(res.status).toBe(200);
      expect(requesterLookups.at(-1)).toMatchObject({ missionId: 'm-bob' });
      expect(setCalls[0].roleSlug).toBe('bobs-helper');
    });

    it('clearing the role needs no lookup', async () => {
      setup([]);
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { roleSlug: null } }), TASK_ID);
      expect(res.status).toBe(200);
      expect(mockWorkspaceSkillsFindMany).not.toHaveBeenCalled();
      expect(setCalls[0].roleSlug).toBeNull();
    });
  });

  // Friction task 2a201508: PATCH silently ignored pathManifest, echoing the
  // OLD value back with 200 and no error. Narrowing it has no matching
  // "release the dropped claim" path, so it must be rejected outright.
  describe('pathManifest is immutable via PATCH', () => {
    const task = {
      id: TASK_ID, title: 'T', status: 'pending', mode: 'execution', missionId: null,
      dependsOn: [], pathManifest: ['a.ts', 'b.ts'], workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'ws' },
    };
    function setup() {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
      mockTasksFindFirst.mockResolvedValue(task);
    }

    it('rejects a narrowed pathManifest with 400 and writes nothing', async () => {
      setup();
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { pathManifest: ['a.ts'] } }), TASK_ID);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('pathManifest is immutable');
      expect(mockTasksUpdate).not.toHaveBeenCalled();
    });

    it('rejects even a no-op pathManifest (same value) rather than silently succeeding', async () => {
      setup();
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { pathManifest: ['a.ts', 'b.ts'] } }), TASK_ID);
      expect(res.status).toBe(400);
      expect(mockTasksUpdate).not.toHaveBeenCalled();
    });
  });

  describe('mission link scope', () => {
    const task = {
      id: TASK_ID,
      title: 'Test Task',
      status: 'pending',
      mode: 'execution',
      missionId: null,
      dependsOn: [],
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'ws' },
    };

    function setup() {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
      mockTasksFindFirst.mockResolvedValue(task);
      const mockWhere = mock(() => ({ returning: mock(() => [{ ...task, missionId: 'm-1' }]) }));
      mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mockWhere })) });
    }

    it("refuses to link a mission outside the task's team with 404 and writes nothing", async () => {
      setup();
      mockIsMissionLinkable.mockResolvedValue(false);
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { missionId: 'm-1' } }), TASK_ID);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Mission not found' });
      expect(mockIsMissionLinkable).toHaveBeenCalledWith('m-1', 'team-1');
      expect(mockTasksUpdate).not.toHaveBeenCalled();
    });

    it('links a mission in the same team', async () => {
      setup();
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { missionId: 'm-1' } }), TASK_ID);
      expect(res.status).toBe(200);
      expect(mockIsMissionLinkable).toHaveBeenCalledWith('m-1', 'team-1');
      expect(mockTasksUpdate).toHaveBeenCalled();
    });

    it('unlinking (missionId null) needs no mission lookup', async () => {
      setup();
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { missionId: null } }), TASK_ID);
      expect(res.status).toBe(200);
      expect(mockIsMissionLinkable).not.toHaveBeenCalled();
    });

    it('unlinking a task tells the modules it left the mission (the surface audit drops its edge)', async () => {
      mockEmit.mockClear();
      mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
      mockTasksFindFirst.mockResolvedValue({ ...task, missionId: 'm-1' });
      const mockWhere = mock(() => ({ returning: mock(() => [{ ...task, missionId: null }]) }));
      mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mockWhere })) });
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { missionId: null } }), TASK_ID);
      expect(res.status).toBe(200);
      expect(leftMission()).toEqual([{ type: 'task.left_mission', taskId: TASK_ID, missionId: 'm-1', workspaceId: 'ws-1' }]);
    });

    it('moving a task to another mission says it left the old one', async () => {
      mockEmit.mockClear();
      mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
      mockTasksFindFirst.mockResolvedValue({ ...task, missionId: 'm-old' });
      const mockWhere = mock(() => ({ returning: mock(() => [{ ...task, missionId: 'm-1' }]) }));
      mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mockWhere })) });
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { missionId: 'm-1' } }), TASK_ID);
      expect(res.status).toBe(200);
      expect(leftMission()).toEqual([{ type: 'task.left_mission', taskId: TASK_ID, missionId: 'm-old', workspaceId: 'ws-1' }]);
    });

    it('linking a task that had no mission emits no departure', async () => {
      mockEmit.mockClear();
      setup();
      await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { missionId: 'm-1' } }), TASK_ID);
      expect(leftMission()).toEqual([]);
    });
  });

  describe('status-change side effects', () => {
    const baseTask = {
      id: TASK_ID,
      title: 'Test Task',
      status: 'assigned',
      mode: 'execution',
      missionId: null,
      dependsOn: [],
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1', name: 'ws' },
    };

    function setup(task: Record<string, unknown>, updated: Record<string, unknown>) {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
      mockTasksFindFirst.mockResolvedValue(task);
      const mockWhere = mock(() => ({ returning: mock(() => [updated]) }));
      mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mockWhere })) });
    }

    async function patch(body: Record<string, unknown>) {
      return callHandler(PATCH, createMockRequest({ method: 'PATCH', body }), TASK_ID);
    }

    it('manual complete on a task with no missionId runs resolveCompletedTask', async () => {
      setup(baseTask, { ...baseTask, status: 'completed' });
      const res = await patch({ status: 'completed' });
      expect(res.status).toBe(200);
      expect(mockResolveCompletedTask).toHaveBeenCalledWith(TASK_ID, 'ws-1');
    });

    it('manual fail runs resolveCompletedTask so dependents cascade', async () => {
      setup(baseTask, { ...baseTask, status: 'failed' });
      await patch({ status: 'failed' });
      expect(mockResolveCompletedTask).toHaveBeenCalledWith(TASK_ID, 'ws-1');
    });

    it('manual fail on a planning task skips resolveCompletedTask (no auto mission retrigger)', async () => {
      const planning = { ...baseTask, mode: 'planning', missionId: 'm-1' };
      setup(planning, { ...planning, status: 'failed' });
      await patch({ status: 'failed' });
      expect(mockResolveCompletedTask).not.toHaveBeenCalled();
    });

    // Honest cancel: cancelling stops a live agent mid-run and loses its
    // unpushed work, so the caller has to say so (abort: true).
    it('cancel with a live worker and no abort flag is refused, says why, and writes nothing', async () => {
      setup(baseTask, { ...baseTask, status: 'cancelled' });
      mockWorkersFindFirst.mockResolvedValue({ id: 'w-1', status: 'running' });
      const res = await patch({ status: 'cancelled' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('live_worker');
      expect(body.workerId).toBe('w-1');
      expect(body.error).toMatch(/abort: true/);
      expect(mockTasksUpdate).not.toHaveBeenCalled();
      expect(mockReleaseAndNotify).not.toHaveBeenCalled();
    });

    it('cancel with a live worker and abort: true goes through', async () => {
      setup(baseTask, { ...baseTask, status: 'cancelled' });
      mockWorkersFindFirst.mockResolvedValue({ id: 'w-1', status: 'waiting_input' });
      const res = await patch({ status: 'cancelled', abort: true });
      expect(res.status).toBe(200);
      expect(mockTasksUpdate).toHaveBeenCalled();
      expect(mockResolveCompletedTask).toHaveBeenCalledWith(TASK_ID, 'ws-1');
    });

    it('abort must be a boolean', async () => {
      setup(baseTask, { ...baseTask, status: 'cancelled' });
      expect((await patch({ status: 'cancelled', abort: 'yes' })).status).toBe(400);
    });

    it('cancel with no missionId still runs resolveCompletedTask', async () => {
      setup(baseTask, { ...baseTask, status: 'cancelled' });
      await patch({ status: 'cancelled' });
      expect(mockResolveCompletedTask).toHaveBeenCalledWith(TASK_ID, 'ws-1');
    });

    it.each(['completed', 'failed', 'cancelled', 'pending'])(
      'status change to %s emits TASK_UPDATED on the workspace channel',
      async (status) => {
        setup(baseTask, { ...baseTask, status });
        await patch({ status });
        expect(mockTriggerEvent).toHaveBeenCalledWith('workspace-ws-1', 'task:updated', {
          task: { id: TASK_ID, status, workspaceId: 'ws-1', missionId: null },
        });
      },
    );

    it('reset to pending with no dependencies dispatches to runners', async () => {
      setup(baseTask, { ...baseTask, status: 'pending' });
      await patch({ status: 'pending' });
      // A manual reset is labelled as such, not as an unblock.
      expect(mockWakeTask).toHaveBeenCalledTimes(1);
      expect(mockWakeTask).toHaveBeenCalledWith(TASK_ID, 'manual.start');
    });

    it('reset to pending with satisfied dependencies dispatches', async () => {
      const t = { ...baseTask, dependsOn: ['dep-1'] };
      setup(t, { ...t, status: 'pending' });
      mockTasksFindMany.mockResolvedValue([{ id: 'dep-1', status: 'completed', loopState: null }]);
      await patch({ status: 'pending' });
      expect(mockWakeTask).toHaveBeenCalledWith(TASK_ID, 'manual.start');
    });

    it('reset to pending with an unfinished dependency does not dispatch', async () => {
      const t = { ...baseTask, dependsOn: ['dep-1'] };
      setup(t, { ...t, status: 'pending' });
      mockTasksFindMany.mockResolvedValue([{ id: 'dep-1', status: 'in_progress', loopState: null }]);
      await patch({ status: 'pending' });
      expect(mockWakeTask).not.toHaveBeenCalled();
    });

    it('title-only PATCH emits nothing and resolves nothing', async () => {
      setup(baseTask, { ...baseTask, title: 'New' });
      await patch({ title: 'New' });
      expect(mockTriggerEvent).not.toHaveBeenCalled();
      expect(mockResolveCompletedTask).not.toHaveBeenCalled();
      expect(mockWakeTask).not.toHaveBeenCalled();
      expect(mockReleaseAndNotify).not.toHaveBeenCalled();
    });
  });

  // A budget/rate-limit pause parks the task behind a start_at floor for the
  // WALLED provider's reset. Switching provider must lift that floor, or the
  // switch silently does nothing until the old provider's reset comes round.
  describe('manual backend switch clears the paused provider\'s deferral', () => {
    const pausedCodexTask = () => ({
      id: TASK_ID,
      title: 'Daily finance digest',
      workspaceId: 'ws-1',
      status: 'pending',
      backend: 'codex',
      startAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
      context: { budgetExhausted: true, budgetResetsAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() },
      workspace: { id: 'ws-1', teamId: 'team-1' },
    });

    function captureUpdate() {
      const sets: any[] = [];
      mockTasksUpdate.mockReturnValue({
        set: mock((vals: any) => {
          sets.push(vals);
          return { where: mock(() => ({ returning: mock(() => [{ id: TASK_ID, workspaceId: 'ws-1' }]) })) };
        }),
      });
      return sets;
    }

    it('lifts the start_at floor and the paused flag when the backend changes', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
      mockAccountsFindFirst.mockResolvedValue(null);
      mockTasksFindFirst.mockResolvedValue(pausedCodexTask());
      const sets = captureUpdate();

      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { backend: 'claude' } }), TASK_ID);
      expect(res.status).toBe(200);

      expect(sets[0]?.backend).toBe('claude');
      expect(sets[0]?.startAt).toBeNull();
      expect(sets[0]?.context?.budgetExhausted).toBeUndefined();
      expect(sets[0]?.context?.budgetResetsAt).toBeUndefined();
      // Provenance kept so the banner/history can explain the manual override.
      expect(sets[0]?.context?.switchedBackendFrom).toBe('codex');
    });

    it('leaves the deferral alone when the backend is unchanged', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
      mockAccountsFindFirst.mockResolvedValue(null);
      mockTasksFindFirst.mockResolvedValue(pausedCodexTask());
      const sets = captureUpdate();

      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { backend: 'codex', title: 'x' } }), TASK_ID);
      expect(res.status).toBe(200);
      expect(sets[0]?.startAt).toBeUndefined();
      expect(sets[0]?.context).toBeUndefined();
    });

    // An operator's switch is an explicit choice: budget failover must not undo it.
    it('pins the backend an operator switches to, and unpins on clear', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
      mockAccountsFindFirst.mockResolvedValue(null);
      mockTasksFindFirst.mockResolvedValue({ ...pausedCodexTask(), context: { note: 'kept' } });
      let sets = captureUpdate();
      let res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { backend: 'claude' } }), TASK_ID);
      expect(res.status).toBe(200);
      expect(sets[0]?.context?.backendPinned).toBe(true);
      expect(sets[0]?.context?.note).toBe('kept');

      mockTasksFindFirst.mockResolvedValue({ ...pausedCodexTask(), context: { backendPinned: true, note: 'kept' } });
      sets = captureUpdate();
      res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { backend: null } }), TASK_ID);
      expect(res.status).toBe(200);
      expect(sets[0]?.backend).toBeNull();
      expect('backendPinned' in (sets[0]?.context ?? {})).toBe(false);
      expect(sets[0]?.context?.note).toBe('kept');
    });

    it('does not touch start_at for a task that is not budget-paused', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
      mockAccountsFindFirst.mockResolvedValue(null);
      mockTasksFindFirst.mockResolvedValue({
        ...pausedCodexTask(),
        context: {},                                       // scheduled, not paused
      });
      const sets = captureUpdate();

      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { backend: 'claude' } }), TASK_ID);
      expect(res.status).toBe(200);
      expect(sets[0]?.backend).toBe('claude');
      expect(sets[0]?.startAt).toBeUndefined();
    });
  });

  // tier/model are USER PINS for the next claim/retry. The claim route reads a
  // pin only via readModelPin (context.modelPinned), so the PATCH must set the
  // marker, and clearing must leave routing free to decide again.
  describe('tier / model pin', () => {
    const baseTask = (context: Record<string, unknown> = {}) => ({
      id: TASK_ID,
      title: 'Pin me',
      workspaceId: 'ws-1',
      status: 'pending',
      backend: 'claude',
      tier: null,
      context,
      workspace: { id: 'ws-1', teamId: 'team-1' },
    });

    function captureUpdate() {
      const sets: any[] = [];
      mockTasksUpdate.mockReturnValue({
        set: mock((vals: any) => {
          sets.push(vals);
          return { where: mock(() => ({ returning: mock(() => [{ id: TASK_ID, workspaceId: 'ws-1' }]) })) };
        }),
      });
      return sets;
    }

    async function patch(task: any, body: Record<string, unknown>) {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
      mockAccountsFindFirst.mockResolvedValue(null);
      mockTasksFindFirst.mockResolvedValue(task);
      const sets = captureUpdate();
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body }), TASK_ID);
      return { res, sets };
    }

    it('model sets context.model as a pin and keeps the rest of the context', async () => {
      const { res, sets } = await patch(
        baseTask({ model: 'haiku', routingReason: 'baseline', modelPinned: false, other: 1 }),
        { model: 'claude-opus-4-8' },
      );
      expect(res.status).toBe(200);
      expect(sets[0].context.model).toBe('claude-opus-4-8');
      expect(sets[0].context.modelPinned).toBe(true);
      expect(sets[0].context.other).toBe(1);
    });

    describe('model-tier ceiling', () => {
      afterEach(() => { ceilingTest.inputs = {}; });

      it('re-tiering above the team ceiling is refused with policy_denied and nothing is written', async () => {
        ceilingTest.inputs = { team: { team: { agent: 'premium' } } };
        const { res, sets } = await patch(baseTask(), { tier: 'premium-plus' });
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: 'policy_denied', maxTier: 'premium', requested: { tier: 'premium-plus', origin: 'task_tier' } });
        expect(sets).toHaveLength(0);
      });

      it('an exact premium-plus model pin is refused; an in-band one and a lower tier are allowed', async () => {
        ceilingTest.inputs = { team: { workspaces: { 'ws-1': { all: 'premium' } } } };
        const denied = await patch(baseTask(), { model: 'claude-fable-5-1' });
        expect(denied.res.status).toBe(403);
        expect((await denied.res.json()).code).toBe('model_above_ceiling');
        expect((await patch(baseTask(), { model: 'claude-opus-4-8' })).res.status).toBe(200);
        expect((await patch(baseTask(), { tier: 'budget' })).res.status).toBe(200);
      });

      it('clearing a tier or pin is never refused', async () => {
        ceilingTest.inputs = { team: { team: { all: 'budget' } } };
        expect((await patch(baseTask({ model: 'claude-opus-4-8', modelPinned: true }), { model: null, tier: null })).res.status).toBe(200);
      });
    });

    it('model: null clears the pin so routing decides at the next claim', async () => {
      const { res, sets } = await patch(
        baseTask({ model: 'claude-opus-4-8', modelPinned: true, other: 1 }),
        { model: null },
      );
      expect(res.status).toBe(200);
      expect(sets[0].context.model).toBeUndefined();
      expect(sets[0].context.modelPinned).toBe(false);
      expect(sets[0].context.other).toBe(1);
    });

    it('rejects a model id that is not Anthropic-shaped', async () => {
      const { res, sets } = await patch(baseTask(), { model: 'not a model' });
      expect(res.status).toBe(400);
      expect(sets.length).toBe(0);
    });

    it('tier sets tasks.tier and drops an existing model pin (latest instruction wins)', async () => {
      const { res, sets } = await patch(
        baseTask({ model: 'claude-opus-4-8', modelPinned: true }),
        { tier: 'premium' },
      );
      expect(res.status).toBe(200);
      expect(sets[0].tier).toBe('premium');
      expect(sets[0].context.model).toBeUndefined();
      expect(sets[0].context.modelPinned).toBe(false);
    });

    it('tier alone on a task without a pin leaves context untouched', async () => {
      const { res, sets } = await patch(baseTask({ model: 'haiku', routingReason: 'baseline' }), { tier: 'budget' });
      expect(res.status).toBe(200);
      expect(sets[0].tier).toBe('budget');
      expect(sets[0].context).toBeUndefined();
    });

    it('tier: null clears the tier override', async () => {
      const { res, sets } = await patch({ ...baseTask(), tier: 'premium' }, { tier: null });
      expect(res.status).toBe(200);
      expect(sets[0].tier).toBeNull();
    });

    it('rejects an out-of-vocabulary tier', async () => {
      const { res, sets } = await patch(baseTask(), { tier: 'opus' });
      expect(res.status).toBe(400);
      expect(sets.length).toBe(0);
    });

    it('tier + model in one call keeps the model pin', async () => {
      const { res, sets } = await patch(baseTask(), { tier: 'premium', model: 'claude-opus-4-8' });
      expect(res.status).toBe(200);
      expect(sets[0].tier).toBe('premium');
      expect(sets[0].context.model).toBe('claude-opus-4-8');
      expect(sets[0].context.modelPinned).toBe(true);
    });

    it('composes with a backend switch that also rewrites context', async () => {
      const { res, sets } = await patch(
        { ...baseTask({ budgetExhausted: true, budgetResetsAt: 'x' }), backend: 'codex', startAt: new Date() },
        { backend: 'claude', model: 'claude-opus-4-8' },
      );
      expect(res.status).toBe(200);
      expect(sets[0].context.budgetExhausted).toBeUndefined();
      expect(sets[0].context.switchedBackendFrom).toBe('codex');
      expect(sets[0].context.model).toBe('claude-opus-4-8');
      expect(sets[0].context.modelPinned).toBe(true);
    });
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'PATCH',
      body: { title: 'Updated Title' },
    });
    const response = await callHandler(PATCH, request, TASK_ID);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 400 with helpful message for an 8-character ID prefix', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });

    const request = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { status: 'cancelled' },
    });
    const response = await callHandler(PATCH, request, 'b833be4b');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toMatch(/UUID/);
    expect(data.error).toMatch(/prefix/);
  });

  it('returns 404 when task not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'PATCH',
      body: { title: 'Updated Title' },
    });
    const response = await callHandler(PATCH, request, TASK_ID);

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('explains with 403 when a task token edits a sibling task in its workspace', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockTasksFindFirst.mockResolvedValue({ id: TASK_ID, workspaceId: 'ws-1', workspace: { id: 'ws-1', teamId: 'team-1' } });
    const scope = (workspaceId: string) => ({
      id: 'account-123', level: 'worker', taskScope: { taskId: 'some-other-task', workspaceId, expiresAt: Date.now() + 60_000 },
    });
    const req = () => createMockRequest({ method: 'PATCH', headers: { Authorization: 'Bearer bld_xxx' }, body: { status: 'cancelled' } });

    mockAccountsFindFirst.mockResolvedValue(scope('ws-1'));
    const sibling = await callHandler(PATCH, req(), TASK_ID);
    expect(sibling.status).toBe(403);
    expect((await sibling.json()).error).toMatch(/only edit its own task/);

    mockAccountsFindFirst.mockResolvedValue(scope('ws-other'));
    const foreign = await callHandler(PATCH, req(), TASK_ID);
    expect(foreign.status).toBe(404);
  });

  it('returns 404 when session user does not own workspace', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'PATCH',
      body: { title: 'Updated Title' },
    });
    const response = await callHandler(PATCH, request, TASK_ID);

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('updates title only', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Original Title',
      description: 'Original description',
      priority: 5,
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = { ...mockTask, title: 'Updated Title', updatedAt: expect.any(Date) };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { title: 'Updated Title' },
    });
    const response = await callHandler(PATCH, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.title).toBe('Updated Title');
  });

  it('links the task to an external issue (externalIssueId + url)', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    let capturedSet: any = null;
    const mockReturning = mock(() => [{ ...mockTask, externalIssueId: 'ISSUE-42' }]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock((v: any) => { capturedSet = v; return { where: mockWhere }; });
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { externalIssueId: 'ISSUE-42', externalIssueUrl: 'https://tracker.example.com/ISSUE-42' },
    });
    const response = await callHandler(PATCH, request, TASK_ID);

    expect(response.status).toBe(200);
    expect(capturedSet.externalIssueId).toBe('ISSUE-42');
    expect(capturedSet.externalIssueUrl).toBe('https://tracker.example.com/ISSUE-42');
  });

  it('unlinks the task when externalIssueId is empty', async () => {
    const mockTask = {
      id: TASK_ID, title: 'Test Task', workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    let capturedSet: any = null;
    const mockWhere = mock(() => ({ returning: mock(() => [mockTask]) }));
    const mockSet = mock((v: any) => { capturedSet = v; return { where: mockWhere }; });
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({ method: 'PATCH', body: { externalIssueId: '' } });
    const response = await callHandler(PATCH, request, TASK_ID);

    expect(response.status).toBe(200);
    expect(capturedSet.externalIssueId).toBeNull();
  });

  it('updates description only', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      description: 'Original description',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = { ...mockTask, description: 'New description' };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { description: 'New description' },
    });
    const response = await callHandler(PATCH, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.description).toBe('New description');
  });

  it('updates priority only', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      priority: 5,
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = { ...mockTask, priority: 10 };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { priority: 10 },
    });
    const response = await callHandler(PATCH, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.priority).toBe(10);
  });

  it('updates multiple fields at once', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Original Title',
      description: 'Original description',
      priority: 5,
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = {
      ...mockTask,
      title: 'New Title',
      description: 'New description',
      priority: 10,
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { title: 'New Title', description: 'New description', priority: 10 },
    });
    const response = await callHandler(PATCH, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.title).toBe('New Title');
    expect(data.description).toBe('New description');
    expect(data.priority).toBe(10);
  });

  it('ignores undefined fields in update', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Original Title',
      description: 'Original description',
      priority: 5,
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    let capturedSetData: any = null;
    const mockReturning = mock(() => [mockTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock((data: any) => {
      capturedSetData = data;
      return { where: mockWhere };
    });
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { title: 'New Title' }, // Only title, not description or priority
    });
    await callHandler(PATCH, request, TASK_ID);

    // The set data should only contain title and updatedAt, not description/priority
    expect(capturedSetData.title).toBe('New Title');
    expect(capturedSetData.updatedAt).toBeInstanceOf(Date);
    expect(capturedSetData.description).toBeUndefined();
    expect(capturedSetData.priority).toBeUndefined();
  });

  it('updates task project field', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      project: null,
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = { ...mockTask, project: '@mono/web' };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { project: '@mono/web' },
    });
    const response = await callHandler(PATCH, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.project).toBe('@mono/web');
  });

  it('can clear project to null', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      project: '@mono/web',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = { ...mockTask, project: null };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    let capturedSetData: any = null;
    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock((data: any) => {
      capturedSetData = data;
      return { where: mockWhere };
    });
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { project: null },
    });
    const response = await callHandler(PATCH, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.project).toBeNull();
    expect(capturedSetData.project).toBeNull();
  });

  it('omitting project does not change existing value', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Original Title',
      project: '@mono/web',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    let capturedSetData: any = null;
    const mockReturning = mock(() => [mockTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock((data: any) => {
      capturedSetData = data;
      return { where: mockWhere };
    });
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { title: 'New Title' },
    });
    await callHandler(PATCH, request, TASK_ID);

    expect(capturedSetData.title).toBe('New Title');
    expect(capturedSetData.project).toBeUndefined();
  });

  it('clears claimedBy, claimedAt, and expiresAt when resetting status to pending', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      status: 'assigned',
      claimedBy: 'account-1',
      claimedAt: new Date(),
      expiresAt: new Date(),
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    let capturedSetData: any = null;
    const updatedTask = { ...mockTask, status: 'pending', claimedBy: null, claimedAt: null, expiresAt: null };
    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock((data: any) => {
      capturedSetData = data;
      return { where: mockWhere };
    });
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { status: 'pending' },
    });
    const response = await callHandler(PATCH, request, TASK_ID);

    expect(response.status).toBe(200);
    // Regression test: claim fields must be cleared so the task is claimable again
    expect(capturedSetData.status).toBe('pending');
    expect(capturedSetData.claimedBy).toBeNull();
    expect(capturedSetData.claimedAt).toBeNull();
    expect(capturedSetData.expiresAt).toBeNull();
  });

  it('allows setting status to cancelled with no active worker', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = { ...mockTask, status: 'cancelled' };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockWorkersFindFirst.mockResolvedValue(null); // no active worker

    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { status: 'cancelled' },
    });
    const response = await callHandler(PATCH, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe('cancelled');
    // No active worker → no Pusher abort event
    const commands = mockTriggerEvent.mock.calls.filter((c: any[]) => c[1] === 'worker:command');
    expect(commands).toHaveLength(0);
  });

  it('releases the cancelled task\'s own path claims even with no active/cooperating worker', async () => {
    // Regression test: a direct cancel used to rely entirely on the best-effort
    // abort Pusher push reaching a worker that then PATCHes itself terminal
    // (which is what actually released path_claims). If the worker was already
    // dead, never assigned, or simply didn't process the abort, the cancelled
    // task's path_claims rows stayed held forever and deadlocked any sibling
    // task whose manifest overlapped them (see friction task 4233fd36).
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = { ...mockTask, status: 'cancelled' };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockWorkersFindFirst.mockResolvedValue(null); // no active/cooperating worker

    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { status: 'cancelled' },
    });
    const response = await callHandler(PATCH, request, TASK_ID);

    expect(response.status).toBe(200);
    expect(mockReleaseAndNotify).toHaveBeenCalledWith(TASK_ID, 'abandoned');
  });

  it('pushes abort command to active worker on cancel (abort: true)', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = { ...mockTask, status: 'cancelled' };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockWorkersFindFirst.mockResolvedValue({ id: 'worker-456' }); // active worker found

    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { status: 'cancelled', abort: true },
    });
    const response = await callHandler(PATCH, request, TASK_ID);

    expect(response.status).toBe(200);
    // Verify abort was pushed to the worker's Pusher channel
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'worker-worker-456',
      'worker:command',
      expect.objectContaining({ action: 'abort', reason: 'task_cancelled' })
    );
  });

  it('releases the cancelled task\'s own path claims even with no active/cooperating worker', async () => {
    // Regression test: a direct cancel used to rely entirely on the best-effort
    // abort Pusher push reaching a worker that then PATCHes itself terminal
    // (which is what actually released path_claims). If the worker was already
    // dead, never assigned, or simply didn't process the abort, the cancelled
    // task's path_claims rows stayed held forever and deadlocked any sibling
    // task whose manifest overlapped them (see friction task 4233fd36).
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = { ...mockTask, status: 'cancelled' };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockWorkersFindFirst.mockResolvedValue(null); // no active/cooperating worker

    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      body: { status: 'cancelled' },
    });
    const response = await callHandler(PATCH, request, TASK_ID);

    expect(response.status).toBe(200);
    expect(mockReleaseAndNotify).toHaveBeenCalledWith(TASK_ID, 'abandoned');
  });

  it('rejects unknown status values', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest({
      method: 'PATCH',
      body: { status: 'invalid_status' },
    });
    const response = await callHandler(PATCH, request, TASK_ID);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Invalid status');
  });

  it('allows API key auth to update task', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    const updatedTask = { ...mockTask, title: 'Updated Title' };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockReturning = mock(() => [updatedTask]);
    const mockWhere = mock(() => ({ returning: mockReturning }));
    const mockSet = mock(() => ({ where: mockWhere }));
    mockTasksUpdate.mockReturnValue({ set: mockSet });

    const request = createMockRequest({
      method: 'PATCH',
      headers: { Authorization: 'Bearer bld_xxx' },
      body: { title: 'Updated Title' },
    });
    const response = await callHandler(PATCH, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.title).toBe('Updated Title');
  });

  it('adjusts maxLoops while preserving the existing exit condition', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Loop task',
      status: 'in_progress',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
      loopConfig: {
        exitCondition: { type: 'command', command: 'bun test' },
        maxLoops: 5,
        backoffMinutes: 1,
      },
      loopIteration: 2,
    };
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);
    let updateData: any;
    mockTasksUpdate.mockReturnValue({
      set: mock((values: any) => {
        updateData = values;
        return { where: mock(() => ({ returning: mock(() => [{ ...mockTask, ...values }]) })) };
      }),
    });

    const response = await callHandler(PATCH, createMockRequest({
      method: 'PATCH',
      body: { maxLoops: 8 },
    }), TASK_ID);

    expect(response.status).toBe(200);
    expect(updateData.loopConfig).toEqual({
      exitCondition: { type: 'command', command: 'bun test' },
      maxLoops: 8,
      backoffMinutes: 1,
    });
  });

  it('rejects maxLoops updates on non-looping tasks', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: TASK_ID,
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1' },
      loopConfig: null,
      loopIteration: 0,
    });

    const response = await callHandler(PATCH, createMockRequest({
      method: 'PATCH',
      body: { maxLoops: 8 },
    }), TASK_ID);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('existing looped task');
  });

  describe('hold / resume (held)', () => {
    const openTask = (context: Record<string, unknown> = { model: 'x' }) => ({
      id: TASK_ID, title: 'checkout', status: 'assigned', workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' }, context,
    });
    function capture() {
      const sets: any[] = [];
      mockTasksUpdate.mockReturnValue({
        set: mock((v: any) => { sets.push(v); return { where: mock(() => ({ returning: mock(() => [{ id: TASK_ID, workspaceId: 'ws-1', ...v }]) })) }; }),
      });
      return sets;
    }
    beforeEach(() => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
      mockAccountsFindFirst.mockResolvedValue(null);
    });

    it('held: true stamps context.heldBy (who, when, why) and keeps the rest of the context', async () => {
      mockTasksFindFirst.mockResolvedValue(openTask());
      const sets = capture();
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { held: true, heldReason: 'until the rounding decision' } }), TASK_ID);
      expect(res.status).toBe(200);
      expect(sets[0].context.model).toBe('x');
      expect(sets[0].context.heldBy).toMatchObject({ userId: 'user-123', reason: 'until the rounding decision' });
      expect(typeof sets[0].context.heldBy.at).toBe('string');
    });

    it('held: false removes the hold', async () => {
      mockTasksFindFirst.mockResolvedValue(openTask({ model: 'x', heldBy: { at: 'then', userId: 'u' } }));
      const sets = capture();
      const res = await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { held: false } }), TASK_ID);
      expect(res.status).toBe(200);
      expect(sets[0].context).toEqual({ model: 'x' });
    });

    it('refuses a non-boolean, and holding a finished task', async () => {
      mockTasksFindFirst.mockResolvedValue(openTask());
      capture();
      expect((await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { held: 'yes' } }), TASK_ID)).status).toBe(400);
      mockTasksFindFirst.mockResolvedValue({ ...openTask(), status: 'completed' });
      expect((await callHandler(PATCH, createMockRequest({ method: 'PATCH', body: { held: true } }), TASK_ID)).status).toBe(400);
    });
  });

  // Reschedule: move a queued task's start later (or back to ASAP) without
  // cancelling it. Only before a worker has it; a started task is refused.
  describe('reschedule (startAt / startIn)', () => {
    const queued = (over: Record<string, unknown> = {}) => ({
      id: TASK_ID, title: 'checkout', status: 'pending', claimedBy: null, workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' }, context: { model: 'x' }, ...over,
    });
    function capture() {
      const sets: any[] = [];
      mockTasksUpdate.mockReturnValue({
        set: mock((v: any) => { sets.push(v); return { where: mock(() => ({ returning: mock(() => [{ id: TASK_ID, workspaceId: 'ws-1', ...v }]) })) }; }),
      });
      return sets;
    }
    const patch = (body: Record<string, unknown>) =>
      callHandler(PATCH, createMockRequest({ method: 'PATCH', body }), TASK_ID);
    beforeEach(() => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
      mockAccountsFindFirst.mockResolvedValue(null);
    });

    it('startAt (ISO) defers a pending task and records who and how', async () => {
      mockTasksFindFirst.mockResolvedValue(queued());
      const sets = capture();
      const at = new Date(Date.now() + 3_600_000).toISOString();
      const res = await patch({ startAt: at });
      expect(res.status).toBe(200);
      expect(sets[0].startAt).toEqual(new Date(at));
      expect(sets[0].context).toMatchObject({ model: 'x', startResolution: 'explicit' });
      expect(sets[0].context.rescheduledBy).toMatchObject({ userId: 'user-123' });
    });

    it('startIn resolves relative to now', async () => {
      mockTasksFindFirst.mockResolvedValue(queued());
      const sets = capture();
      const before = Date.now();
      expect((await patch({ startIn: '4h' })).status).toBe(200);
      const t = (sets[0].startAt as Date).getTime();
      expect(t).toBeGreaterThanOrEqual(before + 4 * 3_600_000);
      expect(t).toBeLessThan(before + 4 * 3_600_000 + 60_000);
      expect(sets[0].context.startResolution).toBe('relative');
    });

    it('startAt: null means start as soon as possible', async () => {
      mockTasksFindFirst.mockResolvedValue(queued({ startAt: new Date(Date.now() + 3_600_000) }));
      const sets = capture();
      expect((await patch({ startAt: null })).status).toBe(200);
      expect(sets[0].startAt).toBeNull();
      expect(sets[0].context.startResolution).toBeUndefined();
    });

    it('refuses a past time, a bad duration, and both at once', async () => {
      mockTasksFindFirst.mockResolvedValue(queued());
      capture();
      expect((await patch({ startAt: new Date(Date.now() - 60_000).toISOString() })).status).toBe(400);
      expect((await patch({ startIn: 'soon' })).status).toBe(400);
      expect((await patch({ startAt: new Date(Date.now() + 60_000).toISOString(), startIn: '1h' })).status).toBe(400);
    });

    it.each([
      ['claimed', { status: 'pending', claimedBy: 'worker-1' }],
      ['assigned', { status: 'assigned' }],
      ['in_progress', { status: 'in_progress' }],
      ['completed', { status: 'completed' }],
    ])('refuses a task that is %s, saying why', async (_label, over) => {
      mockTasksFindFirst.mockResolvedValue(queued(over));
      const sets = capture();
      const res = await patch({ startIn: '1h' });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/start time/i);
      expect(sets).toHaveLength(0);
    });
  });

  describe('resultSummary correction', () => {
    it('corrects the stored summary on a completed task and stamps an audit trail', async () => {
      const mockTask = {
        id: TASK_ID,
        title: 'Task with a stray aside',
        status: 'completed',
        workspaceId: 'ws-1',
        workspace: { id: 'ws-1', teamId: 'team-1' },
        result: { summary: 'Sure, I can help with that!', prUrl: 'https://github.com/o/r/pull/1' },
      };
      mockGetCurrentUser.mockResolvedValue(null);
      mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx', level: 'admin' });
      mockTasksFindFirst.mockResolvedValue(mockTask);
      let updateData: any;
      mockTasksUpdate.mockReturnValue({
        set: mock((values: any) => {
          updateData = values;
          return { where: mock(() => ({ returning: mock(() => [{ ...mockTask, ...values }]) })) };
        }),
      });

      const response = await callHandler(PATCH, createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_xxx' },
        body: { resultSummary: 'Fixed the auth bug in login.ts', correctedBy: 'worker:abc' },
      }), TASK_ID);

      expect(response.status).toBe(200);
      expect(updateData.result.summary).toBe('Fixed the auth bug in login.ts');
      expect(updateData.result.previousSummary).toBe('Sure, I can help with that!');
      expect(updateData.result.correctedBy).toBe('worker:abc');
      expect(typeof updateData.result.summaryCorrectedAt).toBe('string');
      // Untouched result fields survive the correction.
      expect(updateData.result.prUrl).toBe('https://github.com/o/r/pull/1');
    });

    it('rejects a non-admin API key even with workspace access', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      // Ordinary workspace API key — accounts.level defaults to 'worker' in prod.
      mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx', level: 'worker' });
      mockTasksFindFirst.mockResolvedValue({
        id: TASK_ID,
        status: 'completed',
        workspaceId: 'ws-1',
        workspace: { id: 'ws-1', teamId: 'team-1' },
        result: { summary: 'old' },
      });

      const response = await callHandler(PATCH, createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_xxx' },
        body: { resultSummary: 'Fixed it' },
      }), TASK_ID);

      expect(response.status).toBe(403);
      expect((await response.json()).error).toContain('admin-level');
    });

    it.each([['tasks:write', 403], ['tasks:admin', 200]] as const)('result correction with %s scope returns %s', async (scope, status) => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAccountsFindFirst.mockResolvedValue({id:'account-123',level:'worker',scopes:[scope]});
      const task = {id:TASK_ID,status:'completed',workspaceId:'ws-1',workspace:{id:'ws-1',teamId:'team-1'},result:{summary:'old'}};
      mockTasksFindFirst.mockResolvedValue(task);
      mockTasksUpdate.mockReturnValue({set:mock((values:any) => ({where:mock(() => ({returning:mock(() => [{...task,...values}])}))}))});
      const response = await callHandler(PATCH, createMockRequest({method:'PATCH',headers:{Authorization:'Bearer bld_scoped'},body:{resultSummary:'Corrected result'}}), TASK_ID);
      expect(response.status).toBe(status);
    });

    it('rejects correcting the summary on a task that has not completed or failed', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx', level: 'admin' });
      mockTasksFindFirst.mockResolvedValue({
        id: TASK_ID,
        status: 'pending',
        workspaceId: 'ws-1',
        workspace: { id: 'ws-1', teamId: 'team-1' },
        result: null,
      });

      const response = await callHandler(PATCH, createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_xxx' },
        body: { resultSummary: 'Fixed it' },
      }), TASK_ID);

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('pending');
    });

    it('rejects an empty resultSummary', async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx', level: 'admin' });
      mockTasksFindFirst.mockResolvedValue({
        id: TASK_ID,
        status: 'completed',
        workspaceId: 'ws-1',
        workspace: { id: 'ws-1', teamId: 'team-1' },
        result: { summary: 'old' },
      });

      const response = await callHandler(PATCH, createMockRequest({
        method: 'PATCH',
        headers: { Authorization: 'Bearer bld_xxx' },
        body: { resultSummary: '   ' },
      }), TASK_ID);

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('non-empty string');
    });
  });
});

describe('DELETE /api/tasks/[id]', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksDelete.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();

    // Default: grant access
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue(null);

    const request = createMockRequest({ method: 'DELETE' });
    const response = await callHandler(DELETE, request, TASK_ID);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when task not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(null);

    const request = createMockRequest({ method: 'DELETE' });
    const response = await callHandler(DELETE, request, TASK_ID);

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('returns 404 when session user does not own workspace', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockAccountsFindFirst.mockResolvedValue(null);
    mockTasksFindFirst.mockResolvedValue(mockTask);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const request = createMockRequest({ method: 'DELETE' });
    const response = await callHandler(DELETE, request, TASK_ID);

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('deletes pending task successfully', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockWhere = mock(() => Promise.resolve());
    mockTasksDelete.mockReturnValue({ where: mockWhere });

    const request = createMockRequest({ method: 'DELETE' });
    const response = await callHandler(DELETE, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it('deletes assigned task successfully', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      status: 'assigned',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockWhere = mock(() => Promise.resolve());
    mockTasksDelete.mockReturnValue({ where: mockWhere });

    const request = createMockRequest({ method: 'DELETE' });
    const response = await callHandler(DELETE, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it('deletes failed task successfully', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      status: 'failed',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockWhere = mock(() => Promise.resolve());
    mockTasksDelete.mockReturnValue({ where: mockWhere });

    const request = createMockRequest({ method: 'DELETE' });
    const response = await callHandler(DELETE, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it('returns 400 with helpful message for an 8-character ID prefix, without querying the db', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });

    const request = createMockRequest({ method: 'DELETE' });
    const response = await callHandler(DELETE, request, 'b833be4b');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toMatch(/UUID/);
    expect(data.error).toMatch(/prefix/);
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
  });

  it('returns 400 when trying to delete running task', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      status: 'running',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const request = createMockRequest({ method: 'DELETE' });
    const response = await callHandler(DELETE, request, TASK_ID);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Cannot delete running tasks');
  });

  it('deletes completed task successfully', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      status: 'completed',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockWhere = mock(() => Promise.resolve());
    mockTasksDelete.mockReturnValue({ where: mockWhere });

    const request = createMockRequest({ method: 'DELETE' });
    const response = await callHandler(DELETE, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it('allows API key auth to delete task', async () => {
    const mockTask = {
      id: TASK_ID,
      title: 'Test Task',
      status: 'pending',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1', teamId: 'team-1' },
    };

    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockResolvedValue({ id: 'account-123', apiKey: 'bld_xxx' });
    mockTasksFindFirst.mockResolvedValue(mockTask);

    const mockWhere = mock(() => Promise.resolve());
    mockTasksDelete.mockReturnValue({ where: mockWhere });

    const request = createMockRequest({
      method: 'DELETE',
      headers: { Authorization: 'Bearer bld_xxx' },
    });
    const response = await callHandler(DELETE, request, TASK_ID);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });
});

// A per-task token may edit only its own task's descriptive fields; how the
// task runs or ends goes through complete_task and its gates.
describe('PATCH /api/tasks/[id] — per-task token', () => {
  const own = {
    id: TASK_ID, title: 'T', status: 'in_progress', mode: 'execution', missionId: null,
    dependsOn: [], workspaceId: 'ws-1', workspace: { id: 'ws-1', teamId: 'team-1', name: 'ws' },
  };
  const scoped = (taskId = TASK_ID) => ({
    id: 'acct-1', teamId: 'team-1', level: 'worker',
    taskScope: { taskId, workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 },
  });
  const patch = (body: Record<string, unknown>) =>
    callHandler(PATCH, createMockRequest({ method: 'PATCH', headers: { Authorization: 'Bearer bld_test' }, body }), TASK_ID);

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue(null);
    mockAccountsFindFirst.mockReset();
    mockAccountsFindFirst.mockResolvedValue(scoped());
    mockTasksFindFirst.mockReset();
    mockTasksFindFirst.mockResolvedValue(own);
    mockWorkersFindFirst.mockReset();
    mockWorkersFindFirst.mockResolvedValue(null);
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockTasksUpdate.mockReset();
    mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => ({ returning: mock(() => [own]) })) })) });
  });

  it('edits its own task’s description', async () => {
    const res = await patch({ description: 'clarified scope' });
    expect(res.status).toBe(200);
    expect(mockTasksUpdate).toHaveBeenCalled();
  });

  it.each([
    ['status', { status: 'completed' }],
    ['missionId', { missionId: '22222222-2222-2222-2222-222222222222' }],
    ['held', { held: false }],
    ['tier', { tier: 'premium' }],
    ['startIn', { startIn: '1h' }],
  ])('refuses %s, naming it, and writes nothing', async (field, body) => {
    const res = await patch(body);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain(field);
    expect(mockTasksUpdate).not.toHaveBeenCalled();
  });

  it('cannot edit another task', async () => {
    mockAccountsFindFirst.mockResolvedValue(scoped('33333333-3333-3333-3333-333333333333'));
    const res = await patch({ description: 'x' });
    expect(res.status).toBe(403);
    expect(mockTasksUpdate).not.toHaveBeenCalled();
  });

  it('leaves an account key’s fields unrestricted', async () => {
    mockAccountsFindFirst.mockResolvedValue({ id: 'acct-1', teamId: 'team-1', level: 'worker' });
    const res = await patch({ priority: 3, held: false });
    expect(res.status).not.toBe(403);
  });
});
