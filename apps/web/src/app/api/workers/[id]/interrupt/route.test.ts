import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockWorkersUpdate = mock();
const mockTasksUpdate = mock();
const mockInsert = mock();
const mockWorkersFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockTriggerEvent = mock(() => Promise.resolve());
const mockResolveCompletedTask = mock(() => Promise.resolve());

// Set up the update chain mock
function makeUpdateChain() {
  const whereMock = mock(() => Promise.resolve());
  const setMock = mock(() => ({ where: whereMock }));
  return { set: setMock, _where: whereMock };
}

function makeReturningUpdateChain(rows: unknown[]) {
  const returningMock = mock(() => Promise.resolve(rows));
  const whereMock = mock(() => ({ returning: returningMock }));
  const setMock = mock(() => ({ where: whereMock }));
  return { set: setMock, _where: whereMock, _returning: returningMock };
}

let workersUpdateChain = makeUpdateChain();
let tasksUpdateChain = makeUpdateChain();

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findFirst: mockWorkersFindFirst },
      tasks: { findFirst: mockTasksFindFirst },
    },
    update: (table: any) => {
      if (table === 'workers_table') return workersUpdateChain;
      return tasksUpdateChain;
    },
    insert: () => ({
      values: mock(() => Promise.resolve()),
    }),
  },
}));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/team-access', () => ({
  getUserWorkspaceIds: mockGetUserWorkspaceIds,
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: {
    workspace: (id: string) => `workspace:${id}`,
    worker: (id: string) => `worker:${id}`,
  },
  events: {
    WORKER_FAILED: 'worker:failed',
    WORKER_COMMAND: 'worker:command',
  },
}));

mock.module('@/lib/task-dependencies', () => ({
  resolveCompletedTask: mockResolveCompletedTask,
  checkDependsOnResolved: mock(() => Promise.resolve()),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers_table',
  tasks: 'tasks_table',
  missionNotes: 'mission_notes_table',
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  inArray: (a: any, b: any) => ({ type: 'inArray', a, b }),
}));

import { POST } from './route';

