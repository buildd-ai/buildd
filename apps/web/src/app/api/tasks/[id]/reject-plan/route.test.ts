import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));

// Track insert calls
const mockInsertValues: any[] = [];
const mockInsertReturning = mock(() => [{ id: 'new-plan-task-1' }]);

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: async (apiKey: string | null) => {
    if (!apiKey) return null;
    return { id: 'account-1', type: 'user' };
  },
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

// Track update calls (rejection persistence)
const mockUpdateSetCalls: any[] = [];
const mockUpdateReturning = mock(() => [{ id: 'plan-task-1' }] as any[]);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTasksFindFirst },
    },
    insert: () => ({
      values: (vals: any) => {
        mockInsertValues.push(vals);
        return { returning: mockInsertReturning };
      },
    }),
    update: () => ({
      set: (vals: any) => {
        mockUpdateSetCalls.push(vals);
        return { where: () => ({ returning: mockUpdateReturning }) };
      },
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conds: any[]) => ({ conds, type: 'and' }),
  sql: (strings: any, ...values: any[]) => ({ strings, values, type: 'sql' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id', parentTaskId: 'parentTaskId', context: 'context' },
}));

// Import handler AFTER mocks
import { POST } from './route';

// Helper to create mock NextRequest
function createMockRequest(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
} = {}): NextRequest {
  const { method = 'POST', headers = {}, body } = options;

  const url = 'http://localhost:3000/api/tasks/plan-task-1/reject-plan';
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
async function callHandler(handler: Function, request: NextRequest, id: string) {
  return handler(request, { params: Promise.resolve({ id }) });
}

describe('POST /api/tasks/[id]/reject-plan', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockTasksFindFirst.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockInsertReturning.mockReset();
    mockInsertValues.length = 0;
    mockInsertReturning.mockReturnValue([{ id: 'new-plan-task-1' }]);
    mockUpdateSetCalls.length = 0;
    mockUpdateReturning.mockReset();
    mockUpdateReturning.mockReturnValue([{ id: 'plan-task-1' }]);

    // Default: grant access
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const request = createMockRequest({ body: { feedback: 'needs more detail' } });
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when task not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(null);

    const request = createMockRequest({ body: { feedback: 'needs more detail' } });
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('returns 400 when task is not planning mode', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'plan-task-1',
      mode: 'execution',
      status: 'completed',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1' },
    });

    const request = createMockRequest({ body: { feedback: 'needs more detail' } });
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Task is not a planning task');
  });

  it('returns 400 when feedback is missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'plan-task-1',
      mode: 'planning',
      status: 'completed',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1' },
    });

    const request = createMockRequest({ body: {} });
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Feedback is required');
  });

  it('creates revised planning task with feedback in context', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'plan-task-1',
      mode: 'planning',
      status: 'completed',
      workspaceId: 'ws-1',
      parentTaskId: 'parent-1',
      priority: 2,
      title: 'Build feature',
      description: 'Build the feature',
      context: { existingKey: 'existingValue' },
      workspace: { id: 'ws-1' },
    });

    const request = createMockRequest({ body: { feedback: 'Add error handling steps' } });
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.taskId).toBe('new-plan-task-1');

    // Verify the inserted task
    expect(mockInsertValues).toHaveLength(1);
    const inserted = mockInsertValues[0];
    expect(inserted.workspaceId).toBe('ws-1');
    expect(inserted.title).toBe('Build feature (revised)');
    expect(inserted.description).toBe('Build the feature');
    expect(inserted.mode).toBe('planning');
    expect(inserted.status).toBe('pending');
    expect(inserted.parentTaskId).toBe('parent-1');
    expect(inserted.priority).toBe(2);
    expect(inserted.context.existingKey).toBe('existingValue');
    expect(inserted.context.planFeedback).toBe('Add error handling steps');
    expect(inserted.context.previousPlanTaskId).toBe('plan-task-1');
  });

  it('preserves missionId on revised planning task', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'plan-task-1',
      mode: 'planning',
      status: 'completed',
      workspaceId: 'ws-1',
      parentTaskId: null,
      missionId: 'mission-42',
      priority: 1,
      title: 'Plan feature',
      description: 'Plan it',
      context: {},
      workspace: { id: 'ws-1' },
    });

    const request = createMockRequest({ body: { feedback: 'Try again' } });
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(200);
    expect(mockInsertValues).toHaveLength(1);
    expect(mockInsertValues[0].missionId).toBe('mission-42');
  });

  it('preserves null missionId when task has no mission', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'plan-task-1',
      mode: 'planning',
      status: 'completed',
      workspaceId: 'ws-1',
      parentTaskId: null,
      missionId: null,
      priority: 1,
      title: 'Plan feature',
      description: 'Plan it',
      context: {},
      workspace: { id: 'ws-1' },
    });

    const request = createMockRequest({ body: { feedback: 'Try again' } });
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(200);
    expect(mockInsertValues).toHaveLength(1);
    expect(mockInsertValues[0].missionId).toBeNull();
  });
  // ── Regression: rejection must actually persist (C8) ────────────────────────
  // Before the fix this route issued no db.update at all: a rejection mutated
  // nothing, so approve-after-reject silently succeeded.

  it('persists the rejection on the planning task', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'plan-task-1',
      mode: 'planning',
      status: 'completed',
      workspaceId: 'ws-1',
      parentTaskId: null,
      missionId: null,
      priority: 1,
      title: 'Plan feature',
      description: 'Plan it',
      context: { existingKey: 'existingValue' },
      workspace: { id: 'ws-1' },
    });

    const request = createMockRequest({ body: { feedback: 'Missing rollback step' } });
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(200);

    // A rejected state was written to the planning task itself.
    expect(mockUpdateSetCalls).toHaveLength(1);
    const rejection = mockUpdateSetCalls[0].context.planRejection;
    expect(rejection).toBeDefined();
    expect(rejection.feedback).toBe('Missing rollback step');
    expect(typeof rejection.rejectedAt).toBe('string');
    // Existing context keys are preserved.
    expect(mockUpdateSetCalls[0].context.existingKey).toBe('existingValue');
  });

  it('returns 409 when the plan was already rejected', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'plan-task-1',
      mode: 'planning',
      status: 'completed',
      workspaceId: 'ws-1',
      parentTaskId: null,
      missionId: null,
      priority: 1,
      title: 'Plan feature',
      description: 'Plan it',
      context: { planRejection: { feedback: 'earlier rejection', rejectedAt: '2026-01-01T00:00:00.000Z' } },
      workspace: { id: 'ws-1' },
    });

    const request = createMockRequest({ body: { feedback: 'again' } });
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error).toBe('Plan already rejected');
    // No duplicate revised planning task.
    expect(mockInsertValues).toHaveLength(0);
  });

  it('returns 409 when a concurrent rejection won the optimistic lock', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'plan-task-1',
      mode: 'planning',
      status: 'completed',
      workspaceId: 'ws-1',
      parentTaskId: null,
      missionId: null,
      priority: 1,
      title: 'Plan feature',
      description: 'Plan it',
      context: {},
      workspace: { id: 'ws-1' },
    });
    // UPDATE ... WHERE planRejection IS NULL matched no row.
    mockUpdateReturning.mockReturnValue([]);

    const request = createMockRequest({ body: { feedback: 'race' } });
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(409);
    expect(mockInsertValues).toHaveLength(0);
  });
});
