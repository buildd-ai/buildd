import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));

const mockWorkersFindMany = mock(() => [] as any[]);
const mockMissionNotesFindMany = mock(() => [] as any[]);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockTasksFindMany = mock(() => [] as any[]);

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  getUserWorkspaceIds: mockGetUserWorkspaceIds,
}));

mock.module('@/lib/merge-policy', () => ({
  resolvePolicy: (ws: any) => {
    const tier = ws?.gitConfig?.mergePolicy?.tier ?? 'auto-threshold';
    return { tier };
  },
}));

mock.module('@/lib/task-presentation', () => ({
  LIVE_WORKER_STATUSES: ['idle', 'running', 'starting', 'waiting_input'],
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      tasks: { findMany: mockTasksFindMany },
      missionNotes: { findMany: mockMissionNotesFindMany },
      workspaces: { findMany: mockWorkspacesFindMany },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  inArray: (a: any, b: any) => ({ type: 'inArray', a, b }),
  isNotNull: (a: any) => ({ type: 'isNotNull', a }),
  isNull: (a: any) => ({ type: 'isNull', a }),
  sql: (strings: any, ...values: any[]) => ({ type: 'sql', strings, values }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: {
    workspaceId: 'workspaceId',
    prUrl: 'prUrl',
    mergedAt: 'mergedAt',
    prLifecycleStatus: 'prLifecycleStatus',
    status: 'status',
  },
  tasks: { id: 'id', title: 'title', missionId: 'missionId', workspaceId: 'workspaceId', category: 'category', status: 'status', roleSlug: 'roleSlug', context: 'context' },
  workspaces: { id: 'id' },
  missionNotes: { taskId: 'taskId', type: 'type' },
}));

import { GET } from './route';

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/prs/escalation-inbox');
}

function makeWorker(overrides: Record<string, any> = {}) {
  return {
    id: 'w-1',
    taskId: 't-1',
    workspaceId: 'ws-1',
    prUrl: 'https://github.com/org/repo/pull/42',
    prNumber: 42,
    prLifecycleStatus: 'pr_open',
    completedAt: new Date('2026-07-20T10:00:00Z'),
    task: { id: 't-1', title: 'Build thing', missionId: null },
    ...overrides,
  };
}

function makeReviewerTask(originalTaskId: string, hasLiveWorker: boolean) {
  return {
    id: 'rt-1',
    context: { reviewerFor: originalTaskId, prNumber: 42 },
    roleSlug: 'reviewer',
    workers: hasLiveWorker ? [{ id: 'rw-1', status: 'running' }] : [],
  };
}

