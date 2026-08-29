import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ─── DB mocks ─────────────────────────────────────────────────────────────────

const mockTasksFindMany = mock(() => [] as any[]);
const mockWorkersFindMany = mock(() => [] as any[]);
const mockTasksUpdate = mock(() => ({
  set: mock(() => ({ where: mock(() => Promise.resolve()) })),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findMany: mockTasksFindMany },
      workers: { findMany: mockWorkersFindMany },
    },
    update: () => mockTasksUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => ({ args, op: 'and' }),
  or: (...args: any[]) => ({ args, op: 'or' }),
  isNull: (a: any) => ({ a, op: 'isNull' }),
  isNotNull: (a: any) => ({ a, op: 'isNotNull' }),
  inArray: (a: any, b: any) => ({ a, b, op: 'inArray' }),
  ne: (a: any, b: any) => ({ a, b, op: 'ne' }),
  not: (a: any) => ({ a, op: 'not' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: {
    id: 'id',
    workspaceId: 'workspaceId',
    subjectPrNumber: 'subjectPrNumber',
    subjectKind: 'subjectKind',
    subjectResolution: 'subjectResolution',
    status: 'status',
    parentTaskId: 'parentTaskId',
    updatedAt: 'updatedAt',
  },
  workers: {
    taskId: 'taskId',
    prNumber: 'prNumber',
    prLifecycleStatus: 'prLifecycleStatus',
  },
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { sweepSubjectAnchoredTasks } from './subject-sweep';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<{
  id: string;
  status: string;
  parentTaskId: string | null;
  subjectResolution: string | null;
}> = {}) {
  return {
    id: 'task-1',
    status: 'pending',
    parentTaskId: null,
    subjectResolution: null,
    ...overrides,
  };
}

function makeWorker(overrides: Partial<{
  taskId: string;
  prNumber: number | null;
  prLifecycleStatus: string | null;
}> = {}) {
  return {
    taskId: 'task-1',
    prNumber: 42,
    prLifecycleStatus: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('sweepSubjectAnchoredTasks', () => {
  beforeEach(() => {
    mockTasksFindMany.mockReset();
    mockWorkersFindMany.mockReset();
    mockTasksUpdate.mockReset();
  });

  it('returns zeros when no anchored tasks found', async () => {
    mockTasksFindMany.mockResolvedValue([]);
    const result = await sweepSubjectAnchoredTasks('ws-1', 42);
    expect(result).toEqual({ anchored: 0, reconciled: 0 });
    expect(mockWorkersFindMany).not.toHaveBeenCalled();
  });

  it('cancels pending tasks when PR has no live worker PRs', async () => {
    // Anchored task is pending with no open PR — must be CANCELLED so it falls
    // out of the claim queue and mission-completion count (not just reconciled).
    mockTasksFindMany.mockResolvedValueOnce([makeTask({ id: 'task-1', status: 'pending' })]);
    // Workers check returns no workers (no live successor)
    mockWorkersFindMany.mockResolvedValue([]);

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockTasksUpdate.mockReturnValue({ set: setMock });

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.anchored).toBeGreaterThan(0);
    expect(result.reconciled).toBe(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ subjectResolution: 'reconciled', status: 'cancelled' }),
    );
  });

  it('cancels a budget-deferred pending task when its PR dies', async () => {
    // The "stranded nine" scenario: CI-retry task was deferred (pending with
    // a future startAt) after hitting session limit. Its PR was later merged.
    // The sweep must cancel it — leaving it pending makes it permanently
    // invisible to the claim route (SQL pre-filter) while blocking queue counts.
    const deferredTask = makeTask({ id: 'deferred-1', status: 'pending', subjectResolution: null });
    mockTasksFindMany.mockResolvedValueOnce([deferredTask]);
    mockWorkersFindMany.mockResolvedValue([
      makeWorker({ taskId: 'deferred-1', prLifecycleStatus: 'merged' }),
    ]);

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockTasksUpdate.mockReturnValue({ set: setMock });

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ subjectResolution: 'reconciled', status: 'cancelled' }),
    );
  });

  it('cancels assigned tasks when PR is dead', async () => {
    mockTasksFindMany.mockResolvedValueOnce([makeTask({ id: 'task-2', status: 'assigned' })]);
    mockWorkersFindMany.mockResolvedValue([]);

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockTasksUpdate.mockReturnValue({ set: setMock });

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ subjectResolution: 'reconciled', status: 'cancelled' }),
    );
  });

  it('does NOT reconcile when a retry-chain worker has a live PR', async () => {
    mockTasksFindMany.mockResolvedValueOnce([makeTask({ id: 'task-1', status: 'pending' })]);
    // A worker in the chain has a live (pr_open) PR
    mockWorkersFindMany.mockResolvedValue([
      makeWorker({ taskId: 'task-1', prLifecycleStatus: 'pr_open' }),
    ]);

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(0);
    expect(mockTasksUpdate).not.toHaveBeenCalled();
  });

  it('does NOT reconcile when worker PR is in ci_running state (live)', async () => {
    mockTasksFindMany.mockResolvedValueOnce([makeTask({ id: 'task-1', status: 'pending' })]);
    mockWorkersFindMany.mockResolvedValue([
      makeWorker({ taskId: 'task-1', prLifecycleStatus: 'ci_running' }),
    ]);

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(0);
    expect(mockTasksUpdate).not.toHaveBeenCalled();
  });

  it('cancels when only closed/merged workers exist in the chain', async () => {
    mockTasksFindMany.mockResolvedValueOnce([makeTask({ id: 'task-1', status: 'pending' })]);
    mockWorkersFindMany.mockResolvedValue([
      makeWorker({ taskId: 'task-1', prLifecycleStatus: 'closed' }),
    ]);

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockTasksUpdate.mockReturnValue({ set: setMock });

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  it('cancels when worker PR is merged', async () => {
    mockTasksFindMany.mockResolvedValueOnce([makeTask({ id: 'task-1', status: 'pending' })]);
    mockWorkersFindMany.mockResolvedValue([
      makeWorker({ taskId: 'task-1', prLifecycleStatus: 'merged' }),
    ]);

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockTasksUpdate.mockReturnValue({ set: setMock });

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  it('does NOT update completed tasks', async () => {
    mockTasksFindMany.mockResolvedValueOnce([
      makeTask({ id: 'task-1', status: 'completed' }),
    ]);
    mockWorkersFindMany.mockResolvedValue([]);

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(0);
    expect(mockTasksUpdate).not.toHaveBeenCalled();
  });

  it('does NOT update failed tasks', async () => {
    mockTasksFindMany.mockResolvedValueOnce([
      makeTask({ id: 'task-1', status: 'failed' }),
    ]);
    mockWorkersFindMany.mockResolvedValue([]);

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(0);
    expect(mockTasksUpdate).not.toHaveBeenCalled();
  });

  it('is idempotent — already-reconciled tasks are not re-updated', async () => {
    mockTasksFindMany.mockResolvedValueOnce([
      makeTask({ id: 'task-1', status: 'pending', subjectResolution: 'reconciled' }),
    ]);
    mockWorkersFindMany.mockResolvedValue([]);

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.reconciled).toBe(0);
    expect(mockTasksUpdate).not.toHaveBeenCalled();
  });

  it('sweeps retry-chain members connected by parentTaskId', async () => {
    // task-1 is the anchored task, task-2 is a retry (has parentTaskId = task-1's parent)
    // Both should be in the sweep
    mockTasksFindMany
      // First call: anchored tasks
      .mockResolvedValueOnce([
        makeTask({ id: 'task-1', status: 'pending', parentTaskId: 'task-parent' }),
      ])
      // Second call: parent tasks
      .mockResolvedValueOnce([{ id: 'task-parent', status: 'failed' }])
      // Third call: siblings
      .mockResolvedValueOnce([
        makeTask({ id: 'task-1', status: 'pending', parentTaskId: 'task-parent' }),
        makeTask({ id: 'task-2', status: 'pending', parentTaskId: 'task-parent' }),
      ]);
    // Workers check for all chain tasks
    mockWorkersFindMany.mockResolvedValue([]);

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockTasksUpdate.mockReturnValue({ set: setMock });

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    // Exactly the directly-anchored task (task-1) is reconciled; siblings are
    // not in the anchored set and are not touched by the sweep.
    expect(result.reconciled).toBe(1);
  });

  it('handles multiple anchored tasks, reconciling only pending/assigned ones', async () => {
    mockTasksFindMany.mockResolvedValueOnce([
      makeTask({ id: 'task-1', status: 'pending' }),
      makeTask({ id: 'task-2', status: 'completed' }),
      makeTask({ id: 'task-3', status: 'assigned' }),
    ]);
    mockWorkersFindMany.mockResolvedValue([]);

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockTasksUpdate.mockReturnValue({ set: setMock });

    const result = await sweepSubjectAnchoredTasks('ws-1', 42);

    expect(result.anchored).toBeGreaterThan(0);
    expect(result.reconciled).toBe(2); // task-1 (pending) + task-3 (assigned)
  });
});
