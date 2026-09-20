import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockSecretsFindFirst = mock(() => Promise.resolve(null as any));
const mockGetActiveClaudeSecretId = mock(() => Promise.resolve(null as string | null));

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

mock.module('@/lib/credential-health', () => ({
  getActiveClaudeSecretId: mockGetActiveClaudeSecretId,
}));

// Order of writes matters (C3): the answer must be claimed with a CAS BEFORE
// the retry task is inserted, so a losing racer inserts nothing.
const callOrder: string[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
      secrets: { findFirst: mockSecretsFindFirst },
    },
    insert: mockInsert,
    update: () => mockWorkersUpdate(),
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
  secrets: { id: 'secrets.id', teamId: 'secrets.teamId', purpose: 'secrets.purpose' },
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
    mockSecretsFindFirst.mockReset();
    mockSecretsFindFirst.mockResolvedValue(null);
    mockGetActiveClaudeSecretId.mockReset();
    mockGetActiveClaudeSecretId.mockResolvedValue(null);
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
  // Credential health pre-check: a continuation must not be dispatched into a
  // backend credential already known-revoked. Requirement #4 in the task —
  // this mirrors the classification workers/[id]/route.ts's credential-health
  // step already runs on a live PATCH, just one step earlier.
  // ---------------------------------------------------------------------------
  describe('credential health pre-check', () => {
    it('refuses to answer when the claude credential is revoked, leaving the question open', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });
      mockGetActiveClaudeSecretId.mockResolvedValue('secret-1');
      mockSecretsFindFirst.mockResolvedValue({ healthStatus: 'revoked', lastFailureMessage: 'invalid_grant' });

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.credentialRevoked).toBe(true);
      expect(data.error).toContain('revoked');
      expect(data.error).toContain('invalid_grant');
      // The answer must not be lost, and no continuation dispatched into a dead credential.
      expect(mockWorkersUpdateSet).not.toHaveBeenCalled();
      expect(mockInsertValues).not.toHaveBeenCalled();
    });

    it('refuses to answer when the codex credential is revoked, for a codex-backend task', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
      mockWorkersFindFirst.mockResolvedValue({
        ...baseWorker,
        task: { ...baseWorker.task, backend: 'codex' },
      });
      mockSecretsFindFirst
        .mockResolvedValueOnce({ id: 'codex-secret-1' })
        .mockResolvedValueOnce({ healthStatus: 'revoked', lastFailureMessage: null });

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.credentialRevoked).toBe(true);
      expect(data.backend).toBe('codex');
      expect(mockInsertValues).not.toHaveBeenCalled();
    });

    it('proceeds normally when the credential is healthy', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });
      mockGetActiveClaudeSecretId.mockResolvedValue('secret-1');
      mockSecretsFindFirst.mockResolvedValue({ healthStatus: 'healthy', lastFailureMessage: null });

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.taskId).toBe('new-task-1');
    });

    it('proceeds normally when no credential is on file for the team', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });
      mockGetActiveClaudeSecretId.mockResolvedValue(null);

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(200);
      expect(mockSecretsFindFirst).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Continuation link-back: a later reader of the answered worker's row (the
  // task-detail page, a post-supersession error report) needs a durable
  // pointer to where the work continued.
  // ---------------------------------------------------------------------------
  describe('continuation task link-back', () => {
    it('writes the continuation taskId back onto the answered worker after success', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
      mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

      const res = await POST(createMockRequest({ message: 'Use JWT tokens' }), { params: mockParams });

      expect(res.status).toBe(200);
      // [0] = claim CAS, [1] = continuation link-back.
      expect(mockWorkersUpdateSet).toHaveBeenCalledTimes(2);
      const linkBack = mockWorkersUpdateSet.mock.calls[1][0] as any;
      expect(linkBack.continuationTaskId).toBe('new-task-1');
    });

    it('does not fail the answer when the link-back write itself fails', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
      mockAuthenticateApiKey.mockResolvedValue(null);
      mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
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
  });
});
