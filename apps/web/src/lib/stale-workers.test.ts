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
let capturedAccountsSet: any = null;
const mockAccountsUpdate = mock(() => ({
  set: mock((vals: any) => {
    capturedAccountsSet = vals;
    return { where: mock(() => Promise.resolve()) };
  }),
}));
// Exposed so tests can override section-2 (heartbeat-expiry) behaviour.
// Default: returns a fresh heartbeat → section 2 does NOT fire in most tests.
const mockWorkerHeartbeatsFindFirst = mock(() => ({ id: 'hb-1' }));
let capturedInsertValues: any = null;
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      tasks: { findFirst: mockTasksFindFirst, findMany: mockTasksFindMany },
      missions: { findFirst: mock(() => null) },
      workerHeartbeats: { findFirst: mockWorkerHeartbeatsFindFirst },
    },
    update: (table: any) => {
      if (table === 'workers') return mockWorkersUpdate();
      if (table === 'accounts') return mockAccountsUpdate();
      return mockTasksUpdate();
    },
    insert: (table: any) => table === 'missionNotes'
      ? {
          values: mock((values: any) => {
            capturedInsertValues = values;
            return Promise.resolve();
          }),
        }
      : mockTasksInsert(),
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
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }),
  notInArray: (field: any, values: any[]) => ({ field, values, type: 'notInArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers',
  tasks: 'tasks',
  workerHeartbeats: { accountId: 'accountId', lastHeartbeatAt: 'lastHeartbeatAt' },
  missionNotes: 'missionNotes',
  accounts: 'accounts',
}));

const mockGetWorkerArtifactCount = mock(() => Promise.resolve(0));
const mockCheckWorkerDeliverables = mock(() => ({
  hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none',
}));
const mockGetLatestWorkerArtifactWithStructuredOutput = mock(() => Promise.resolve(null));
mock.module('@/lib/worker-deliverables', () => ({
  checkWorkerDeliverables: mockCheckWorkerDeliverables,
  getWorkerArtifactCount: mockGetWorkerArtifactCount,
  getLatestWorkerArtifactWithStructuredOutput: mockGetLatestWorkerArtifactWithStructuredOutput,
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

describe('cleanupStaleWorkers — cancelled task protection', () => {
  // Regression: cancelled tasks were being re-queued when their aborted worker
  // expired and resolveStaleTask reset them to 'pending' without a status check.
  // Sequence: cancel task → abort worker → stale cleanup → task re-queued → re-claimed.
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
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
    mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
  });

  it('does not re-queue a cancelled task when its stale worker has no deliverables', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-1', prUrl: null, prNumber: null, commitCount: 0, branch: null, error: 'Aborted by user' }])
      .mockResolvedValueOnce([])   // no other active workers
      .mockResolvedValueOnce([]);  // heartbeat orphans

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    // resolveStaleTask reads task status first; resolveCompletedTask reads parentTaskId
    mockTasksFindFirst
      .mockResolvedValueOnce({ status: 'cancelled', context: {} })   // status check
      .mockResolvedValueOnce({ parentTaskId: null });                 // dep resolution

    let taskUpdateSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdateSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    // No task status update must occur — task stays cancelled
    expect(taskUpdateSet).toBeNull();
  });

  it('does not override cancelled status even when the stale worker has deliverables', async () => {
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: true, hasArtifacts: false, hasStructuredOutput: false, hasCommits: true, hasAny: true, details: 'PR #5',
    });

    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-1', prUrl: 'https://github.com/pr/5', prNumber: 5, commitCount: 2, branch: null, error: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst
      .mockResolvedValueOnce({ status: 'cancelled', context: {} })
      .mockResolvedValueOnce({ parentTaskId: null });

    let taskUpdateSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdateSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    // Task must stay cancelled — deliverables from an aborted worker must not win
    expect(taskUpdateSet).toBeNull();
  });

  it('still resets a non-cancelled task to pending when its stale worker has no deliverables', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-1', prUrl: null, prNumber: null, commitCount: 0, branch: null, error: 'expired' }])
      .mockResolvedValueOnce([])   // no other active workers
      .mockResolvedValueOnce([])   // failed workers count
      .mockResolvedValueOnce([]);  // heartbeat orphans

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst
      .mockResolvedValueOnce({ status: 'assigned', context: {} })  // not cancelled → proceed normally
      .mockResolvedValueOnce({ parentTaskId: null });

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
});

