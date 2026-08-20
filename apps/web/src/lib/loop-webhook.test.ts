import { describe, it, expect, mock, beforeEach } from 'bun:test';

// --- Mocks ---

// Captured DB mutation calls for assertions
let capturedTaskUpdate: any = null;
// Controls the return value for .returning() — override per-test for race simulation
let returningResult: any[] = [{ id: 'task-1' }];

const mockTasksFindFirst = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);

const mockTasksUpdateSet = mock((vals: any) => {
  capturedTaskUpdate = vals;
  return {
    where: mock(() => ({
      returning: mock(() => Promise.resolve(returningResult)),
    })),
  };
});
const mockTasksUpdate = mock(() => ({ set: mockTasksUpdateSet }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTasksFindFirst },
      workers: { findFirst: mockWorkersFindFirst },
    },
    update: () => mockTasksUpdate(),
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: 'tasks',
  workers: 'workers',
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
}));

mock.module('@/lib/pusher', () => ({
  triggerEvent: mock(() => Promise.resolve()),
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { WORKER_PROGRESS: 'worker:progress' },
}));

const mockResolveCompletedTask = mock(() => Promise.resolve());
mock.module('@/lib/task-dependencies', () => ({
  resolveCompletedTask: mockResolveCompletedTask,
}));

mock.module('@buildd/core/loop-config', () => ({
  LOOP_MAX_LOOPS_DEFAULT: 5,
  LOOP_BACKOFF_MINUTES_DEFAULT: 0,
}));

mock.module('@/lib/deferred-start', () => ({
  laterStartAt: (a: Date | null, b: Date | null) => a ?? b,
}));

import { evaluateAndAdvanceLoopOnMerge } from './loop-webhook';

const PR_MERGED_LOOP_CONFIG = {
  exitCondition: { type: 'pr_merged' },
  maxLoops: 6,
  waitExpiryMinutes: 240,
};

describe('evaluateAndAdvanceLoopOnMerge', () => {
  beforeEach(() => {
    capturedTaskUpdate = null;
    returningResult = [{ id: 'task-1' }];
    mockTasksFindFirst.mockReset();
    mockWorkersFindFirst.mockReset();
    mockTasksUpdate.mockReset();
    mockTasksUpdateSet.mockReset();
    mockResolveCompletedTask.mockReset();
    mockTasksUpdate.mockReturnValue({ set: mockTasksUpdateSet });
    mockTasksUpdateSet.mockImplementation((vals: any) => {
      capturedTaskUpdate = vals;
      return {
        where: mock(() => ({
          returning: mock(() => Promise.resolve(returningResult)),
        })),
      };
    });
  });

  it('returns false when task does not exist', async () => {
    mockTasksFindFirst.mockResolvedValue(null);
    const result = await evaluateAndAdvanceLoopOnMerge('w1', 'task-1', 'ws-1');
    expect(result).toBe(false);
  });

  it('returns false when task loopState is not condition_unmet', async () => {
    mockTasksFindFirst.mockResolvedValue({
      loopConfig: PR_MERGED_LOOP_CONFIG,
      loopIteration: 1,
      loopState: 'satisfied',
      context: {},
      startAt: null,
      status: 'completed',
    });
    const result = await evaluateAndAdvanceLoopOnMerge('w1', 'task-1', 'ws-1');
    expect(result).toBe(false);
  });

  it('returns false when loopConfig exitCondition is not pr_merged', async () => {
    mockTasksFindFirst.mockResolvedValue({
      loopConfig: { exitCondition: { type: 'pr_checks_green' }, maxLoops: 3 },
      loopIteration: 0,
      loopState: 'condition_unmet',
      context: {},
      startAt: null,
      status: 'pending',
    });
    const result = await evaluateAndAdvanceLoopOnMerge('w1', 'task-1', 'ws-1');
    expect(result).toBe(false);
  });

  it('returns false when worker has no mergedAt', async () => {
    mockTasksFindFirst.mockResolvedValue({
      loopConfig: PR_MERGED_LOOP_CONFIG,
      loopIteration: 0,
      loopState: 'condition_unmet',
      context: {},
      startAt: null,
      status: 'pending',
    });
    mockWorkersFindFirst.mockResolvedValue({
      mergedAt: null,
      prNumber: 42,
      branch: 'buildd/feat',
      lastCommitSha: 'abc',
    });
    const result = await evaluateAndAdvanceLoopOnMerge('w1', 'task-1', 'ws-1');
    expect(result).toBe(false);
  });

  it('advances loop to satisfied and completes the task when PR is merged', async () => {
    mockTasksFindFirst.mockResolvedValue({
      loopConfig: PR_MERGED_LOOP_CONFIG,
      loopIteration: 0,
      loopState: 'condition_unmet',
      context: { loopHistory: [] },
      startAt: null,
      status: 'pending',
    });
    mockWorkersFindFirst.mockResolvedValue({
      mergedAt: new Date(),
      prNumber: 1721,
      branch: 'buildd/feat',
      lastCommitSha: 'deadbeef',
    });

    const result = await evaluateAndAdvanceLoopOnMerge('w1', 'task-1', 'ws-1');

    expect(result).toBe(true);
    expect(capturedTaskUpdate).not.toBeNull();
    expect(capturedTaskUpdate.status).toBe('completed');
    expect(capturedTaskUpdate.loopState).toBe('satisfied');
    expect(capturedTaskUpdate.result.summary).toContain('1721');
    expect(capturedTaskUpdate.result.summary).toContain('merged');
    expect(mockResolveCompletedTask).toHaveBeenCalledWith('task-1', 'ws-1');
  });

  it('returns false when the atomic WHERE guard prevents double-fire', async () => {
    // Simulate another concurrent call already advanced the loop (returns empty [])
    mockTasksFindFirst.mockResolvedValue({
      loopConfig: PR_MERGED_LOOP_CONFIG,
      loopIteration: 0,
      loopState: 'condition_unmet',
      context: {},
      startAt: null,
      status: 'pending',
    });
    mockWorkersFindFirst.mockResolvedValue({
      mergedAt: new Date(),
      prNumber: 99,
      branch: 'buildd/feat',
      lastCommitSha: 'abc',
    });

    // Simulate concurrent update returning empty array (another caller won the race)
    returningResult = [];

    const result = await evaluateAndAdvanceLoopOnMerge('w1', 'task-1', 'ws-1');
    expect(result).toBe(false);
    expect(mockResolveCompletedTask).not.toHaveBeenCalled();
  });
});