describe('GET /api/prs/escalation-inbox', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockWorkersFindMany.mockReset();
    mockMissionNotesFindMany.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockTasksFindMany.mockReset();
    mockTasksFindMany.mockResolvedValue([]);
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns empty when no workspaces', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue([]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.count).toBe(0);
  });

  it('includes open PR in human-gate workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([makeWorker()]);
    mockMissionNotesFindMany.mockResolvedValue([]);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'Acme', gitConfig: { mergePolicy: { tier: 'human' } } },
    ]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.items[0].prNumber).toBe(42);
    expect(body.items[0].leaseState).toBe('pending_human');
  });

  it('excludes closed PR from inbox even if DB returns it', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([
      makeWorker({ prLifecycleStatus: 'closed' }),
    ]);
    mockMissionNotesFindMany.mockResolvedValue([]);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'Acme', gitConfig: { mergePolicy: { tier: 'human' } } },
    ]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.count).toBe(0);
  });

  it('excludes smoke-test tasks from inbox', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([
      makeWorker({ task: { id: 't-1', title: '[smoke-test-4] verify worker lifecycle', missionId: null } }),
    ]);
    mockMissionNotesFindMany.mockResolvedValue([]);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'Acme', gitConfig: { mergePolicy: { tier: 'human' } } },
    ]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.count).toBe(0);
  });

  it('includes escalated PR regardless of workspace policy (agent_flagged)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([makeWorker()]);
    mockMissionNotesFindMany.mockResolvedValue([
      { taskId: 't-1', type: 'reviewer_escalated', title: 'Escalated', body: 'Reviewer could not decide', status: 'open', createdAt: new Date() },
    ]);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'Acme', gitConfig: null },
    ]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.items[0].leaseState).toBe('agent_flagged');
    expect(body.items[0].escalationReason).toBe('Reviewer could not decide');
  });

  it('excludes a superseded hold even when the workspace policy is human', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([makeWorker()]);
    mockMissionNotesFindMany.mockResolvedValue([
      {
        taskId: 't-1',
        type: 'reviewer_escalated',
        title: 'Escalated',
        body: 'Original hold',
        status: 'superseded',
        supersededByPrNumber: 43,
        createdAt: new Date(),
      },
    ]);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'Acme', gitConfig: { mergePolicy: { tier: 'human' } } },
    ]);

    const res = await GET(makeRequest());
    expect((await res.json()).count).toBe(0);
  });

  // ── Lease detection tests ────────────────────────────────────────────────

  it('excludes PR from inbox while agent review lease is active (agent_reviewing)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([makeWorker()]);
    mockMissionNotesFindMany.mockResolvedValue([]);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'Acme', gitConfig: { mergePolicy: { tier: 'human' } } },
    ]);
    // Reviewer task with a live worker
    mockTasksFindMany.mockResolvedValue([makeReviewerTask('t-1', true)]);

    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.count).toBe(0);
  });

  it('includes PR in inbox once reviewer worker is gone (lease released)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([makeWorker()]);
    mockMissionNotesFindMany.mockResolvedValue([]);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'Acme', gitConfig: { mergePolicy: { tier: 'human' } } },
    ]);
    // Reviewer task exists but has NO live worker
    mockTasksFindMany.mockResolvedValue([makeReviewerTask('t-1', false)]);

    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.items[0].leaseState).toBe('pending_human');
  });

  it('includes agent_approved item with verdictSummary when approve-only gate fired', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([makeWorker()]);
    mockMissionNotesFindMany.mockResolvedValue([
      {
        taskId: 't-1',
        type: 'reviewer_approved',
        title: 'PR #42 approved — awaiting human merge',
        body: "Reviewer approved (confidence 0.95): Looks good!\n\nGate condition is 'approve-only'. Merge from the escalation inbox.",
        status: 'open',
        createdAt: new Date(),
      },
    ]);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'Acme', gitConfig: { mergePolicy: { tier: 'agent-review', agentReview: { gateCondition: 'approve-only' } } } },
    ]);
    mockTasksFindMany.mockResolvedValue([]);

    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.items[0].leaseState).toBe('agent_approved');
    expect(body.items[0].verdictSummary).toContain('approve-only');
    expect(body.items[0].escalationReason).toBeNull();
  });

  it('prefers merge-gate evidence regardless of note query order', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([makeWorker()]);
    mockMissionNotesFindMany.mockResolvedValue([
      {
        taskId: 't-1',
        type: 'reviewer_approved',
        title: 'PR #42 approved by reviewer',
        body: 'Reviewer approved (confidence 0.95): Looks good!',
        status: 'open',
        createdAt: new Date('2026-07-20T10:01:00Z'),
      },
      {
        taskId: 't-1',
        type: 'reviewer_approved',
        title: 'PR #42 approved — awaiting human merge',
        body: "Reviewer approved (confidence 0.95): Looks good!\n\nGate condition is 'approve-only'. Merge from the escalation inbox.",
        status: 'open',
        createdAt: new Date('2026-07-20T10:00:00Z'),
      },
    ]);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'Acme', gitConfig: { mergePolicy: { tier: 'agent-review' } } },
    ]);

    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.items[0].verdictSummary).toContain("Gate condition is 'approve-only'");
  });

  it('agent_reviewed lease excludes even if approve-only note exists (review still in progress)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([makeWorker()]);
    // Both an approved note AND an active reviewer worker would be contradictory but
    // lease detection wins: the item is excluded while the worker is live.
    mockMissionNotesFindMany.mockResolvedValue([
      {
        taskId: 't-1',
        type: 'reviewer_approved',
        title: 'Already approved',
        body: 'Previous run approved it',
        status: 'open',
        createdAt: new Date(),
      },
    ]);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'Acme', gitConfig: { mergePolicy: { tier: 'human' } } },
    ]);
    mockTasksFindMany.mockResolvedValue([makeReviewerTask('t-1', true)]);

    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.count).toBe(0);
  });
});