describe('cleanupStaleWorkers — reviewer lease expiry', () => {
  beforeEach(() => {
    capturedInsertValues = null;
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockCheckWorkerDeliverables.mockReset();
    mockGetWorkerArtifactCount.mockReset();
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
    mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
  });

  it('fails a stale reviewer task after promoting its PR to the human queue', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'review-worker', taskId: 'review-task', prUrl: null, prNumber: null, commitCount: 0, branch: null, error: 'expired' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockTasksFindMany.mockResolvedValue([{ id: 'review-task', workspaceId: 'ws-1' }]);
    mockTasksFindFirst
      .mockResolvedValueOnce({
        status: 'assigned',
        category: 'review',
        context: { reviewerFor: 'original-task', prNumber: 42 },
      })
      .mockResolvedValueOnce({ missionId: 'mission-1' })
      .mockResolvedValueOnce({ parentTaskId: null });

    const taskUpdates: any[] = [];
    mockTasksUpdate.mockReturnValue({
      set: mock((values: any) => {
        taskUpdates.push(values);
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    expect(taskUpdates).toHaveLength(1);
    expect(taskUpdates[0].status).toBe('failed');
    expect(taskUpdates[0].result.error).toContain('agent review timed out');
    expect(capturedInsertValues.type).toBe('reviewer_escalated');
    expect(capturedInsertValues.title).toContain('agent review timed out');
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

describe('cleanupStaleWorkers — heartbeat-expiry path with deliverables', () => {
  // Regression: stale-worker reaper marks a finished worker as 'runner went offline'
  // even after the worker delivered PR+artifact. The heartbeat-expiry path (section 2)
  // calls resolveStaleTask just like section 1 — it must promote the task to completed,
  // not reset it to pending or fail it.
  // Incident: worker on buildd/f97… delivered PR #1591 then was killed by the reaper
  // because the runner's heartbeat was stale (> 150 min). The task was misclassified as
  // failed/Infra Error. See memory e1b02fc0 and 48eae69a.
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockCheckWorkerDeliverables.mockReset();
    mockGetWorkerArtifactCount.mockReset();
    mockWorkerHeartbeatsFindFirst.mockReset();
    mockWorkerHeartbeatsFindFirst.mockReturnValue({ id: 'hb-1' }); // fresh by default
    mockGetWorkerArtifactCount.mockResolvedValue(0);
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none',
    });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
    mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
  });

  it('promotes task to completed when heartbeat-expired worker has a registered PR', async () => {
    // Section 1 (15-min stale): no stale workers
    // Section 2 (heartbeat): one orphaned worker that delivered a PR
    // null → no fresh heartbeat → section 2 fires
    mockWorkerHeartbeatsFindFirst.mockReturnValueOnce(null);

    mockWorkersFindMany
      .mockResolvedValueOnce([])  // section 1: no 15-min stale workers
      .mockResolvedValueOnce([    // section 2: one heartbeat-orphaned worker with a PR
        { id: 'w-hb', taskId: 'task-hb', prUrl: 'https://github.com/org/repo/pull/1591', prNumber: 1591, commitCount: 5, branch: 'buildd/f97abc', error: null },
      ])
      .mockResolvedValueOnce([]); // no other active workers for the task

    mockTasksFindMany
      .mockResolvedValueOnce([{ id: 'task-hb', workspaceId: 'ws-1' }]); // orphanTasks

    mockTasksFindFirst
      .mockResolvedValueOnce({ status: 'assigned', category: 'feature', context: {} }) // resolveStaleTask: current task
      .mockResolvedValueOnce({ parentTaskId: null }); // resolveCompletedTask: dep check

    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: true, hasArtifacts: false, hasStructuredOutput: false, hasCommits: true,
      hasAny: true, details: 'PR #1591, 5 commits',
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
    // result must be populated so mission review sees a real completion
    expect(taskUpdateSet.result).toBeDefined();
    expect(taskUpdateSet.result.prUrl).toBe('https://github.com/org/repo/pull/1591');
    expect(taskUpdateSet.result.prNumber).toBe(1591);
    expect(taskUpdateSet.result.reaperAutoCompleted).toBe(true);
  });

  it('promotes task to completed when heartbeat-expired worker has artifact but no PR', async () => {
    mockWorkerHeartbeatsFindFirst.mockReturnValueOnce(null);

    mockGetWorkerArtifactCount.mockResolvedValue(2);

    mockWorkersFindMany
      .mockResolvedValueOnce([])  // section 1: no stale workers
      .mockResolvedValueOnce([    // section 2: orphaned worker with artifacts
        { id: 'w-hb', taskId: 'task-hb', prUrl: null, prNumber: null, commitCount: 0, branch: 'buildd/f97abc', error: null },
      ])
      .mockResolvedValueOnce([]); // no other active workers

    mockTasksFindMany.mockResolvedValueOnce([{ id: 'task-hb', workspaceId: 'ws-1' }]);
    mockTasksFindFirst
      .mockResolvedValueOnce({ status: 'assigned', category: 'feature', context: {} })
      .mockResolvedValueOnce({ parentTaskId: null });

    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: true, hasStructuredOutput: false, hasCommits: false,
      hasAny: true, details: '2 artifacts',
    });

    let taskUpdateSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => { taskUpdateSet = vals; return { where: mock(() => Promise.resolve()) }; }),
    });

    await cleanupStaleWorkers('account-1');

    expect(taskUpdateSet).not.toBeNull();
    expect(taskUpdateSet.status).toBe('completed');
    expect(taskUpdateSet.result).toBeDefined();
    expect(taskUpdateSet.result.reaperAutoCompleted).toBe(true);
  });

  it('still resets to pending when heartbeat-expired worker has no deliverables', async () => {
    mockWorkerHeartbeatsFindFirst.mockReturnValueOnce(null);

    mockWorkersFindMany
      .mockResolvedValueOnce([])  // section 1: no stale workers
      .mockResolvedValueOnce([    // section 2: orphaned worker with no deliverables
        { id: 'w-hb', taskId: 'task-hb', prUrl: null, prNumber: null, commitCount: 0, branch: null, error: null },
      ])
      .mockResolvedValueOnce([])  // no other active workers
      .mockResolvedValueOnce([]); // no failed workers (retry cap check)

    mockTasksFindMany.mockResolvedValueOnce([{ id: 'task-hb', workspaceId: 'ws-1' }]);
    mockTasksFindFirst
      .mockResolvedValueOnce({ status: 'assigned', category: 'feature', context: {} })
      .mockResolvedValueOnce({ parentTaskId: null });

    let taskUpdateSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => { taskUpdateSet = vals; return { where: mock(() => Promise.resolve()) }; }),
    });

    await cleanupStaleWorkers('account-1');

    expect(taskUpdateSet).not.toBeNull();
    expect(taskUpdateSet.status).toBe('pending');
  });

  it('promotes to completed even when getWorkerArtifactCount would throw (prUrl present)', async () => {
    // This tests the fix: artifact count error must NOT prevent the prUrl check.
    // If the try-catch wrapped checkWorkerDeliverables too (old bug), the throw would
    // leave hasDeliverables=false and the task would be reset to pending.
    mockWorkerHeartbeatsFindFirst.mockReturnValueOnce(null);

    mockGetWorkerArtifactCount.mockRejectedValue(new Error('DB timeout'));

    mockWorkersFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'w-hb', taskId: 'task-hb', prUrl: 'https://github.com/org/repo/pull/99', prNumber: 99, commitCount: 3, branch: 'buildd/abc', error: null },
      ])
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValueOnce([{ id: 'task-hb', workspaceId: 'ws-1' }]);
    mockTasksFindFirst
      .mockResolvedValueOnce({ status: 'assigned', category: 'feature', context: {} })
      .mockResolvedValueOnce({ parentTaskId: null });

    // With artifactCount=0 (fallback) + prUrl set → checkWorkerDeliverables must still return hasAny=true
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: true, hasArtifacts: false, hasStructuredOutput: false, hasCommits: true,
      hasAny: true, details: 'PR #99, 3 commits',
    });

    let taskUpdateSet: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => { taskUpdateSet = vals; return { where: mock(() => Promise.resolve()) }; }),
    });

    await cleanupStaleWorkers('account-1');

    // Even with artifact query failure, prUrl being set must promote to completed
    expect(taskUpdateSet).not.toBeNull();
    expect(taskUpdateSet.status).toBe('completed');
    expect(taskUpdateSet.result.prUrl).toBe('https://github.com/org/repo/pull/99');
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

  it('does not count sandbox_mount_gap workers toward retry cap', async () => {
    // 3 failed workers, but all are sandbox_mount_gap — none charge against the cap.
    // Task should still be reset to pending (cap not reached).
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'stale-w1', taskId: 'task-1', prUrl: null, prNumber: null, commitCount: null },
      ])
      .mockResolvedValueOnce([]) // no other active workers
      .mockResolvedValueOnce([
        { id: 'f1', exitCause: 'sandbox_mount_gap' },
        { id: 'f2', exitCause: 'sandbox_mount_gap' },
        { id: 'f3', exitCause: 'sandbox_mount_gap' },
      ]) // 3 sandbox_mount_gap workers — all exempt from cap
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

    // sandbox_mount_gap workers don't consume retry slots — task re-queued, not failed
    expect(taskUpdateSet).not.toBeNull();
    expect(taskUpdateSet.status).toBe('pending');
  });

  it('counts mixed exitCause workers correctly (sandbox_mount_gap exempt, code_failure not)', async () => {
    // 2 sandbox_mount_gap + 3 code_failure = 3 chargeable → cap reached
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'stale-w1', taskId: 'task-1', prUrl: null, prNumber: null, commitCount: null },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'f1', exitCause: 'sandbox_mount_gap' },
        { id: 'f2', exitCause: 'sandbox_mount_gap' },
        { id: 'f3', exitCause: 'code_failure' },
        { id: 'f4', exitCause: 'code_failure' },
        { id: 'f5', exitCause: 'code_failure' },
      ])
      .mockResolvedValueOnce([]);

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

    // 3 code_failure workers hit the cap → permanently failed
    expect(taskUpdateSet).not.toBeNull();
    expect(taskUpdateSet.status).toBe('failed');
  });
});

