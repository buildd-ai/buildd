import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockTasksFindMany = mock(() => [] as any[]);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));

// Track insert calls via closures
let mockInsertValues: any[] = [];
let insertCount = 0;
let mockUpdateSetCalls: any[] = [];

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
      tasks: { findFirst: mockTasksFindFirst, findMany: mockTasksFindMany },
    },
    insert: (_table: any) => ({
      values: (vals: any) => {
        mockInsertValues.push(vals);
        return {
          returning: () => {
            insertCount++;
            return [{ id: `child-task-${insertCount}` }];
          },
        };
      },
    }),
    update: (_table: any) => ({
      set: (data: any) => {
        mockUpdateSetCalls.push(data);
        return { where: () => Promise.resolve() };
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

  const url = 'http://localhost:3000/api/tasks/plan-task-1/approve-plan';
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

describe('POST /api/tasks/[id]/approve-plan', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockTasksFindMany.mockResolvedValue([]);
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockInsertValues = [];
    mockUpdateSetCalls = [];
    insertCount = 0;

    // Default: grant access
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
  });

  it('returns 401 when no auth', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const request = createMockRequest();
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when task not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(null);

    const request = createMockRequest();
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

    const request = createMockRequest();
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Task is not a planning task');
  });

  it('returns 400 when task is not completed', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'plan-task-1',
      mode: 'planning',
      status: 'running',
      workspaceId: 'ws-1',
      workspace: { id: 'ws-1' },
    });

    const request = createMockRequest();
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Planning task has not completed yet');
  });

  it('returns 400 when no plan in structured output', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'plan-task-1',
      mode: 'planning',
      status: 'completed',
      workspaceId: 'ws-1',
      result: { structuredOutput: {} },
      workspace: { id: 'ws-1' },
    });

    const request = createMockRequest();
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('No plan found in task result');
  });

  it('creates child tasks from plan steps', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'plan-task-1',
      mode: 'planning',
      status: 'completed',
      workspaceId: 'ws-1',
      parentTaskId: null,
      priority: 1,
      context: {},
      description: 'Test plan',
      result: {
        structuredOutput: {
          plan: [
            { ref: 'step-1', title: 'Research', description: 'Do research' },
            { ref: 'step-2', title: 'Implement', description: 'Write code', dependsOn: ['step-1'] },
          ],
          summary: 'Two step plan',
        },
      },
      workspace: { id: 'ws-1' },
    });

    const request = createMockRequest();
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tasks).toHaveLength(2);
    expect(data.tasks).toEqual(['child-task-1', 'child-task-2']);

    // Verify insert was called for each step
    expect(mockInsertValues).toHaveLength(2);
    expect(mockInsertValues[0].title).toBe('Research');
    expect(mockInsertValues[0].parentTaskId).toBe('plan-task-1');
    expect(mockInsertValues[0].mode).toBe('execution');
    expect(mockInsertValues[1].title).toBe('Implement');
    expect(mockInsertValues[1].parentTaskId).toBe('plan-task-1');
  });

  it('resolves ref-based dependsOn to actual task IDs', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'plan-task-1',
      mode: 'planning',
      status: 'completed',
      workspaceId: 'ws-1',
      parentTaskId: null,
      priority: 1,
      context: {},
      description: 'Test plan',
      result: {
        structuredOutput: {
          plan: [
            { ref: 'step-1', title: 'Research', description: 'Do research' },
            { ref: 'step-2', title: 'Implement', description: 'Write code', dependsOn: ['step-1'] },
          ],
          summary: 'Two step plan',
        },
      },
      workspace: { id: 'ws-1' },
    });

    const request = createMockRequest();
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.tasks).toEqual(['child-task-1', 'child-task-2']);

    // Second pass should have called update with resolved dependsOn
    // step-2 depends on step-1 which was mapped to child-task-1
    expect(mockUpdateSetCalls).toHaveLength(1);
    expect(mockUpdateSetCalls[0].dependsOn).toEqual(['child-task-1']);
  });

  it('returns 409 when plan already approved (duplicate guard)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'plan-task-1',
      mode: 'planning',
      status: 'completed',
      workspaceId: 'ws-1',
      result: {
        structuredOutput: {
          plan: [{ ref: 'step-1', title: 'Research', description: 'Do research' }],
          summary: 'A plan',
        },
      },
      workspace: { id: 'ws-1' },
    });

    // Simulate existing children (plan already approved)
    mockTasksFindMany.mockResolvedValue([{ id: 'existing-child-1' }]);

    const request = createMockRequest();
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error).toBe('Plan already approved');
    // Ensure no inserts happened
    expect(mockInsertValues).toHaveLength(0);
  });

  it('preserves missionId on child execution tasks', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'plan-task-1',
      mode: 'planning',
      status: 'completed',
      workspaceId: 'ws-1',
      missionId: 'mission-42',
      result: {
        structuredOutput: {
          plan: [
            { ref: 'step-1', title: 'Research', description: 'Do research' },
            { ref: 'step-2', title: 'Implement', description: 'Write code' },
          ],
          summary: 'Two step plan',
        },
      },
      workspace: { id: 'ws-1' },
    });

    const request = createMockRequest();
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(200);
    expect(mockInsertValues).toHaveLength(2);
    expect(mockInsertValues[0].missionId).toBe('mission-42');
    expect(mockInsertValues[1].missionId).toBe('mission-42');
  });

  it('returns 400 when plan has circular dependencies', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'plan-task-1',
      mode: 'planning',
      status: 'completed',
      workspaceId: 'ws-1',
      result: {
        structuredOutput: {
          plan: [
            { ref: 'a', title: 'Step A', description: 'A', dependsOn: ['c'] },
            { ref: 'b', title: 'Step B', description: 'B', dependsOn: ['a'] },
            { ref: 'c', title: 'Step C', description: 'C', dependsOn: ['b'] },
          ],
          summary: 'Circular plan',
        },
      },
      workspace: { id: 'ws-1' },
    });

    const request = createMockRequest();
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Circular dependency detected');
    // Ensure no inserts happened
    expect(mockInsertValues).toHaveLength(0);
  });
});
