import { describe, it, expect, beforeEach, mock } from 'bun:test';

// --- Mocks ---
const mockWorkersFindMany = mock(() => [] as any[]);
const mockTasksFindFirst = mock(() => null as any);
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
      tasks: { findFirst: mockTasksFindFirst, findMany: mock(() => []) },
      workerHeartbeats: { findFirst: mock(() => null) },
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
  inArray: (field: any, values: any[]) => ({ field, values, type: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: 'workers',
  tasks: 'tasks',
  workerHeartbeats: { accountId: 'accountId', lastHeartbeatAt: 'lastHeartbeatAt' },
}));

import { cleanupStuckWaitingInput } from './stale-workers';

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
      objectiveId: null,
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
      objectiveId: null,
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
      objectiveId: 'obj-1',
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
        objectiveId: null, runnerPreference: 'any', mode: 'execution', outputRequirement: 'auto', outputSchema: null,
      })
      // resolveCompletedTask calls findFirst internally (no parentTaskId → no-op)
      .mockResolvedValueOnce({ parentTaskId: null })
      .mockResolvedValueOnce({
        id: 'task-2', workspaceId: 'ws-1', title: 'Task 2', description: 'Desc 2',
        priority: 0, category: null, project: null, context: {}, requiredCapabilities: [],
        objectiveId: null, runnerPreference: 'any', mode: 'execution', outputRequirement: 'auto', outputSchema: null,
      })
      // resolveCompletedTask calls findFirst internally (no parentTaskId → no-op)
      .mockResolvedValueOnce({ parentTaskId: null });

    const result = await cleanupStuckWaitingInput();

    expect(result.failedWorkers).toBe(2);
    expect(result.retriedTasks).toBe(2);
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
      objectiveId: null, runnerPreference: 'any', mode: 'execution', outputRequirement: 'auto', outputSchema: null,
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