describe('cleanupStaleWorkers — activeSessions seat release', () => {
  // Regression: activeSessions was incremented at claim time but never decremented.
  // Any code path that takes a live worker to a terminal state must decrement it so
  // future claims are not permanently blocked by Gate B (maxConcurrentSessions check).
  beforeEach(() => {
    capturedAccountsSet = null;
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockAccountsUpdate.mockReset();
    mockCheckWorkerDeliverables.mockReset();
    mockGetWorkerArtifactCount.mockReset();
    mockWorkerHeartbeatsFindFirst.mockReset();
    mockWorkerHeartbeatsFindFirst.mockReturnValue({ id: 'hb-1' }); // fresh heartbeat by default
    mockGetWorkerArtifactCount.mockResolvedValue(0);
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none',
    });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
    mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
    mockAccountsUpdate.mockReturnValue({
      set: mock((vals: any) => {
        capturedAccountsSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });
  });

  it('decrements activeSessions when stale workers (15-min path) are reaped', async () => {
    // One stale worker in 'running' status — it held a seat that must be released.
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-1', prUrl: null, prNumber: null, commitCount: 0, branch: null, error: null }])
      .mockResolvedValueOnce([])   // no other active workers
      .mockResolvedValueOnce([])   // failed workers (retry cap)
      .mockResolvedValueOnce([]);  // heartbeat orphans

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst
      .mockResolvedValueOnce({ status: 'assigned', context: {} })
      .mockResolvedValueOnce({ parentTaskId: null });

    await cleanupStaleWorkers('account-1');

    // activeSessions decrement must have been attempted
    expect(mockAccountsUpdate).toHaveBeenCalled();
    expect(capturedAccountsSet).not.toBeNull();
    expect(capturedAccountsSet.activeSessions).toBeDefined();
  });

  it('decrements by the number of reaped workers (batch)', async () => {
    // Two stale workers — both seats must be released in one decrement.
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'w1', taskId: 'task-1', prUrl: null, prNumber: null, commitCount: 0, branch: null, error: null },
        { id: 'w2', taskId: 'task-2', prUrl: null, prNumber: null, commitCount: 0, branch: null, error: null },
      ])
      .mockResolvedValueOnce([])   // other active workers for task-1
      .mockResolvedValueOnce([])   // failed workers for task-1
      .mockResolvedValueOnce([])   // other active workers for task-2
      .mockResolvedValueOnce([])   // failed workers for task-2
      .mockResolvedValueOnce([]);  // heartbeat orphans

    mockTasksFindMany.mockResolvedValue([
      { id: 'task-1', workspaceId: 'ws-1' },
      { id: 'task-2', workspaceId: 'ws-1' },
    ]);
    mockTasksFindFirst
      .mockResolvedValueOnce({ status: 'assigned', context: {} })
      .mockResolvedValueOnce({ parentTaskId: null })
      .mockResolvedValueOnce({ status: 'assigned', context: {} })
      .mockResolvedValueOnce({ parentTaskId: null });

    await cleanupStaleWorkers('account-1');

    // One decrement call for the batch of 2 stale workers
    expect(capturedAccountsSet).not.toBeNull();
    expect(capturedAccountsSet.activeSessions).toBeDefined();
  });

  it('decrements activeSessions when heartbeat-orphaned workers are reaped', async () => {
    // No 15-min stale workers, but heartbeat is stale → section 2 fires.
    mockWorkerHeartbeatsFindFirst.mockReturnValueOnce(null); // no fresh heartbeat

    mockWorkersFindMany
      .mockResolvedValueOnce([])  // section 1: no 15-min stale workers
      .mockResolvedValueOnce([    // section 2: one heartbeat-orphaned worker
        { id: 'w-hb', taskId: 'task-hb', prUrl: null, prNumber: null, commitCount: 0, branch: null, error: null },
      ])
      .mockResolvedValueOnce([])  // no other active workers for the orphaned task
      .mockResolvedValueOnce([]); // failed workers count for task-hb (resolveStaleTask)

    mockTasksFindMany.mockResolvedValueOnce([{ id: 'task-hb', workspaceId: 'ws-1' }]);
    mockTasksFindFirst
      .mockResolvedValueOnce({ status: 'assigned', context: {} })
      .mockResolvedValueOnce({ parentTaskId: null });

    mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });

    await cleanupStaleWorkers('account-1');

    // activeSessions must be decremented for the heartbeat-orphaned worker
    expect(mockAccountsUpdate).toHaveBeenCalled();
    expect(capturedAccountsSet).not.toBeNull();
    expect(capturedAccountsSet.activeSessions).toBeDefined();
  });

  it('does not call accounts update when no workers are reaped', async () => {
    // No stale workers in either section → no decrement should be attempted.
    mockWorkersFindMany
      .mockResolvedValueOnce([]) // section 1: no stale workers
      .mockResolvedValueOnce([]); // section 2: no orphans (but heartbeat is fresh, so section 2 won't even query)

    await cleanupStaleWorkers('account-1');

    expect(mockAccountsUpdate).not.toHaveBeenCalled();
  });
});