function makeRequest(workerId = 'w-reviewer-1') {
  return new NextRequest(`http://localhost/api/workers/${workerId}/interrupt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

describe('POST /api/workers/[id]/interrupt', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockWorkersFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockTriggerEvent.mockReset();
    mockTriggerEvent.mockResolvedValue(undefined);
    mockResolveCompletedTask.mockReset();
    mockResolveCompletedTask.mockResolvedValue(undefined);
    workersUpdateChain = makeUpdateChain();
    tasksUpdateChain = makeUpdateChain();
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'w-reviewer-1' }) });
    expect(res.status).toBe(401);
  });

  it('rejects form posts that can be submitted cross-site', async () => {
    const request = new NextRequest('http://localhost/api/workers/w-reviewer-1/interrupt', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    });

    const res = await POST(request, { params: Promise.resolve({ id: 'w-reviewer-1' }) });

    expect(res.status).toBe(415);
    expect(mockGetCurrentUser).not.toHaveBeenCalled();
  });

  it('returns 404 when worker not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindFirst.mockResolvedValue(null);
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'w-reviewer-1' }) });
    expect(res.status).toBe(404);
  });

  it('returns 403 when user lacks access to workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-other']);
    mockWorkersFindFirst.mockResolvedValue({ id: 'w-reviewer-1', workspaceId: 'ws-1', taskId: 't-rev-1', status: 'running' });
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'w-reviewer-1' }) });
    expect(res.status).toBe(403);
  });

  it('returns 400 when worker task is not a reviewer task', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindFirst.mockResolvedValue({ id: 'w-1', workspaceId: 'ws-1', taskId: 't-1', status: 'running' });
    mockTasksFindFirst.mockResolvedValue({ id: 't-1', category: 'feature', context: {} });
    const res = await POST(makeRequest('w-1'), { params: Promise.resolve({ id: 'w-1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 409 when reviewer worker is already terminal', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindFirst.mockResolvedValue({ id: 'w-reviewer-1', workspaceId: 'ws-1', taskId: 't-rev-1', status: 'completed' });
    mockTasksFindFirst.mockResolvedValue({
      id: 't-rev-1',
      category: 'review',
      context: { reviewerFor: 't-1', prNumber: 42 },
    });
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'w-reviewer-1' }) });
    expect(res.status).toBe(409);
  });

  it('terminates a live reviewer worker and returns ok', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-reviewer-1',
      workspaceId: 'ws-1',
      taskId: 't-rev-1',
      status: 'running',
    });
    mockTasksFindFirst
      .mockResolvedValueOnce({
        id: 't-rev-1',
        category: 'review',
        context: { reviewerFor: 't-original', prNumber: 42 },
      })
      .mockResolvedValueOnce({
        id: 't-original',
        missionId: 'mission-1',
      });

    // Patch update chain
    const db = (await import('@buildd/core/db')).db;
    (db.update as any) = (table: any) => {
      if (table === 'workers_table') {
        return makeReturningUpdateChain([{ id: 'w-reviewer-1' }]);
      }
      return { set: mock(() => ({ where: mock(() => Promise.resolve()) })) };
    };
    (db.insert as any) = () => ({ values: mock(() => Promise.resolve()) });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'w-reviewer-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockResolveCompletedTask).toHaveBeenCalledWith('t-rev-1', 'ws-1');
  });

  it('fires Pusher abort to worker channel when cancelQueued=true', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-reviewer-1',
      workspaceId: 'ws-1',
      taskId: 't-rev-1',
      status: 'running',
    });
    mockTasksFindFirst
      .mockResolvedValueOnce({
        id: 't-rev-1',
        category: 'review',
        context: { reviewerFor: 't-original', prNumber: 42 },
      })
      .mockResolvedValueOnce({ id: 't-original', missionId: null });

    const db = (await import('@buildd/core/db')).db;
    (db.update as any) = (table: any) => {
      if (table === 'workers_table') return makeReturningUpdateChain([{ id: 'w-reviewer-1' }]);
      return { set: mock(() => ({ where: mock(() => Promise.resolve()) })) };
    };
    (db.insert as any) = () => ({ values: mock(() => Promise.resolve()) });

    const request = new NextRequest('http://localhost/api/workers/w-reviewer-1/interrupt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cancelQueued: true }),
    });

    const res = await POST(request, { params: Promise.resolve({ id: 'w-reviewer-1' }) });
    expect(res.status).toBe(200);

    // triggerEvent is called twice: once for the worker channel (cancelQueued),
    // once for the workspace channel (WORKER_FAILED).
    const calls = mockTriggerEvent.mock.calls;
    const workerChannelCall = calls.find((c: any[]) => c[0] === 'worker:w-reviewer-1');
    expect(workerChannelCall).toBeDefined();
    expect(workerChannelCall![1]).toBe('worker:command');
    expect(workerChannelCall![2]).toMatchObject({ action: 'abort', cancelQueued: true });
  });

  it('does NOT fire worker channel Pusher event when cancelQueued is absent', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-reviewer-1',
      workspaceId: 'ws-1',
      taskId: 't-rev-1',
      status: 'running',
    });
    mockTasksFindFirst
      .mockResolvedValueOnce({
        id: 't-rev-1',
        category: 'review',
        context: { reviewerFor: 't-original', prNumber: 42 },
      })
      .mockResolvedValueOnce({ id: 't-original', missionId: null });

    const db = (await import('@buildd/core/db')).db;
    (db.update as any) = (table: any) => {
      if (table === 'workers_table') return makeReturningUpdateChain([{ id: 'w-reviewer-1' }]);
      return { set: mock(() => ({ where: mock(() => Promise.resolve()) })) };
    };
    (db.insert as any) = () => ({ values: mock(() => Promise.resolve()) });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'w-reviewer-1' }) });
    expect(res.status).toBe(200);

    // Only the workspace WORKER_FAILED event fires — no worker channel event.
    const calls = mockTriggerEvent.mock.calls;
    const workerChannelCall = calls.find((c: any[]) => c[0] === 'worker:w-reviewer-1');
    expect(workerChannelCall).toBeUndefined();
  });

  it('returns 409 without promotion when completion wins after the live-status read', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindFirst.mockResolvedValue({
      id: 'w-reviewer-1',
      workspaceId: 'ws-1',
      taskId: 't-rev-1',
      status: 'running',
    });
    mockTasksFindFirst.mockResolvedValue({
      id: 't-rev-1',
      category: 'review',
      context: { reviewerFor: 't-original', prNumber: 42 },
    });

    const db = (await import('@buildd/core/db')).db;
    const taskUpdate = mock();
    const insertValues = mock();
    (db.update as any) = (table: any) => {
      if (table === 'workers_table') return makeReturningUpdateChain([]);
      taskUpdate();
      return { set: mock(() => ({ where: mock(() => Promise.resolve()) })) };
    };
    (db.insert as any) = () => ({ values: insertValues });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'w-reviewer-1' }) });

    expect(res.status).toBe(409);
    expect(taskUpdate).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(mockResolveCompletedTask).not.toHaveBeenCalled();
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });
});
