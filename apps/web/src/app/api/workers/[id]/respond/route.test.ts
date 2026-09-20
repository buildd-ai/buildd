import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));

const mockInsertReturning = mock(() => [{ id: 'new-task-1', title: 'Continue: Fix auth bug' }]);
const mockInsertValues = mock(() => {
  callOrder.push('insert');
  return { returning: mockInsertReturning };
});
const mockInsert = mock(() => ({
  values: mockInsertValues,
}));

const mockWorkersUpdateReturning = mock(() => [{ id: 'worker-1', status: 'superseded' }]);
const mockWorkersUpdateWhere = mock(() => ({
  returning: mockWorkersUpdateReturning,
}));
const mockWorkersUpdateSet = mock(() => {
  callOrder.push('update');
  return { where: mockWorkersUpdateWhere };
});
const mockWorkersUpdate = mock(() => ({
  set: mockWorkersUpdateSet,
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));

// Order of writes matters (C3): the answer must be claimed with a CAS BEFORE
// the retry task is inserted, so a losing racer inserts nothing.
const callOrder: string[] = [];

// `tasks.context.answerDelivery` write — a plain promise so the route's
// `.catch()` on it resolves.
const mockTasksUpdateSet = mock((values: any) => {
  tasksUpdated.push(values);
  return { where: () => Promise.resolve([]) };
});
const tasksUpdated: any[] = [];

// Feed notes naming which answer path ran.
const notesInserted: any[] = [];
const mockNotesInsertValues = mock((values: any) => {
  notesInserted.push(values);
  return Promise.resolve([]);
});

const mockTriggerEvent = mock(() => Promise.resolve(true));

const mockPreflight = mock(async () => ({ state: 'ok' as const }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
    },
    insert: (table: any) =>
      table === 'missionNotes' ? { values: mockNotesInsertValues } : mockInsert(),
    update: (table: any) =>
      table === 'tasks' ? { set: mockTasksUpdateSet } : mockWorkersUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
  isNotNull: (field: any) => ({ field, type: 'isNotNull' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: { id: 'workers.id', status: 'workers.status', waitingFor: 'workers.waitingFor' },
  tasks: 'tasks',
  missionNotes: 'missionNotes',
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { worker: (id: string) => `worker-${id}` },
  events: { WORKER_COMMAND: 'worker:command' },
}));

mock.module('@/lib/answer-credential-preflight', () => ({
  preflightBackendCredential: mockPreflight,
  CREDENTIAL_PREFLIGHT_MARGIN_MS: 300000,
}));

import { POST } from './route';

function createMockRequest(body?: any): NextRequest {
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
  };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return new NextRequest('http://localhost:3000/api/workers/worker-1/respond', init);
}

function createMockRequestWithAuth(body?: any, apiKey?: string): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  const init: RequestInit = {
    method: 'POST',
    headers: new Headers(headers),
  };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest('http://localhost:3000/api/workers/worker-1/respond', init);
}

const mockParams = Promise.resolve({ id: 'worker-1' });

const baseWorker = {
  id: 'worker-1',
  taskId: 'task-1',
  workspaceId: 'workspace-1',
  accountId: 'account-1',
  status: 'failed',
  branch: 'buildd/task-1-fix-auth',
  waitingFor: {
    type: 'question',
    prompt: 'Which authentication method should we use?',
    options: ['JWT', 'Session cookies'],
  },
  milestones: [
    { label: 'Set up project structure', timestamp: 1700000000 },
    { label: 'Added auth middleware', timestamp: 1700001000 },
  ],
  workspace: { teamId: 'team-1' },
  task: {
    id: 'task-1',
    title: 'Fix auth bug',
    description: 'Fix the authentication bug in login flow',
    workspaceId: 'workspace-1',
    missionId: 'mission-1',
    roleSlug: 'frontend-dev',
    mode: 'execution',
    taskClass: 'work',
    priority: 7,
    outputRequirement: 'pr_required',
    outputSchema: null,
    category: 'bug',
    pathManifest: ['apps/web/src/lib/auth.ts'],
    backend: 'claude',
    dependsOn: ['some-other-task-id'],
    subjectAnchor: { kind: 'ci_retry', prNumber: 42 },
    creationSource: 'orchestrator',
  },
};