describe('cleanupStuckWaitingInput — activeSessions seat release', () => {
  beforeEach(() => {
    capturedAccountsSet = null;
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockTasksInsert.mockReset();
    mockAccountsUpdate.mockReset();
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
    mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
    mockTasksInsert.mockReturnValue({
      values: mock(() => ({ returning: mock(() => [{ id: 'new-task-id' }]) })),
    });
    mockAccountsUpdate.mockReturnValue({
      set: mock((vals: any) => {
        capturedAccountsSet = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });
  });

  it('decrements activeSessions when a stuck waiting_input worker is cleaned up', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', taskId: 'task-1', accountId: 'account-1', status: 'waiting_input', updatedAt: staleDate, waitingFor: null, task: { missionId: null } },
    ]);
    mockTasksFindFirst.mockResolvedValue({
      id: 'task-1', workspaceId: 'ws-1', title: 'Fix bug', description: 'Fix the bug',
      priority: 0, category: null, project: null, context: {}, requiredCapabilities: [],
      missionId: null, runnerPreference: 'any', mode: 'execution', outputRequirement: 'auto', outputSchema: null,
    });

    await cleanupStuckWaitingInput();

    // activeSessions decrement must have been attempted for the worker's account
    expect(mockAccountsUpdate).toHaveBeenCalled();
    expect(capturedAccountsSet).not.toBeNull();
    expect(capturedAccountsSet.activeSessions).toBeDefined();
  });

  it('does not decrement activeSessions when no stuck workers exist', async () => {
    mockWorkersFindMany.mockResolvedValue([]);

    await cleanupStuckWaitingInput();

    expect(mockAccountsUpdate).not.toHaveBeenCalled();
  });
});

