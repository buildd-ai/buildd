import { describe, it, expect, beforeEach, mock } from 'bun:test';

// --- Mocks ---
const mockWorkersFindMany = mock(() => [] as any[]);
const mockTasksFindFirst = mock(() => null as any);
const mockTasksFindMany = mock(() => [] as any[]);
const mockWorkersUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockTasksUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));
const mockTasksInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() => [{ id: 'new-task-id' }]),
  })),
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      tasks: { findFirst: mockTasksFindFirst, findMany: mockTasksFindMany },
      missions: { findFirst: mock(() => null) },
      workerHeartbeats: { findFirst: mock(() => ({ id: 'hb-1' })) },
    },
    update: (table: any) => {
      if (table === 'workers') return mockWorkersUpdate();
      return mockTasksUpdate();
    },
    insert: () => mockTasksInsert(),
    // resolveCompletedTask (called internally) uses db.select().from().where()
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
  },
}));

// Mock pusher so resolveCompletedTask (called at end of cleanup) is a no-op
mock.module('@/lib/pusher', () => ({
  triggerEvent: mock(() => Promise.resolve()),
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { CHILDREN_COMPLETED: 'task:children_completed', TASK_UNBLOCKED: 'task:unblocked' },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...args: any[]) => ({ args, type: 'and' }),
  or: (...args: any[]) => ({ args, type: 'or' }),
  lt: (field: any, value: any) => ({ field, value, type: 'lt' }),
  gt: (field: any, value: any) => ({ field, value, type: 'gt' }),
  not: (expr: any) => ({ expr, type: 'not' }),
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers',
  tasks: 'tasks',
  workerHeartbeats: { accountId: 'accountId', lastHeartbeatAt: 'lastHeartbeatAt' },
}));

const mockGetWorkerArtifactCount = mock(() => Promise.resolve(0));
const mockCheckWorkerDeliverables = mock(() => ({
  hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none',
}));
mock.module('@/lib/worker-deliverables', () => ({
  checkWorkerDeliverables: mockCheckWorkerDeliverables,
  getWorkerArtifactCount: mockGetWorkerArtifactCount,
}));

import { cleanupStaleWorkers, cleanupStuckWaitingInput } from './stale-workers';

