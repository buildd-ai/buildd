import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockWorkersFindMany = mock(() => Promise.resolve([] as any[]));
const mockErrorTracesFindMany = mock(() => Promise.resolve([] as any[]));
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTasksFindFirst },
      workers: { findMany: mockWorkersFindMany },
      workerErrorTraces: { findMany: mockErrorTracesFindMany },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  desc: (field: any) => ({ field, type: 'desc' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id' },
  workers: { taskId: 'taskId', createdAt: 'createdAt' },
  workerErrorTraces: { taskId: 'taskId', ts: 'ts' },
}));

import { GET } from './route';

function createRequest(taskId: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/tasks/${taskId}/summary`, {
    method: 'GET',
  });
}

async function callGET(taskId: string) {
  return GET(createRequest(taskId), { params: Promise.resolve({ id: taskId }) });
}

describe('GET /api/tasks/[id]/summary', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockTasksFindFirst.mockReset();
    mockWorkersFindMany.mockReset();
    mockErrorTracesFindMany.mockReset();
    mockErrorTracesFindMany.mockResolvedValue([]);
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'member' });
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const res = await callGET('b5814ed6-4808-499c-8eff-16e567f86576');
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns 404 when task does not exist', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockTasksFindFirst.mockResolvedValue(null);

    const res = await callGET('b5814ed6-4808-499c-8eff-16e567f86576');
    expect(res.status).toBe(404);
  });

  it('returns 404 when user does not have workspace access', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'b5814ed6-4808-499c-8eff-16e567f86576',
      title: 'feat: connectors DB schema + migration',
      status: 'running',
      description: null,
      mode: null,
      roleSlug: 'builder',
      createdAt: new Date().toISOString(),
      missionId: '5b390753-1488-4e10-95f7-67b027eae1da',
      workspaceId: 'ws-1',
      result: null,
    });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);

    const res = await callGET('b5814ed6-4808-499c-8eff-16e567f86576');
    expect(res.status).toBe(404);
  });

  it('returns task summary for a running task (regression: must not 404)', async () => {
    // Real task + worker IDs from production incident 2026-07-09
    const taskId = 'b5814ed6-4808-499c-8eff-16e567f86576';
    const workerId = 'c6a00c1a-161a-40fb-b13c-dee1670fea99';

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockTasksFindFirst.mockResolvedValue({
      id: taskId,
      title: 'feat: connectors DB schema + migration',
      status: 'running',
      description: null,
      mode: null,
      roleSlug: 'builder',
      createdAt: new Date().toISOString(),
      missionId: '5b390753-1488-4e10-95f7-67b027eae1da',
      workspaceId: 'ws-1',
      result: null,
    });
    mockWorkersFindMany.mockResolvedValue([{
      id: workerId,
      status: 'running',
      currentAction: 'Creating migration file',
      turns: 3,
      prUrl: null,
      prNumber: null,
      commitCount: 2,
      filesChanged: 3,
      costUsd: 0.012,
      startedAt: new Date().toISOString(),
      completedAt: null,
      waitingFor: null,
      branch: 'buildd/b5814ed6-feat-connectors-db-schema',
      milestones: [{ type: 'checkpoint', event: 'first_edit', label: 'Edit', ts: 1 }],
    }]);

    const res = await callGET(taskId);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.id).toBe(taskId);
    expect(data.status).toBe('running');
    expect(data.worker?.id).toBe(workerId);
    expect(data.worker?.status).toBe('running');
    // Summary must return task ID, not worker ID — the historical 404 cause
    expect(data.id).not.toBe(workerId);
    // Milestones flow through so the panel can render the live activity timeline
    expect(data.worker?.milestones?.[0]?.event).toBe('first_edit');
  });

  it('returns task summary for a completed task', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-done',
      title: 'Completed task',
      status: 'completed',
      description: 'A finished task',
      mode: null,
      roleSlug: null,
      createdAt: new Date().toISOString(),
      missionId: null,
      workspaceId: 'ws-1',
      result: { summary: 'All done.', nextSuggestion: 'Consider X.' },
    });
    mockWorkersFindMany.mockResolvedValue([{
      id: 'worker-1',
      status: 'completed',
      currentAction: null,
      turns: 10,
      prUrl: 'https://github.com/org/repo/pull/42',
      prNumber: 42,
      commitCount: 5,
      filesChanged: 8,
      costUsd: 0.05,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      waitingFor: null,
      branch: 'buildd/task-done',
    }]);

    const res = await callGET('task-done');
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe('completed');
    expect(data.result?.summary).toBe('All done.');
    expect(data.worker?.prUrl).toBe('https://github.com/org/repo/pull/42');
  });

  it('returns task summary for a pending task with no worker', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-pending',
      title: 'Pending task',
      status: 'pending',
      description: null,
      mode: null,
      roleSlug: null,
      createdAt: new Date().toISOString(),
      missionId: null,
      workspaceId: 'ws-1',
      result: null,
    });
    mockWorkersFindMany.mockResolvedValue([]);

    const res = await callGET('task-pending');
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe('pending');
    expect(data.worker).toBeNull();
    expect(data.result).toBeNull();
  });

  it('passes costUsd as a string when Drizzle returns a decimal string (regression: TaskPanel crash)', async () => {
    // Drizzle returns decimal columns as strings (e.g. "0.050000"), not numbers.
    // The API must forward this value as-is so consumers can coerce safely.
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-cost',
      title: 'Cost test task',
      status: 'completed',
      description: null,
      mode: null,
      roleSlug: null,
      createdAt: new Date().toISOString(),
      missionId: null,
      workspaceId: 'ws-1',
      result: null,
    });
    mockWorkersFindMany.mockResolvedValue([{
      id: 'worker-cost',
      status: 'completed',
      currentAction: null,
      turns: 5,
      prUrl: null,
      prNumber: null,
      commitCount: 0,
      filesChanged: 0,
      costUsd: '0.050000',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      waitingFor: null,
      branch: null,
    }]);

    const res = await callGET('task-cost');
    expect(res.status).toBe(200);

    const data = await res.json();
    // costUsd must be the string as returned by Drizzle — consumers must coerce with Number()
    expect(data.worker?.costUsd).toBe('0.050000');
    // Verify Number() coercion works correctly (what TaskPanel.tsx does)
    expect(Number(data.worker?.costUsd).toFixed(3)).toBe('0.050');
  });

  it('surfaces PR lifecycle + diff stats so the panel can render CI state without a GitHub read', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-pr',
      title: 'PR task',
      status: 'completed',
      description: null,
      mode: null,
      roleSlug: null,
      createdAt: new Date().toISOString(),
      missionId: null,
      workspaceId: 'ws-1',
      result: null,
    });
    mockWorkersFindMany.mockResolvedValue([{
      id: 'worker-pr',
      status: 'completed',
      currentAction: null,
      turns: 4,
      prUrl: 'https://github.com/org/repo/pull/1263',
      prNumber: 1263,
      prLifecycleStatus: 'ci_running',
      mergedAt: null,
      commitCount: 3,
      filesChanged: 5,
      linesAdded: 120,
      linesRemoved: 8,
      costUsd: 0.03,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      waitingFor: null,
      branch: 'buildd/task-pr',
    }]);

    const res = await callGET('task-pr');
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.worker?.prLifecycleStatus).toBe('ci_running');
    expect(data.worker?.linesAdded).toBe(120);
    expect(data.worker?.linesRemoved).toBe(8);
    expect(data.worker?.mergedAt).toBeNull();
  });

  it('returns the task backend and null failover for a normal claude task', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-claude',
      title: 'Claude task',
      status: 'running',
      description: null,
      mode: null,
      roleSlug: null,
      createdAt: new Date().toISOString(),
      missionId: null,
      workspaceId: 'ws-1',
      result: null,
      backend: 'claude',
      context: null,
    });
    mockWorkersFindMany.mockResolvedValue([]);

    const res = await callGET('task-claude');
    const data = await res.json();
    expect(data.backend).toBe('claude');
    expect(data.failover).toBeNull();
  });

  it('surfaces failover metadata when a task was flipped to codex', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-failover',
      title: 'Failed-over task',
      status: 'pending',
      description: null,
      mode: null,
      roleSlug: null,
      createdAt: new Date().toISOString(),
      missionId: null,
      workspaceId: 'ws-1',
      result: null,
      backend: 'codex',
      context: { failedOverFrom: 'claude', failoverReason: 'budget_exhausted', budgetExhausted: true },
    });
    mockWorkersFindMany.mockResolvedValue([]);

    const res = await callGET('task-failover');
    const data = await res.json();
    expect(data.backend).toBe('codex');
    expect(data.failover?.from).toBe('claude');
    expect(data.failover?.reason).toBe('budget_exhausted');
  });

  it('surfaces the latest error excerpt for a failed task', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-failed',
      title: 'Failed task',
      status: 'failed',
      description: null,
      mode: null,
      roleSlug: null,
      createdAt: new Date().toISOString(),
      missionId: null,
      workspaceId: 'ws-1',
      result: null,
    });
    mockWorkersFindMany.mockResolvedValue([]);
    mockErrorTracesFindMany.mockResolvedValue([{
      excerpt: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.',
      pattern: 'auth_error',
      ts: new Date().toISOString(),
    }]);

    const res = await callGET('task-failed');
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe('failed');
    expect(data.lastError?.excerpt).toContain('401 OAuth access token is invalid');
    expect(data.lastError?.pattern).toBe('auth_error');
  });

  it('returns null lastError when the task has no error traces', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-clean',
      title: 'Clean task',
      status: 'completed',
      description: null,
      mode: null,
      roleSlug: null,
      createdAt: new Date().toISOString(),
      missionId: null,
      workspaceId: 'ws-1',
      result: null,
    });
    mockWorkersFindMany.mockResolvedValue([]);

    const res = await callGET('task-clean');
    const data = await res.json();
    expect(data.lastError).toBeNull();
  });

  it('surfaces waiting_input status when worker is blocked', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-waiting',
      title: 'Waiting task',
      status: 'running',
      description: null,
      mode: null,
      roleSlug: null,
      createdAt: new Date().toISOString(),
      missionId: null,
      workspaceId: 'ws-1',
      result: null,
    });
    mockWorkersFindMany.mockResolvedValue([{
      id: 'worker-waiting',
      status: 'waiting_input',
      currentAction: null,
      turns: 5,
      prUrl: null,
      prNumber: null,
      commitCount: 0,
      filesChanged: 0,
      costUsd: 0.01,
      startedAt: new Date().toISOString(),
      completedAt: null,
      waitingFor: { type: 'text', prompt: 'Which approach do you prefer?' },
      branch: 'buildd/task-waiting',
    }]);

    const res = await callGET('task-waiting');
    expect(res.status).toBe(200);

    const data = await res.json();
    // Derived status: task is "running" but worker is "waiting_input"
    expect(data.status).toBe('waiting_input');
    expect(data.worker?.waitingFor?.prompt).toBe('Which approach do you prefer?');
  });
});