describe('cleanupStaleWorkers — pr_merged reaper exemption (B.3)', () => {
  // Simulates the de0357c2 scenario: worker declares pr_merged wait (condition_unmet),
  // 15+ minutes of silence, reaper leaves task alone. After expiry ceiling, reaper fails.
  const PR_MERGED_LOOP_CONFIG = {
    exitCondition: { type: 'pr_merged' },
    maxLoops: 6,
    waitExpiryMinutes: 240,
  };

  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockCheckWorkerDeliverables.mockReset();
    mockGetWorkerArtifactCount.mockReset();
    mockGetLatestWorkerArtifactWithStructuredOutput.mockReset();
    mockGetWorkerArtifactCount.mockResolvedValue(0);
    mockGetLatestWorkerArtifactWithStructuredOutput.mockResolvedValue(null);
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none',
    });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
    mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
  });

  it('leaves a pr_merged condition_unmet task as pending when within the wait window', async () => {
    // Worker went stale (no update for 15+ min) but task is condition_unmet with pr_merged
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-1', prUrl: null, prNumber: 42, commitCount: 1, branch: 'buildd/feat', error: null }])
      .mockResolvedValueOnce([])   // no other active workers
      .mockResolvedValueOnce([]);  // heartbeat orphans

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);

    // Task is condition_unmet with pr_merged; updatedAt is 2h ago (within 4h window)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mockTasksFindFirst
      .mockResolvedValueOnce({
        status: 'pending',
        context: {},
        category: null,
        loopConfig: PR_MERGED_LOOP_CONFIG,
        loopState: 'condition_unmet',
        updatedAt: twoHoursAgo,
      })
      .mockResolvedValueOnce({ parentTaskId: null }); // resolveCompletedTask dep resolution

    const taskUpdates: any[] = [];
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdates.push(vals);
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    // Task must NOT be failed or set to pending with a retry — reaper exemption applies
    expect(taskUpdates.filter(u => u.status === 'failed' || u.status === 'pending')).toHaveLength(0);
  });

  it('fails a pr_merged condition_unmet task when the wait ceiling is exceeded', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-1', prUrl: null, prNumber: 42, commitCount: 1, branch: 'buildd/feat', error: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);

    // updatedAt is 5h ago — past the 240-min ceiling
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    mockTasksFindFirst
      .mockResolvedValueOnce({
        status: 'pending',
        context: {},
        category: null,
        loopConfig: PR_MERGED_LOOP_CONFIG,
        loopState: 'condition_unmet',
        updatedAt: fiveHoursAgo,
      })
      .mockResolvedValueOnce({ parentTaskId: null });

    let failedTaskUpdate: any = null;
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        if (vals.status === 'failed') failedTaskUpdate = vals;
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    // Task must be failed after expiry
    expect(failedTaskUpdate).not.toBeNull();
    expect(failedTaskUpdate.status).toBe('failed');
    expect(JSON.stringify(failedTaskUpdate.result)).toContain('PR merge wait expired');
  });

  it('does not exempt a task with pr_checks_green condition from normal staleness', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-1', prUrl: null, prNumber: 42, commitCount: 0, branch: null, error: null }])
      .mockResolvedValueOnce([])   // no other active workers
      .mockResolvedValueOnce([]);  // failed workers for cap check
    mockWorkersFindMany.mockResolvedValueOnce([]); // heartbeat orphans

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst
      .mockResolvedValueOnce({
        status: 'pending',
        context: {},
        category: null,
        loopConfig: { exitCondition: { type: 'pr_checks_green' }, maxLoops: 3 },
        loopState: 'condition_unmet',
        updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      })
      .mockResolvedValueOnce([]) // failed workers
      .mockResolvedValueOnce({ parentTaskId: null });

    const taskUpdates: any[] = [];
    mockTasksUpdate.mockReturnValue({
      set: mock((vals: any) => {
        taskUpdates.push(vals);
        return { where: mock(() => Promise.resolve()) };
      }),
    });

    await cleanupStaleWorkers('account-1');

    // pr_checks_green tasks are NOT exempt — they go through normal stale handling
    expect(taskUpdates.some(u => u.status === 'pending' || u.status === 'failed')).toBe(true);
  });
});