describe('cleanupStuckWaitingInput', () => {
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockTasksInsert.mockReset();
    // Default chains
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
    mockTasksInsert.mockReturnValue({
      values: mock(() => ({
        returning: mock(() => [{ id: 'new-task-id' }]),
      })),
    });
  });

  it('does nothing when no stuck waiting_input workers exist', async () => {
    mockWorkersFindMany.mockResolvedValue([]);

    const result = await cleanupStuckWaitingInput();
    expect(result.failedWorkers).toBe(0);
    expect(result.retriedTasks).toBe(0);
  });

  it('fails workers stuck in waiting_input for 24+ hours', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate, waitingFor: { type: 'question', prompt: 'What color?' } },
    ]);

    mockTasksFindFirst.mockResolvedValue({
      id: 'task-1',
      workspaceId: 'ws-1',
      title: 'Fix the bug',
      description: 'Fix the login bug',
      priority: 0,
      category: 'bug',
      project: 'web',
      context: {},
      requiredCapabilities: [],
      missionId: null,
      runnerPreference: 'any',
      mode: 'execution',
      outputRequirement: 'auto',
      outputSchema: null,
    });

    const result = await cleanupStuckWaitingInput();

    expect(result.failedWorkers).toBe(1);
    expect(result.retriedTasks).toBe(1);
  });

  it('does not touch waiting_input workers under 24 hours old', async () => {
    const recentDate = new Date(Date.now() - 12 * 60 * 60 * 1000); // 12 hours ago
    mockWorkersFindMany.mockResolvedValue([]); // Query with lt(24h) returns nothing

    const result = await cleanupStuckWaitingInput();
    expect(result.failedWorkers).toBe(0);
    expect(result.retriedTasks).toBe(0);
  });

  it('creates retry task with no-input instruction appended to description', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate, waitingFor: { type: 'question', prompt: 'Need clarification' } },
    ]);

    mockTasksFindFirst.mockResolvedValue({
      id: 'task-1',
      workspaceId: 'ws-1',
      title: 'Fix the bug',
      description: 'Fix the login bug',
      priority: 0,
      category: 'bug',
      project: 'web',
      context: {},
      requiredCapabilities: [],
      missionId: null,
      runnerPreference: 'any',
      mode: 'execution',
      outputRequirement: 'auto',
      outputSchema: null,
    });

    let capturedValues: any = null;
    mockTasksInsert.mockReturnValue({
      values: mock((vals: any) => {
        capturedValues = vals;
        return { returning: mock(() => [{ id: 'new-task-id' }]) };
      }),
    });

    await cleanupStuckWaitingInput();

    expect(capturedValues).not.toBeNull();
    expect(capturedValues.title).toBe('Fix the bug');
    expect(capturedValues.description).toContain('Fix the login bug');
    expect(capturedValues.description).toContain('IMPORTANT: Do NOT ask for user input');
    expect(capturedValues.workspaceId).toBe('ws-1');
  });

  it('fails the original task when creating retry', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate, waitingFor: { type: 'question', prompt: 'Need input' } },
    ]);

    mockTasksFindFirst.mockResolvedValue({
      id: 'task-1',
      workspaceId: 'ws-1',
      title: 'Build feature',
      description: 'Build the feature',
      priority: 5,
      category: 'feature',
      project: null,
      context: { key: 'value' },
      requiredCapabilities: ['docker'],
      missionId: 'obj-1',
      runnerPreference: 'any',
      mode: 'execution',
      outputRequirement: 'pr_required',
      outputSchema: null,
    });

    let taskUpdateSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdateSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStuckWaitingInput();

    expect(taskUpdateSet).not.toBeNull();
    expect(taskUpdateSet.status).toBe('failed');
  });

  it('handles multiple stuck workers across different tasks', async () => {
    const staleDate = new Date(Date.now() - 30 * 60 * 60 * 1000);
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate, waitingFor: { type: 'question', prompt: 'Q1' } },
      { id: 'w2', taskId: 'task-2', status: 'waiting_input', updatedAt: staleDate, waitingFor: { type: 'question', prompt: 'Q2' } },
    ]);

    mockTasksFindFirst
      .mockResolvedValueOnce({
        id: 'task-1', workspaceId: 'ws-1', title: 'Task 1', description: 'Desc 1',
        priority: 0, category: null, project: null, context: {}, requiredCapabilities: [],
        missionId: null, runnerPreference: 'any', mode: 'execution', outputRequirement: 'auto', outputSchema: null,
      })
      // resolveCompletedTask calls findFirst internally (no parentTaskId → no-op)
      .mockResolvedValueOnce({ parentTaskId: null })
      .mockResolvedValueOnce({
        id: 'task-2', workspaceId: 'ws-1', title: 'Task 2', description: 'Desc 2',
        priority: 0, category: null, project: null, context: {}, requiredCapabilities: [],
        missionId: null, runnerPreference: 'any', mode: 'execution', outputRequirement: 'auto', outputSchema: null,
      })
      // resolveCompletedTask calls findFirst internally (no parentTaskId → no-op)
      .mockResolvedValueOnce({ parentTaskId: null });

    const result = await cleanupStuckWaitingInput();

    expect(result.failedWorkers).toBe(2);
    expect(result.retriedTasks).toBe(2);
  });

  it('cleans up mission tasks after 4 hours (shorter timeout)', async () => {
    // 5 hours ago — past the 4h mission threshold
    const staleDate = new Date(Date.now() - 5 * 60 * 60 * 1000);
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate,
        waitingFor: { type: 'question', prompt: 'Which approach?' },
        task: { missionId: 'mission-1' },
      },
    ]);

    mockTasksFindFirst.mockResolvedValue({
      id: 'task-1', workspaceId: 'ws-1', title: 'Mission Task', description: 'Part of a mission',
      priority: 0, category: null, project: null, context: {}, requiredCapabilities: [],
      missionId: 'mission-1', runnerPreference: 'any', mode: 'execution', outputRequirement: 'auto', outputSchema: null,
    });

    const result = await cleanupStuckWaitingInput();

    // Mission task at 5h should be cleaned up (past 4h threshold)
    expect(result.failedWorkers).toBe(1);
    expect(result.retriedTasks).toBe(1);
  });

  it('does not clean up standalone tasks before 24 hours', async () => {
    // 5 hours ago — past mission threshold but NOT past standalone threshold
    const staleDate = new Date(Date.now() - 5 * 60 * 60 * 1000);
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate,
        waitingFor: { type: 'question', prompt: 'Which approach?' },
        task: { missionId: null },  // standalone — no mission
      },
    ]);

    const result = await cleanupStuckWaitingInput();

    // Standalone task at 5h should NOT be cleaned up (needs 24h)
    expect(result.failedWorkers).toBe(0);
    expect(result.retriedTasks).toBe(0);
  });

  it('applies different timeouts for mixed mission and standalone tasks', async () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: fiveHoursAgo,
        waitingFor: { type: 'question', prompt: 'Mission question' },
        task: { missionId: 'mission-1' },  // mission — 4h timeout
      },
      {
        id: 'w2', taskId: 'task-2', status: 'waiting_input', updatedAt: fiveHoursAgo,
        waitingFor: { type: 'question', prompt: 'Standalone question' },
        task: { missionId: null },  // standalone — 24h timeout
      },
    ]);

    mockTasksFindFirst.mockResolvedValue({
      id: 'task-1', workspaceId: 'ws-1', title: 'Mission Task', description: 'Part of mission',
      priority: 0, category: null, project: null, context: {}, requiredCapabilities: [],
      missionId: 'mission-1', runnerPreference: 'any', mode: 'execution', outputRequirement: 'auto', outputSchema: null,
    });

    const result = await cleanupStuckWaitingInput();

    // Only the mission task (w1) should be cleaned up, not the standalone (w2)
    expect(result.failedWorkers).toBe(1);
    expect(result.retriedTasks).toBe(1);
  });

  it('includes previous waiting_for context in retry task description', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'w1', taskId: 'task-1', status: 'waiting_input', updatedAt: staleDate,
        waitingFor: { type: 'question', prompt: 'What database should I use?', options: ['PostgreSQL', 'MySQL'] },
      },
    ]);

    mockTasksFindFirst.mockResolvedValue({
      id: 'task-1', workspaceId: 'ws-1', title: 'Setup DB', description: 'Set up the database',
      priority: 0, category: null, project: null, context: {}, requiredCapabilities: [],
      missionId: null, runnerPreference: 'any', mode: 'execution', outputRequirement: 'auto', outputSchema: null,
    });

    let capturedValues: any = null;
    mockTasksInsert.mockReturnValue({
      values: mock((vals: any) => {
        capturedValues = vals;
        return { returning: mock(() => [{ id: 'new-task-id' }]) };
      }),
    });

    await cleanupStuckWaitingInput();

    expect(capturedValues.description).toContain('What database should I use?');
  });
});

