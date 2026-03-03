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
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id', parentTaskId: 'parentTaskId' },
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
});