describe('cleanupStaleWorkers — outcome-first summaries (B.5)', () => {
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockCheckWorkerDeliverables.mockReset();
    mockGetWorkerArtifactCount.mockReset();
    mockGetLatestWorkerArtifactWithStructuredOutput.mockReset();
    mockGetWorkerArtifactCount.mockResolvedValue(1);
    mockGetLatestWorkerArtifactWithStructuredOutput.mockResolvedValue(null);
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: true, hasStructuredOutput: false, hasCommits: false, hasAny: true, details: '1 artifact',
    });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
    mockTasksUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
  });

  it('uses structuredOutput.summary from artifact when present', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-1', prUrl: null, prNumber: null, commitCount: 0, branch: null, error: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst
      .mockResolvedValueOnce({ status: 'assigned', context: {}, category: null, loopConfig: null, loopState: null, updatedAt: new Date() })
      .mockResolvedValueOnce({ parentTaskId: null });

    const OUTCOME_SUMMARY = 'PR #1721 merged via squash into dev';
    mockGetLatestWorkerArtifactWithStructuredOutput.mockResolvedValue({
      metadata: { structuredOutput: { summary: OUTCOME_SUMMARY } },
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
    expect(taskUpdateSet.result.summary).toBe(OUTCOME_SUMMARY);
    expect(taskUpdateSet.result.reaperAutoCompleted).toBe(true);
    expect(taskUpdateSet.result.reaperForensics).toContain('1 artifact');
  });

  it('falls back to reaper forensics summary when no structuredOutput on artifact', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([{ id: 'w1', taskId: 'task-1', prUrl: null, prNumber: null, commitCount: 0, branch: null, error: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst
      .mockResolvedValueOnce({ status: 'assigned', context: {}, category: null, loopConfig: null, loopState: null, updatedAt: new Date() })
      .mockResolvedValueOnce({ parentTaskId: null });

    // Artifact exists but has no structuredOutput.summary
    mockGetLatestWorkerArtifactWithStructuredOutput.mockResolvedValue(null);

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
    expect(taskUpdateSet.result.summary).toContain('stale-worker reaper');
    expect(taskUpdateSet.result.reaperAutoCompleted).toBe(true);
    expect(taskUpdateSet.result.reaperForensics).toBeDefined();
  });
});

// ─── Orphan / silent-start taxonomy ─────────────────────────────────────────
// Regression (2026-08-28): every reaped worker was booked as `infra_failure`
// with "Stale worker expired (no update for 15+ minutes)" — including rows the
// server minted at claim that NO runner ever started (started_at IS NULL), and
// sessions that started but streamed nothing at all ($0, ≤2 turns). Both shapes
// inflated the failure rate and were undiagnosable from the DB.
describe('cleanupStaleWorkers — never-started / silent-start taxonomy', () => {
  let workerUpdates: Array<{ vals: any; where: any }> = [];

  beforeEach(() => {
    workerUpdates = [];
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
      set: mock((vals: any) => ({
        where: mock((where: any) => {
          workerUpdates.push({ vals, where });
          return Promise.resolve();
        }),
      })),
    });
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({ where: mock(() => Promise.resolve()) })),
    });
  });

  it('books a worker no runner ever started as never_started, not infra_failure', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'orphan-1', taskId: 'task-1', status: 'idle', startedAt: null, turns: 0, costUsd: '0.000000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
      ])
      .mockResolvedValueOnce([]) // no other active workers
      .mockResolvedValueOnce([]) // failed workers (retry cap)
      .mockResolvedValueOnce([]); // heartbeat orphans

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', parentTaskId: null });

    await cleanupStaleWorkers('account-1');

    expect(workerUpdates.length).toBeGreaterThan(0);
    const update = workerUpdates[0].vals;
    expect(update.status).toBe('failed');
    expect(update.exitCause).toBe('never_started');
    expect(update.error).not.toContain('no update for 15+ minutes');
    expect(update.error.toLowerCase()).toContain('never started');
  });

  it('books a started-but-outputless worker as silent_start with diagnosable text', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'silent-1', taskId: 'task-1', status: 'running', startedAt: new Date(Date.now() - 20 * 60 * 1000), turns: 2, costUsd: '0.000000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockTasksFindMany.mockResolvedValue([{ id: 'task-1', workspaceId: 'ws-1' }]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', parentTaskId: null });

    await cleanupStaleWorkers('account-1');

    const update = workerUpdates[0].vals;
    expect(update.exitCause).toBe('silent_start');
    expect(update.error).toContain('no output');
  });

  it('splits a mixed batch into one update per exit cause', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'orphan-1', taskId: 'task-1', status: 'idle', startedAt: null, turns: 0, costUsd: '0.000000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
        { id: 'silent-1', taskId: 'task-2', status: 'running', startedAt: new Date(), turns: 1, costUsd: '0.000000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
        { id: 'real-1', taskId: 'task-3', status: 'running', startedAt: new Date(), turns: 44, costUsd: '0.230000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
      ])
      .mockResolvedValue([]);

    mockTasksFindMany.mockResolvedValue([
      { id: 'task-1', workspaceId: 'ws-1' },
      { id: 'task-2', workspaceId: 'ws-1' },
      { id: 'task-3', workspaceId: 'ws-1' },
    ]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', parentTaskId: null });

    await cleanupStaleWorkers('account-1');

    const causes = workerUpdates.map(u => u.vals.exitCause);
    expect(causes).toContain('never_started');
    expect(causes).toContain('silent_start');
    expect(causes).toContain('infra_failure');

    // Each update must target only the worker ids of its own class.
    const byCause = new Map(workerUpdates.map(u => [u.vals.exitCause, u.where?.values ?? []]));
    expect(byCause.get('never_started')).toEqual(['orphan-1']);
    expect(byCause.get('silent_start')).toEqual(['silent-1']);
    expect(byCause.get('infra_failure')).toEqual(['real-1']);
  });

  it('does not charge never_started workers against the retry cap', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'orphan-4', taskId: 'task-1', status: 'idle', startedAt: null, turns: 0, costUsd: '0.000000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'f1', exitCause: 'never_started' },
        { id: 'f2', exitCause: 'never_started' },
        { id: 'f3', exitCause: 'never_started' },
      ])
      .mockResolvedValueOnce([]);

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
  });

  it('fails the task with a legible reason after 3 silent-start sessions', async () => {
    mockWorkersFindMany
      .mockResolvedValueOnce([
        { id: 'silent-4', taskId: 'task-1', status: 'running', startedAt: new Date(), turns: 1, costUsd: '0.000000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'f1', exitCause: 'silent_start' },
        { id: 'f2', exitCause: 'silent_start' },
        { id: 'f3', exitCause: 'silent_start' },
      ])
      .mockResolvedValueOnce([]);

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
    expect(taskUpdateSet.result.error).toContain('silent-start');
  });

  it('looks for silent-start workers on a shorter clock than the 15-minute stale rule', async () => {
    mockWorkersFindMany.mockResolvedValue([]);

    await cleanupStaleWorkers('account-1');

    // Walk the captured where-tree for the cutoff Dates the query was built with.
    const dates: Date[] = [];
    const walk = (node: any, depth = 0) => {
      if (!node || depth > 8) return;
      if (node instanceof Date) { dates.push(node); return; }
      if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return; }
      if (typeof node === 'object') { Object.values(node).forEach(n => walk(n, depth + 1)); }
    };
    walk(mockWorkersFindMany.mock.calls[0][0]);

    const agesMin = dates.map(d => Math.round((Date.now() - d.getTime()) / 60000));
    // 15-min stale rule + 5-min idle rule already existed; the silent-start rule
    // must fire well before the generic 15-minute expiry.
    expect(agesMin).toContain(15);
    const silentWindow = agesMin.find(m => m > 5 && m < 15);
    expect(silentWindow).toBeDefined();
  });
});