describe('cleanupStaleWorkers — deliverable-aware cleanup', () => {
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockCheckWorkerDeliverables.mockReset();
    mockGetWorkerArtifactCount.mockReset();
    mockGetWorkerArtifactCount.mockResolvedValue(0);
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none',
    });
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
  });

  it('promotes task to completed when stale worker has deliverables (PR)', async () => {
    // Call 1: find stale workers
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'w1', taskId: 'task-1', prUrl: 'https://github.com/org/repo/pull/42', prNumber: 42, commitCount: 3 },
      ])
      // Call 2: other active workers for the task
      .mockResolvedValueOnce([])
      // Call 3: heartbeat orphans
      .mockResolvedValueOnce([]);

    // staleTasks query
    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    // Task lookup for dependency resolution
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', parentTaskId: null });

    // Worker has a PR
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: true, hasArtifacts: false, hasStructuredOutput: false, hasCommits: true, hasAny: true, details: 'PR #42, 3 commits',
    });

    let taskUpdateSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdateSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    // Task should be promoted to completed, NOT reset to pending
    expect(taskUpdateSet).not.toBeNull();
    expect(taskUpdateSet.status).toBe('completed');
  });

  it('promotes task to completed when stale worker has artifacts but no PR', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-1', prUrl: null, prNumber: null, commitCount: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', parentTaskId: null });

    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: true, hasStructuredOutput: false, hasCommits: false, hasAny: true, details: '2 artifacts',
    });

    let taskUpdateSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdateSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    expect(taskUpdateSet).not.toBeNull();
    expect(taskUpdateSet.status).toBe('completed');
  });

  it('promotes task to completed when stale worker has structured output', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-1', prUrl: null, prNumber: null, commitCount: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', parentTaskId: null });

    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: false, hasStructuredOutput: true, hasCommits: false, hasAny: true, details: 'structured output',
    });

    let taskUpdateSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdateSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    expect(taskUpdateSet).not.toBeNull();
    expect(taskUpdateSet.status).toBe('completed');
  });

  it('resets task to pending when stale worker has no deliverables', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-1', prUrl: null, prNumber: null, commitCount: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', parentTaskId: null });

    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none',
    });

    let taskUpdateSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdateSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    expect(taskUpdateSet).not.toBeNull();
    expect(taskUpdateSet.status).toBe('pending');
  });

  it('does nothing when no stale workers exist', async () => {
    mockWorkersFindMany.mockResolvedValue([]);
    await cleanupStaleWorkers('account-1');
    expect(mockCheckWorkerDeliverables).not.toHaveBeenCalled();
  });
});