describe('POST /api/workers/[id]/respond', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockWorkersFindFirst.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockInsert.mockClear();
    mockInsertValues.mockClear();
    mockInsertReturning.mockClear();
    mockWorkersUpdate.mockClear();
    mockWorkersUpdateSet.mockClear();
    mockWorkersUpdateWhere.mockClear();
    mockWorkersUpdateReturning.mockClear();

    // Reset mock implementations
    mockInsertReturning.mockReturnValue([{ id: 'new-task-1', title: 'Continue: Fix auth bug' }]);
    mockInsertValues.mockImplementation((() => {
      callOrder.push('insert');
      return { returning: mockInsertReturning };
    }) as any);
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockWorkersUpdateReturning.mockReturnValue([{ id: 'worker-1', status: 'superseded' }]);
    mockWorkersUpdateWhere.mockReturnValue({ returning: mockWorkersUpdateReturning });
    mockWorkersUpdateSet.mockImplementation((() => {
      callOrder.push('update');
      return { where: mockWorkersUpdateWhere };
    }) as any);
    mockWorkersUpdate.mockReturnValue({ set: mockWorkersUpdateSet });
    mockTasksUpdateSet.mockClear();
    mockNotesInsertValues.mockClear();
    mockTriggerEvent.mockClear();
    mockPreflight.mockClear();
    mockPreflight.mockImplementation(async () => ({ state: 'ok' as const }));
    tasksUpdated.length = 0;
    notesInserted.length = 0;
    callOrder.length = 0;
  });

  it('returns 401 when no auth provided', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toContain('Unauthorized');
  });

  it('returns 404 when worker not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockWorkersFindFirst.mockResolvedValue(null);

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns 404 when session user lacks workspace access', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(404);
  });

  it('returns 400 when worker has no waitingFor', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({
      ...baseWorker,
      waitingFor: null,
      status: 'running',
    });

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('not waiting for input');
  });

  it('returns 400 when worker is already completed', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({
      ...baseWorker,
      status: 'completed',
      waitingFor: null,
    });

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('not waiting for input');
  });

  // Regression: the /respond endpoint MUST be status-agnostic — it gates on
  // waitingFor presence, not worker.status. The runner's inputAsRetry mode
  // aborts the SDK session when AskUserQuestion fires, leaving the worker in
  // status='error' with waitingFor populated. The /tasks/[id]/respond landing
  // page and the in-page banner both rely on this contract.
  it.each([['error'], ['failed'], ['waiting_input']] as const)(
    'accepts the answer when worker status=%s and waitingFor is set',
    async ([status]) => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker, status });

      const res = await POST(createMockRequest({ message: 'JWT' }), { params: mockParams });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.taskId).toBe('new-task-1');
    },
  );

  it('returns 400 when message is missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

    const req = createMockRequest({});
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Message is required');
  });

  it('creates new task with correct context on happy path', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.taskId).toBe('new-task-1');

    // Verify task was inserted with correct values
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    const insertedValues = mockInsertValues.mock.calls[0][0];

    expect(insertedValues.title).toBe('Continue: Fix auth bug');
    expect(insertedValues.workspaceId).toBe('workspace-1');
    expect(insertedValues.parentTaskId).toBe('task-1');
    expect(insertedValues.missionId).toBe('mission-1');
    expect(insertedValues.status).toBe('pending');

    // Verify context
    expect(insertedValues.context.baseBranch).toBe('buildd/task-1-fix-auth');
    expect(insertedValues.context.userInput).toBe('Use JWT tokens');
    expect(insertedValues.context.previousAttempt.question).toBe('Which authentication method should we use?');
    expect(insertedValues.context.previousAttempt.milestones).toEqual(baseWorker.milestones);
    expect(insertedValues.context.previousAttempt.branch).toBe('buildd/task-1-fix-auth');
    expect(insertedValues.context.previousAttempt.workerId).toBe('worker-1');
  });

  it('sets baseBranch and parentTaskId correctly', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);

    const insertedValues = mockInsertValues.mock.calls[0][0];
    expect(insertedValues.context.baseBranch).toBe('buildd/task-1-fix-auth');
    expect(insertedValues.parentTaskId).toBe('task-1');
  });

  // Regression: an answered worker did not complete its task — it was replaced
  // by the continuation task. Recording 'completed' counted answered questions
  // as clean successes in get_failure_analytics / success-rate-by-role.
  // 'superseded' is excluded from both the success and failure buckets (see
  // IN_FLIGHT_WORKER_STATUSES in lib/failure-analytics.ts).
  it('marks original worker as superseded (not completed) after respond', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);

    // Verify worker was updated to superseded, not completed. A second call
    // follows (the continuation-task link-back — see 'continuation task
    // link-back' below), so this only asserts on the FIRST (claim) call.
    const setValues = mockWorkersUpdateSet.mock.calls[0][0];
    expect(setValues.status).toBe('superseded');
    expect(setValues.status).not.toBe('completed');
    expect(setValues.waitingFor).toBeNull();
    expect(setValues.completedAt).toBeInstanceOf(Date);
  });

  it('allows API key auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'account-1' });
    mockWorkersFindFirst.mockResolvedValue({
      ...baseWorker,
      accountId: 'account-1',
    });

    const req = createMockRequestWithAuth({ message: 'Use JWT tokens' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.taskId).toBe('new-task-1');
  });

  it('returns 403 when API key account does not own worker', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue({ id: 'other-account' });
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

    const req = createMockRequestWithAuth({ message: 'Use JWT tokens' }, 'bld_test');
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(403);
  });

  it('includes iteration count in context', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });

    // Worker from a task that already has iteration context
    const workerWithIteration = {
      ...baseWorker,
      task: {
        ...baseWorker.task,
        context: { iteration: 2 },
      },
    };
    mockWorkersFindFirst.mockResolvedValue(workerWithIteration);

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);

    const insertedValues = mockInsertValues.mock.calls[0][0];
    expect(insertedValues.context.iteration).toBe(3);
  });

  it('sets iteration to 2 when no previous iteration', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);

    const insertedValues = mockInsertValues.mock.calls[0][0];
    expect(insertedValues.context.iteration).toBe(2);
  });

  it('inherits roleSlug and mode from original task', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);

    const insertedValues = mockInsertValues.mock.calls[0][0];
    expect(insertedValues.roleSlug).toBe('frontend-dev');
    expect(insertedValues.mode).toBe('execution');
  });

  // Defect 3: the continuation's job is the parent's job, so what-must-it-deliver
  // fields carry over. Verified field by field rather than a blanket copy.
  it('copies priority, outputRequirement, outputSchema, category, pathManifest, backend from the parent task', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);

    const insertedValues = mockInsertValues.mock.calls[0][0];
    expect(insertedValues.priority).toBe(7);
    expect(insertedValues.outputRequirement).toBe('pr_required');
    expect(insertedValues.category).toBe('bug');
    expect(insertedValues.pathManifest).toEqual(['apps/web/src/lib/auth.ts']);
    expect(insertedValues.backend).toBe('claude');
  });

  it('copies a custom outputSchema from the parent task', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    const customSchema = { type: 'object', properties: { verdict: { type: 'string' } } };
    mockWorkersFindFirst.mockResolvedValue({
      ...baseWorker,
      task: { ...baseWorker.task, outputSchema: customSchema },
    });

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);

    const insertedValues = mockInsertValues.mock.calls[0][0];
    expect(insertedValues.outputSchema).toEqual(customSchema);
  });

  // Defect 3: dependsOn/subjectAnchor describe the PARENT's gating and dedup
  // identity, not the continuation's — copying them would either re-gate on
  // already-satisfied prerequisites or collide with a dedup subsystem this
  // route isn't part of. creationSource intentionally defaults to 'api' — this
  // row was created by a human/API caller answering a question, not by the
  // orchestrator (see the planning-contract guard's taskClass check for why
  // that distinction matters).
  it('does not copy dependsOn, subjectAnchor, or creationSource from the parent task', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);

    const insertedValues = mockInsertValues.mock.calls[0][0];
    expect(insertedValues.dependsOn).toBeUndefined();
    expect(insertedValues.subjectAnchor).toBeUndefined();
    expect(insertedValues.creationSource).toBeUndefined();
  });

  it('preserves missionId on retry task', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);

    const insertedValues = mockInsertValues.mock.calls[0][0];
    expect(insertedValues.missionId).toBe('mission-1');
  });

  it('handles structured WaitingForOption objects in waitingFor', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });

    const workerWithStructuredOptions = {
      ...baseWorker,
      waitingFor: {
        type: 'question',
        prompt: 'Which database should we use?',
        options: [
          { label: 'PostgreSQL', description: 'Best for relational data', recommended: true },
          { label: 'MongoDB', description: 'Good for document storage' },
        ],
      },
    };
    mockWorkersFindFirst.mockResolvedValue(workerWithStructuredOptions);

    const req = createMockRequest({ message: 'PostgreSQL' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);

    const insertedValues = mockInsertValues.mock.calls[0][0];
    // The question should be preserved in the context
    expect(insertedValues.context.previousAttempt.question).toBe('Which database should we use?');
    // The description should contain the question
    expect(insertedValues.description).toContain('Which database should we use?');
    // The user's answer should be in the description
    expect(insertedValues.description).toContain('PostgreSQL');
  });

  it('handles worker with null milestones gracefully', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });

    const workerWithNullMilestones = {
      ...baseWorker,
      milestones: null,
    };
    mockWorkersFindFirst.mockResolvedValue(workerWithNullMilestones);

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);

    const insertedValues = mockInsertValues.mock.calls[0][0];
    expect(insertedValues.description).toContain('No milestones recorded');
    expect(insertedValues.context.previousAttempt.milestones).toEqual([]);
  });

  it('includes structured description with milestones and question', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);

    const insertedValues = mockInsertValues.mock.calls[0][0];
    // Description should include original description, milestones, question, and answer
    expect(insertedValues.description).toContain('Fix the authentication bug in login flow');
    expect(insertedValues.description).toContain('Set up project structure');
    expect(insertedValues.description).toContain('Which authentication method should we use?');
    expect(insertedValues.description).toContain('Use JWT tokens');
  });

  // ---------------------------------------------------------------------------
  // C3: concurrent answers
  // ---------------------------------------------------------------------------
  // The route guarded only on `!worker.waitingFor` (read outside the write) and
  // then updated by id alone, after having already inserted the retry task. Two
  // humans answering the same question — or one human double-submitting — both
  // got 200, both inserted a "Continue:" task, and both clobbered worker state.
  describe('concurrency (CAS)', () => {
    it('claims the answer with a CAS before inserting the retry task', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });
      expect(res.status).toBe(200);

      // State flip must precede the insert, so a loser inserts nothing.
      expect(callOrder[0]).toBe('update');
      expect(callOrder).toContain('insert');
      expect(callOrder.indexOf('update')).toBeLessThan(callOrder.indexOf('insert'));

      // The write must be conditional on the question still being open.
      const where = mockWorkersUpdateWhere.mock.calls[0][0] as any;
      expect(JSON.stringify(where)).toContain('isNotNull');
      expect(JSON.stringify(where)).toContain('workers.waitingFor');
    });

    it('returns 409 and inserts no retry task when another answer already won', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

      // Racer already cleared waitingFor: the CAS matches no row.
      mockWorkersUpdateReturning.mockReturnValue([]);

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain('already answered');
      expect(mockInsertValues).not.toHaveBeenCalled();
    });

    it('restores the question when the retry task insert fails', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

      mockInsertReturning.mockImplementation((() => {
        throw new Error('insert exploded');
      }) as any);

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(500);
      // Claim + compensating restore — never leave a half-applied answer where
      // the worker is completed but no retry task exists.
      expect(mockWorkersUpdateSet).toHaveBeenCalledTimes(2);
      const restore = mockWorkersUpdateSet.mock.calls[1][0] as any;
      expect(restore.status).toBe(baseWorker.status);
      expect(restore.waitingFor).toEqual(baseWorker.waitingFor);
    });
  });

  // ---------------------------------------------------------------------------
  // Answer path: resume the parked session, or fall back loudly
  // ---------------------------------------------------------------------------
  // A worker parked on a question is a HEALTHY session. Answering it used to
  // end that session unconditionally and hand a cold `Continue:` task a branch
  // and a description — so a worker hundreds of turns deep lost every judgement
  // it had made. See docs/specs/answered-question-resume.md.
  describe('answer path', () => {
    /** A worker that clears every resume gate. */
    function parkedWorker(overrides: Record<string, unknown> = {}) {
      return {
        ...baseWorker,
        status: 'waiting_input',
        updatedAt: new Date(),
        turns: 42,
        supportsInstructionAck: true,
        pendingInstructions: null,
        instructionHistory: [],
        account: { teamId: 'team-1' },
        ...overrides,
      };
    }

    function authorize() {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    }

    // AC-AQR-9 — same task, same worker, no Continue: child.
    it('resumes the parked session instead of creating a continuation task', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(parkedWorker());

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.path).toBe('resume');
      expect(data.reasonCode).toBe('resume_eligible');
      // The caller navigates back to the SAME task — the resumed worker is there.
      expect(data.taskId).toBe('task-1');
      expect(mockInsertValues).not.toHaveBeenCalled();
    });

    // AC-AQR-10 — the answer rides the acknowledged instruction queue, which is
    // the wiring the runner already drains into resumeSession.
    it('queues the answer on the same worker with an unconfirmed delivery state', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(parkedWorker());

      await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      const setValues = mockWorkersUpdateSet.mock.calls[0][0] as any;
      expect(setValues.pendingInstructions).toBe('Use JWT tokens');
      expect(setValues.instructionHistory).toHaveLength(1);
      expect(setValues.instructionHistory[0].deliveryState).toBe('pending');
      expect(setValues.instructionHistory[0].message).toBe('Use JWT tokens');
    });

    it('appends to an existing instruction queue rather than overwriting it', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(
        parkedWorker({ pendingInstructions: 'earlier undelivered message' }),
      );

      await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      const setValues = mockWorkersUpdateSet.mock.calls[0][0] as any;
      expect(setValues.pendingInstructions).toContain('earlier undelivered message');
      expect(setValues.pendingInstructions).toContain('Use JWT tokens');
    });

    // AC-AQR-11 — superseding a worker that goes on to finish would hide a real
    // success or failure behind an analytics exclusion.
    it('does not supersede or complete the resumed worker', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(parkedWorker());

      await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      const setValues = mockWorkersUpdateSet.mock.calls[0][0] as any;
      expect(setValues.status).toBeUndefined();
      expect(setValues.completedAt).toBeUndefined();
      expect(setValues.waitingFor).toBeNull();
    });

    it('pushes the answer urgently as well as queueing it', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(parkedWorker());

      await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
      const [channel, event, payload] = mockTriggerEvent.mock.calls[0] as any[];
      expect(channel).toBe('worker-worker-1');
      expect(event).toBe('worker:command');
      expect(payload).toMatchObject({ action: 'message', text: 'Use JWT tokens' });
    });

    // AC-AQR-12/13 — the resume path offers no second way past the single-answer guard.
    it('still gates on the question being open, returning 409 to a racing answer', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(parkedWorker());
      mockWorkersUpdateReturning.mockReturnValue([]);

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(409);
      expect(mockInsertValues).not.toHaveBeenCalled();
      expect(mockTriggerEvent).not.toHaveBeenCalled();
      const where = mockWorkersUpdateWhere.mock.calls[0][0] as any;
      expect(JSON.stringify(where)).toContain('isNotNull');
    });

    it('records the resume decision on the answered task', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(parkedWorker());

      await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(tasksUpdated).toHaveLength(1);
      expect(tasksUpdated[0].context.answerDelivery).toMatchObject({
        path: 'resume',
        reasonCode: 'resume_eligible',
        workerId: 'worker-1',
      });
      expect(tasksUpdated[0].context.answerDelivery.ackDeadlineAt).toBeTruthy();
    });

    it('posts one feed note naming the resumed path', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(parkedWorker());

      await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(notesInserted).toHaveLength(1);
      expect(notesInserted[0].type).toBe('update');
      expect(notesInserted[0].taskId).toBe('task-1');
      expect(notesInserted[0].body).toContain('Resumed');
    });

    // AC-AQR-14/15 — a fallback is never silent.
    it.each([
      ['a worker that is no longer parked', { status: 'error' }, 'worker_not_parked'],
      [
        'a runner that stopped syncing the worker',
        { updatedAt: new Date(Date.now() - 10 * 60 * 1000) },
        'runner_not_holding_transcript',
      ],
      [
        'a runner that cannot confirm delivery',
        { supportsInstructionAck: false },
        'runner_cannot_confirm_delivery',
      ],
      ['a session past the turn ceiling', { turns: 5000 }, 'context_ceiling'],
    ])('falls back to a continuation for %s, recording the reason', async (_label, overrides, reasonCode) => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(parkedWorker(overrides as Record<string, unknown>));

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.path).toBe('cold_continuation');
      expect(data.reasonCode).toBe(reasonCode);
      expect(data.taskId).toBe('new-task-1');

      // Recorded on the continuation itself, on the answered task, and in the feed.
      const insertedValues = mockInsertValues.mock.calls[0][0] as any;
      expect(insertedValues.context.answerDelivery.reasonCode).toBe(reasonCode);
      expect(tasksUpdated[0].context.answerDelivery.reasonCode).toBe(reasonCode);
      expect(notesInserted).toHaveLength(1);
      expect(notesInserted[0].body).toContain('continuation');
    });

    // AC-AQR-23 — the answer is still recorded; the owner is warned separately.
    it('warns the owner when the backend credential is unhealthy, without dropping the answer', async () => {
      authorize();
      mockPreflight.mockImplementation(async () => ({
        state: 'unhealthy' as const,
        detail: 'the claude credential for this workspace is expired and could not be refreshed',
      }) as any);
      mockWorkersFindFirst.mockResolvedValue(parkedWorker());

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.reasonCode).toBe('credential_unhealthy');
      // The human's answer survives as a durable task.
      expect(mockInsertValues).toHaveBeenCalledTimes(1);
      expect(notesInserted[0].type).toBe('warning');
      expect(notesInserted[0].body).toContain('expired');
    });

    // AC-AQR-8 — an account supplying its own key has no managed row.
    it('resumes when no managed credential row exists', async () => {
      authorize();
      mockPreflight.mockImplementation(async () => ({ state: 'unknown' as const }) as any);
      mockWorkersFindFirst.mockResolvedValue(parkedWorker());

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      const data = await res.json();
      expect(data.path).toBe('resume');
    });

    it('preflights the codex credential for a codex-backed task', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(
        parkedWorker({ task: { ...baseWorker.task, backend: 'codex' } }),
      );

      await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(mockPreflight.mock.calls[0][0]).toMatchObject({ backend: 'codex' });
    });

    it('omits the question from the delivery record for a sensitive workspace', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue(
        parkedWorker({ workspace: { teamId: 'team-1', dataClass: 'sensitive' } }),
      );

      await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(tasksUpdated[0].context.answerDelivery.question).toBeUndefined();
      const setValues = mockWorkersUpdateSet.mock.calls[0][0] as any;
      expect(setValues.instructionHistory[0].message).toBeUndefined();
    });
  });
  // ---------------------------------------------------------------------------
  // Revoked credential: refused outright, not routed down either path (#2528).
  //
  // A revoked credential cannot be recovered without a human, and the claim
  // rail already declines to inject one — so a continuation could not run
  // either, while superseding the worker would destroy the transcript and
  // worktree that make a later RESUME possible. Refusing keeps the question
  // parked and costs nothing. An expired-but-refreshable credential is the
  // different case handled by gate G5 above.
  // ---------------------------------------------------------------------------
  describe('revoked credential refusal', () => {
    function authorize() {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    }

    it('refuses the answer when the claude credential is revoked, leaving the question open', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });
      mockPreflight.mockImplementation(async () => ({
        state: 'unhealthy' as const,
        revoked: true,
        detail: 'the claude credential for this workspace has been revoked',
        lastFailureMessage: 'invalid_grant',
      }) as any);

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.credentialRevoked).toBe(true);
      expect(data.backend).toBe('claude');
      expect(data.error).toContain('revoked');
      expect(data.error).toContain('invalid_grant');
      // Nothing written: the answer is not lost and no continuation is
      // dispatched into a dead credential.
      expect(mockWorkersUpdateSet).not.toHaveBeenCalled();
      expect(mockInsertValues).not.toHaveBeenCalled();
      expect(notesInserted).toHaveLength(0);
    });

    it('names the codex backend when a codex-backed task has a revoked credential', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue({
        ...baseWorker,
        task: { ...baseWorker.task, backend: 'codex' },
      });
      mockPreflight.mockImplementation(async () => ({
        state: 'unhealthy' as const,
        revoked: true,
        detail: 'the codex credential for this workspace has been revoked',
      }) as any);

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.credentialRevoked).toBe(true);
      expect(data.backend).toBe('codex');
      expect(mockInsertValues).not.toHaveBeenCalled();
    });

    it('proceeds when the credential is merely healthy or absent', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });
      mockPreflight.mockImplementation(async () => ({ state: 'unknown' as const }) as any);

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.taskId).toBe('new-task-1');
    });
  });

  // ---------------------------------------------------------------------------
  // Continuation link-back (#2528): a later reader of the answered worker's row
  // (the task-detail page, a post-supersession error report) needs a durable
  // pointer to where the work continued. Cold path only — a resume has no
  // second task, so asserting its absence there is part of the contract.
  // ---------------------------------------------------------------------------
  describe('continuation task link-back', () => {
    function authorize() {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    }

    it('writes the continuation taskId back onto the answered worker after success', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(200);
      // [0] = claim CAS, [1] = continuation link-back.
      expect(mockWorkersUpdateSet).toHaveBeenCalledTimes(2);
      const linkBack = mockWorkersUpdateSet.mock.calls[1][0] as any;
      expect(linkBack.continuationTaskId).toBe('new-task-1');
    });

    it('does not fail the answer when the link-back write itself fails', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

      let calls = 0;
      mockWorkersUpdateSet.mockImplementation((() => {
        calls += 1;
        callOrder.push('update');
        if (calls === 2) {
          return { where: mock(() => { throw new Error('link-back write exploded'); }) };
        }
        return { where: mockWorkersUpdateWhere };
      }) as any);

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.taskId).toBe('new-task-1');
    });

    it('does not link a continuation onto a RESUMED worker', async () => {
      authorize();
      mockWorkersFindFirst.mockResolvedValue({
        ...baseWorker,
        status: 'waiting_input',
        updatedAt: new Date(),
        turns: 42,
        supportsInstructionAck: true,
        pendingInstructions: null,
        instructionHistory: [],
      });

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.path).toBe('resume');
      // One write only — the claim. Nothing claims a supersession that did not
      // happen.
      expect(mockWorkersUpdateSet).toHaveBeenCalledTimes(1);
      expect(mockWorkersUpdateSet.mock.calls[0][0].continuationTaskId).toBeUndefined();
    });
  });
});