describe('cleanupStaleWorkers — heartbeat path taxonomy', () => {
  let workerUpdates: Array<{ vals: any; where: any }> = [];

  beforeEach(() => {
    workerUpdates = [];
    mockWorkersFindMany.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkersUpdate.mockReset();
    mockTasksUpdate.mockReset();
    mockWorkerHeartbeatsFindFirst.mockReset();
    mockCheckWorkerDeliverables.mockReset();
    mockGetWorkerArtifactCount.mockReset();
    mockGetWorkerArtifactCount.mockResolvedValue(0);
    mockCheckWorkerDeliverables.mockReturnValue({
      hasPR: false, hasArtifacts: false, hasStructuredOutput: false, hasCommits: false, hasAny: false, details: 'none',
    });
    mockWorkersUpdate.mockReturnValue({
      set: mock((vals: any) => ({
        where: mock((where: any) => {
          workerUpdates.push({ vals, where });
          return Promise.resolve();
        }),
      })),
    });
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({ where: mock(() => Promise.resolve()) })),
    });
  });

  it('books a never-started row as never_started even when the runner heartbeat expired', async () => {
    // No fresh heartbeat → section 2 fires.
    mockWorkerHeartbeatsFindFirst.mockResolvedValue(null);
    mockWorkersFindMany
      .mockResolvedValueOnce([]) // section 1: no stale workers
      .mockResolvedValueOnce([   // section 2: heartbeat orphans
        { id: 'hb-orphan', taskId: 'task-9', startedAt: null, turns: 0, costUsd: '0.000000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
        { id: 'hb-worked', taskId: 'task-10', startedAt: new Date(), turns: 30, costUsd: '0.500000', prUrl: null, prNumber: null, commitCount: null, branch: null, error: null },
      ])
      .mockResolvedValue([]);

    mockTasksFindMany.mockResolvedValue([
      { id: 'task-9', workspaceId: 'ws-1' },
      { id: 'task-10', workspaceId: 'ws-1' },
    ]);
    mockTasksFindFirst.mockResolvedValue({ id: 'task-9', workspaceId: 'ws-1', parentTaskId: null });

    await cleanupStaleWorkers('account-1');

    const byCause = new Map(workerUpdates.map(u => [u.vals.exitCause, u]));
    expect(byCause.get('never_started')?.where?.values).toEqual(['hb-orphan']);
    expect(byCause.get('infra_failure')?.where?.values).toEqual(['hb-worked']);
    expect(byCause.get('infra_failure')?.vals.error).toContain('heartbeat expired');

    // Restore the file-wide default (fresh heartbeat) for anything appended later.
    mockWorkerHeartbeatsFindFirst.mockResolvedValue({ id: 'hb-1' });
  });
});
