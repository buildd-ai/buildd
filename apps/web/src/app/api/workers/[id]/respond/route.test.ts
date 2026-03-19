import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));

const mockInsertReturning = mock(() => [{ id: 'new-task-1', title: 'Continue: Fix auth bug' }]);
const mockInsertValues = mock(() => ({
  returning: mockInsertReturning,
}));
const mockInsert = mock(() => ({
  values: mockInsertValues,
}));

const mockWorkersUpdateReturning = mock(() => [{ id: 'worker-1', status: 'completed' }]);
const mockWorkersUpdateWhere = mock(() => ({
  returning: mockWorkersUpdateReturning,
}));
const mockWorkersUpdateSet = mock(() => ({
  where: mockWorkersUpdateWhere,
}));
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

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
    },
    insert: mockInsert,
    update: () => mockWorkersUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers',
  tasks: 'tasks',
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
    objectiveId: 'objective-1',
    roleSlug: 'frontend-dev',
    mode: 'execution',
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
    mockInsertValues.mockReturnValue({ returning: mockInsertReturning });
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockWorkersUpdateReturning.mockReturnValue([{ id: 'worker-1', status: 'completed' }]);
    mockWorkersUpdateWhere.mockReturnValue({ returning: mockWorkersUpdateReturning });
    mockWorkersUpdateSet.mockReturnValue({ where: mockWorkersUpdateWhere });
    mockWorkersUpdate.mockReturnValue({ set: mockWorkersUpdateSet });
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
    expect(insertedValues.objectiveId).toBe('objective-1');
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

  it('marks original worker as completed after respond', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockWorkersFindFirst.mockResolvedValue({ ...baseWorker });

    const req = createMockRequest({ message: 'Use JWT tokens' });
    const res = await POST(req, { params: mockParams });

    expect(res.status).toBe(200);

    // Verify worker was updated to completed
    expect(mockWorkersUpdateSet).toHaveBeenCalledTimes(1);
    const setValues = mockWorkersUpdateSet.mock.calls[0][0];
    expect(setValues.status).toBe('completed');
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
});