describe('cleanupStaleWorkers — retry cap', () => {
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockCheckWorkerDeliverables.mockReset();
    mockGetWorkerArtifactCount.mockReset();
    mockGetWorkerArtifactCount.mockResolvedValue(0);
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none',
    });
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    });
  });

  it('resets task to pending when fewer than 3 failed workers exist', async () => {
    // Call sequence:
    // 1. Stale workers → 1 stale worker
    // 2. Other active workers for the task → none
    // 3. Failed workers count (retry cap) → 2 failed (below cap)
    // 4. Heartbeat orphans → none
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'stale-w1', taskId: 'task-1', prUrl: null, prNumber: null, commitCount: null },
      ])
      .mockResolvedValueOnce([]) // no other active workers
      .mockResolvedValueOnce([{ id: 'f1' }, { id: 'f2' }]) // 2 failed workers (below cap of 3)
      .mockResolvedValueOnce([]); // heartbeat check — no orphans

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', parentTaskId: null });

    let taskUpdateSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdateSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    expect(taskUpdateSet).not.toBeNull();
    expect(taskUpdateSet.status).toBe('pending');
    expect(taskUpdateSet.claimedBy).toBeNull();
    expect(taskUpdateSet.claimedAt).toBeNull();
  });

  it('permanently fails task when 3+ failed workers exist (retry cap reached)', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'stale-w1', taskId: 'task-1', prUrl: null, prNumber: null, commitCount: null },
      ])
      .mockResolvedValueOnce([]) // no other active workers
      .mockResolvedValueOnce([{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }]) // 3 failed (at cap)
      .mockResolvedValueOnce([]); // heartbeat check

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', parentTaskId: null });

    let taskUpdateSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdateSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    expect(taskUpdateSet).not.toBeNull();
    expect(taskUpdateSet.status).toBe('failed');
    expect(taskUpdateSet.result).toBeDefined();
    expect(taskUpdateSet.result.error).toContain('3 worker attempts');
  });

  it('still promotes to completed with deliverables even when retry cap is reached', async () => {
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: true, hasArtifacts: false, hasStructuredOutput: false, hasCommits: true, hasAny: true, details: 'PR #1',
    });

    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'stale-w1', taskId: 'task-1', prUrl: 'https://github.com/pr/1', prNumber: 1, commitCount: 3 },
      ])
      .mockResolvedValueOnce([]) // no other active workers
      // Note: failed workers count query should NOT be called when deliverables exist
      .mockResolvedValueOnce([]); // heartbeat check

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', parentTaskId: null });

    let taskUpdateSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdateSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    // Deliverables take priority — task promoted to completed regardless of retry count
    expect(taskUpdateSet).not.toBeNull();
    expect(taskUpdateSet.status).toBe('completed');
  });
});
