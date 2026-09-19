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
// Ledger writes are tracked separately from the planning-task rejection write.
const mockDiscrepancyUpdateSets: any[] = [];
let mockDiscrepancyUpdateReturning: any[] = [];

const schemaTasks = { id: 'id', parentTaskId: 'parentTaskId', context: 'context' };
const schemaSpecDiscrepancies = { id: 'sd.id', proposalRejectedReason: 'sd.proposal_rejected_reason' };

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
    update: (table: any) => ({
      set: (vals: any) => {
        if (table === schemaSpecDiscrepancies) {
          mockDiscrepancyUpdateSets.push(vals);
          return { where: () => ({ returning: () => Promise.resolve(mockDiscrepancyUpdateReturning) }) };
        }
        mockUpdateSetCalls.push(vals);
        return { where: () => ({ returning: mockUpdateReturning }) };
      },
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conds: any[]) => ({ conds, type: 'and' }),
  inArray: (field: any, values: any) => ({ field, values, type: 'inArray' }),
  sql: (strings: any, ...values: any[]) => ({ strings, values, type: 'sql' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: schemaTasks,
  specDiscrepancies: schemaSpecDiscrepancies,
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
    mockDiscrepancyUpdateSets.length = 0;
    mockDiscrepancyUpdateReturning = [];

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
  // ── Doc-fix proposal rejection ──────────────────────────────────────────────
  // A doc-fix task's plan is an OPTIONAL net-enhancement proposal; the docs-only
  // PR already shipped independently of it. Rejecting closes the proposal and
  // keeps the reason on the ledger rows — it must NOT respawn a planning task,
  // which would re-dispatch a worker against a document that is already fixed.

  const DOC_FIX_TASK = {
    id: 'plan-task-1',
    mode: 'planning',
    status: 'completed',
    workspaceId: 'ws-1',
    parentTaskId: null,
    missionId: null,
    priority: 1,
    title: 'Reconcile spec with shipped code: docs/design/x.md',
    description: 'Reconcile the doc.',
    context: {
      planOptional: true,
      specDocFix: {
        specPath: 'docs/design/x.md',
        assertionIds: ['a-1', 'a-2'],
        discrepancyIds: ['d-1', 'd-2'],
        workspaceId: 'ws-1',
      },
    },
    workspace: { id: 'ws-1' },
  };

  it('rejecting a doc-fix proposal retains the reason on every discrepancy row it named', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(DOC_FIX_TASK);
    mockDiscrepancyUpdateReturning = [{ id: 'd-1' }, { id: 'd-2' }];

    const request = createMockRequest({ body: { feedback: 'Out of scope for now — revisit after the broker lands.' } });
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.proposalRejected).toBe(true);
    expect(data.specPath).toBe('docs/design/x.md');
    expect(data.discrepancyIds).toEqual(['d-1', 'd-2']);

    expect(mockDiscrepancyUpdateSets).toHaveLength(1);
    expect(mockDiscrepancyUpdateSets[0].proposalRejectedReason).toBe(
      'Out of scope for now — revisit after the broker lands.',
    );
  });

  it('rejecting a doc-fix proposal does NOT respawn a planning task', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(DOC_FIX_TASK);

    const request = createMockRequest({ body: { feedback: 'No thanks' } });
    const response = await callHandler(POST, request, 'plan-task-1');

    expect(response.status).toBe(200);
    expect((await response.json()).taskId).toBeNull();
    expect(mockInsertValues).toHaveLength(0);
  });

  it('the rejection is still persisted on the doc-fix task itself', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-123', email: 'user@test.com' });
    mockTasksFindFirst.mockResolvedValue(DOC_FIX_TASK);

    const request = createMockRequest({ body: { feedback: 'No thanks' } });
    await callHandler(POST, request, 'plan-task-1');

    expect(mockUpdateSetCalls).toHaveLength(1);
    expect(mockUpdateSetCalls[0].context.planRejection.feedback).toBe('No thanks');
  });
});
