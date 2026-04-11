import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mock functions
const mockFindFirst = mock(() => null as any);
const mockFindMany = mock(() => [] as any);
const mockSelect = mock();
const mockFrom = mock();
const mockWhere = mock(() => [] as any);
const mockInsertValues = mock(() => Promise.resolve());
const mockInsert = mock();
const mockUpdateSet = mock(() => ({ where: mockUpdateWhere }));
const mockUpdate = mock(() => ({ set: mockUpdateSet }));
const mockUpdateWhere = mock(() => Promise.resolve());

// Track chained select calls to return different results
let selectCallCount = 0;
let selectWhereResults: any[][] = [];

// Track findFirst calls to return different results per call
let findFirstCallCount = 0;
let findFirstResults: any[] = [];

// Track missions findFirst separately
let missionsFindFirstResults: any[] = [];
let missionsFindFirstCallCount = 0;

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: {
        findFirst: (...args: any[]) => {
          const callIndex = findFirstCallCount++;
          mockFindFirst(...args);
          return Promise.resolve(findFirstResults[callIndex] ?? null);
        },
        findMany: mockFindMany,
      },
      missions: {
        findFirst: (...args: any[]) => {
          const callIndex = missionsFindFirstCallCount++;
          return Promise.resolve(missionsFindFirstResults[callIndex] ?? null);
        },
      },
    },
    select: (...args: any[]) => {
      mockSelect(...args);
      const callIndex = selectCallCount++;
      return {
        from: (...args2: any[]) => {
          mockFrom(...args2);
          return {
            where: (...args3: any[]) => {
              mockWhere(...args3);
              return Promise.resolve(selectWhereResults[callIndex] || []);
            },
          };
        },
      };
    },
    insert: (...args: any[]) => {
      mockInsert(...args);
      return {
        values: mockInsertValues,
      };
    },
    update: (...args: any[]) => {
      mockUpdate(...args);
      return {
        set: (...setArgs: any[]) => {
          mockUpdateSet(...setArgs);
          return {
            where: (...whereArgs: any[]) => {
              mockUpdateWhere(...whereArgs);
              return Promise.resolve();
            },
          };
        },
      };
    },
  },
}));

const mockTriggerEvent = mock(() => Promise.resolve());
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: {
    CHILDREN_COMPLETED: 'task:children_completed',
    TASK_UNBLOCKED: 'task:unblocked',
    TASK_DEPENDENCY_FAILED: 'task:dependency_failed',
  },
}));

import { resolveCompletedTask } from './task-dependencies';

function resetMocks() {
  mockFindFirst.mockReset();
  mockFindMany.mockReset();
  mockSelect.mockReset();
  mockFrom.mockReset();
  mockWhere.mockReset();
  mockTriggerEvent.mockReset();
  mockInsert.mockReset();
  mockInsertValues.mockReset();
  mockUpdate.mockReset();
  mockUpdateSet.mockReset();
  mockUpdateWhere.mockReset();
  selectCallCount = 0;
  selectWhereResults = [];
  findFirstCallCount = 0;
  findFirstResults = [];
  missionsFindFirstCallCount = 0;
  missionsFindFirstResults = [];
}

describe('task-dependencies', () => {
  beforeEach(resetMocks);

  it('does nothing when task has no parent and nothing depends on it', async () => {
    // findFirst[0]: task has no parentTaskId
    findFirstResults[0] = { parentTaskId: null };
    // select[0]: no tasks depend on it
    selectWhereResults = [[]];

    await resolveCompletedTask('task-1', 'ws-1');

    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('fires CHILDREN_COMPLETED when all siblings done', async () => {
    // findFirst[0]: task has a parent
    findFirstResults[0] = { parentTaskId: 'parent-1' };
    // findFirst[1]: parent is not planning mode (from maybeCreateAggregationTask)
    findFirstResults[1] = { id: 'parent-1', mode: 'execution' };
    // findMany: all children in terminal state
    mockFindMany.mockResolvedValue([
      { id: 'task-1', status: 'completed', workspaceId: 'ws-1', title: 'A', result: null },
      { id: 'task-2', status: 'failed', workspaceId: 'ws-1', title: 'B', result: null },
      { id: 'task-3', status: 'completed', workspaceId: 'ws-1', title: 'C', result: null },
    ]);
    // select[0]: no tasks depend on it
    selectWhereResults = [[]];

    await resolveCompletedTask('task-1', 'ws-1');

    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'workspace-ws-1',
      'task:children_completed',
      {
        parentTaskId: 'parent-1',
        childCount: 3,
        completed: 2,
        failed: 1,
      }
    );
  });

  it('does not fire CHILDREN_COMPLETED when siblings still pending', async () => {
    // findFirst[0]: task has a parent
    findFirstResults[0] = { parentTaskId: 'parent-1' };
    // findMany: some children not terminal
    mockFindMany.mockResolvedValue([
      { id: 'task-1', status: 'completed', workspaceId: 'ws-1', title: 'A', result: null },
      { id: 'task-2', status: 'waiting', workspaceId: 'ws-1', title: 'B', result: null },
      { id: 'task-3', status: 'in_progress', workspaceId: 'ws-1', title: 'C', result: null },
    ]);
    // select[0]: no tasks depend on it
    selectWhereResults = [[]];

    await resolveCompletedTask('task-1', 'ws-1');

    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('fires TASK_UNBLOCKED when completing a dependency', async () => {
    // findFirst[0]: task has no parent
    findFirstResults[0] = { parentTaskId: null };
    // select[0]: one task depends on the completed task
    // select[1]: fetch dep statuses — all resolved
    selectWhereResults = [
      [{ id: 'dependent-1', dependsOn: ['task-1'], workspaceId: 'ws-1' }],
      [{ id: 'task-1', status: 'completed' }],
    ];

    await resolveCompletedTask('task-1', 'ws-1');

    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'workspace-ws-1',
      'task:unblocked',
      {
        taskId: 'dependent-1',
        resolvedDependency: 'task-1',
      }
    );
  });

  it('does not fire TASK_UNBLOCKED when dependent has other unresolved deps', async () => {
    // findFirst[0]: task has no parent
    findFirstResults[0] = { parentTaskId: null };
    // select[0]: dependent task has two deps
    // select[1]: one dep still pending
    selectWhereResults = [
      [{ id: 'dependent-1', dependsOn: ['task-1', 'other-id'], workspaceId: 'ws-1' }],
      [
        { id: 'task-1', status: 'completed' },
        { id: 'other-id', status: 'waiting' },
      ],
    ];

    await resolveCompletedTask('task-1', 'ws-1');

    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('fires TASK_UNBLOCKED for multiple dependent tasks', async () => {
    // findFirst[0]: task has no parent
    findFirstResults[0] = { parentTaskId: null };
    // select[0]: two tasks depend on the completed task
    // select[1]: fetch dep statuses
    selectWhereResults = [
      [
        { id: 'dependent-1', dependsOn: ['task-1'], workspaceId: 'ws-1' },
        { id: 'dependent-2', dependsOn: ['task-1'], workspaceId: 'ws-2' },
      ],
      [{ id: 'task-1', status: 'completed' }],
    ];

    await resolveCompletedTask('task-1', 'ws-1');

    expect(mockTriggerEvent).toHaveBeenCalledTimes(2);
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'workspace-ws-1',
      'task:unblocked',
      {
        taskId: 'dependent-1',
        resolvedDependency: 'task-1',
      }
    );
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'workspace-ws-2',
      'task:unblocked',
      {
        taskId: 'dependent-2',
        resolvedDependency: 'task-1',
      }
    );
  });
});

describe('task-dependencies aggregation', () => {
  beforeEach(resetMocks);

  it('creates aggregation task when planning parent children all complete', async () => {
    // findFirst[0]: completed task's parentTaskId
    findFirstResults[0] = { parentTaskId: 'parent-1' };
    // findFirst[1]: parent is planning mode (no mission)
    findFirstResults[1] = { id: 'parent-1', mode: 'planning', title: 'Plan feature X', workspaceId: 'ws-1', missionId: null };

    mockFindMany.mockResolvedValue([
      { id: 'child-1', status: 'completed', workspaceId: 'ws-1', title: 'Step 1', result: { summary: 'Done step 1' } },
      { id: 'child-2', status: 'completed', workspaceId: 'ws-1', title: 'Step 2', result: { summary: 'Done step 2' } },
    ]);

    // select[0]: no existing aggregation task
    // select[1]: no dependsOn tasks
    selectWhereResults = [[], []];

    await resolveCompletedTask('child-1', 'ws-1');

    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'workspace-ws-1',
      'task:children_completed',
      expect.objectContaining({ parentTaskId: 'parent-1' })
    );

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        title: 'Aggregate results: Plan feature X',
        mode: 'execution',
        parentTaskId: 'parent-1',
        status: 'pending',
      })
    );
  });

  it('does NOT create aggregation task for non-planning parent', async () => {
    findFirstResults[0] = { parentTaskId: 'parent-1' };
    findFirstResults[1] = { id: 'parent-1', mode: 'execution', title: 'Execute something', workspaceId: 'ws-1' };

    mockFindMany.mockResolvedValue([
      { id: 'child-1', status: 'completed', workspaceId: 'ws-1', title: 'Step 1', result: null },
    ]);

    // select[0]: no dependsOn tasks
    selectWhereResults = [[]];

    await resolveCompletedTask('child-1', 'ws-1');

    expect(mockTriggerEvent).toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('does NOT create duplicate aggregation task', async () => {
    findFirstResults[0] = { parentTaskId: 'parent-1' };
    findFirstResults[1] = { id: 'parent-1', mode: 'planning', title: 'Plan feature X', workspaceId: 'ws-1', missionId: null };

    mockFindMany.mockResolvedValue([
      { id: 'child-1', status: 'completed', workspaceId: 'ws-1', title: 'Step 1', result: null },
      { id: 'agg-1', status: 'completed', workspaceId: 'ws-1', title: 'Aggregate results: Plan feature X', result: null },
    ]);

    // select[0]: existing aggregation task found (recent, not stale)
    // select[1]: no dependsOn tasks
    selectWhereResults = [[{ id: 'agg-1', status: 'completed', createdAt: new Date() }], []];

    await resolveCompletedTask('child-1', 'ws-1');

    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('includes child results in aggregation context', async () => {
    findFirstResults[0] = { parentTaskId: 'parent-1' };
    findFirstResults[1] = { id: 'parent-1', mode: 'planning', title: 'Analyze data', workspaceId: 'ws-1', missionId: null };

    const childResults = [
      { id: 'c-1', status: 'completed', workspaceId: 'ws-1', title: 'Gather data', result: { summary: 'Collected 100 records' } },
      { id: 'c-2', status: 'failed', workspaceId: 'ws-1', title: 'Process data', result: null },
      { id: 'c-3', status: 'completed', workspaceId: 'ws-1', title: 'Validate data', result: { summary: 'All valid' } },
    ];

    mockFindMany.mockResolvedValue(childResults);

    // select[0]: no existing aggregation task
    // select[1]: no dependsOn tasks
    selectWhereResults = [[], []];

    await resolveCompletedTask('c-1', 'ws-1');

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          aggregation: true,
          parentTaskId: 'parent-1',
          childTasks: [
            { taskId: 'c-1', title: 'Gather data', status: 'completed', result: { summary: 'Collected 100 records' } },
            { taskId: 'c-2', title: 'Process data', status: 'failed', result: null },
            { taskId: 'c-3', title: 'Validate data', status: 'completed', result: { summary: 'All valid' } },
          ],
        },
      })
    );
  });

  it('cancels stale pending aggregator and creates a new one (multi-child)', async () => {
    findFirstResults[0] = { parentTaskId: 'parent-1' };
    findFirstResults[1] = { id: 'parent-1', mode: 'planning', title: 'Plan X', workspaceId: 'ws-1', missionId: null };

    mockFindMany.mockResolvedValue([
      { id: 'child-1', status: 'completed', workspaceId: 'ws-1', title: 'Step 1', result: null },
      { id: 'child-2', status: 'completed', workspaceId: 'ws-1', title: 'Step 2', result: null },
    ]);

    // select[0]: existing stale pending aggregator (created 2 hours ago)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    selectWhereResults = [
      [{ id: 'stale-agg', status: 'pending', createdAt: twoHoursAgo }],
      [], // no dependsOn tasks
    ];

    await resolveCompletedTask('child-1', 'ws-1');

    // Should cancel the stale aggregator
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).toHaveBeenCalledWith({ status: 'cancelled' });

    // Should create a new aggregation task
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Aggregate results: Plan X',
        status: 'pending',
      })
    );
  });

  it('skips aggregation for single-child planning tasks', async () => {
    findFirstResults[0] = { parentTaskId: 'parent-1' };
    findFirstResults[1] = { id: 'parent-1', mode: 'planning', title: 'Plan X', workspaceId: 'ws-1', missionId: 'mission-1' };

    missionsFindFirstResults[0] = { id: 'mission-1', status: 'active' };

    mockFindMany.mockResolvedValue([
      { id: 'child-1', status: 'completed', workspaceId: 'ws-1', title: 'Step 1', result: null },
    ]);

    selectWhereResults = [[], []];

    await resolveCompletedTask('child-1', 'ws-1');

    // Should NOT create aggregation task — single child, retrigger instead
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('does NOT cancel recent pending aggregator', async () => {
    findFirstResults[0] = { parentTaskId: 'parent-1' };
    findFirstResults[1] = { id: 'parent-1', mode: 'planning', title: 'Plan X', workspaceId: 'ws-1', missionId: null };

    mockFindMany.mockResolvedValue([
      { id: 'child-1', status: 'completed', workspaceId: 'ws-1', title: 'Step 1', result: null },
    ]);

    // select[0]: recent pending aggregator (created 10 minutes ago)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    selectWhereResults = [
      [{ id: 'recent-agg', status: 'pending', createdAt: tenMinutesAgo }],
      [], // no dependsOn tasks
    ];

    await resolveCompletedTask('child-1', 'ws-1');

    // Should NOT cancel or create
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('skips aggregation when mission is already completed', async () => {
    findFirstResults[0] = { parentTaskId: 'parent-1' };
    findFirstResults[1] = { id: 'parent-1', mode: 'planning', title: 'Plan X', workspaceId: 'ws-1', missionId: 'mission-1' };

    // Mission is completed
    missionsFindFirstResults[0] = { id: 'mission-1', status: 'completed' };

    mockFindMany.mockResolvedValue([
      { id: 'child-1', status: 'completed', workspaceId: 'ws-1', title: 'Step 1', result: null },
    ]);

    // select[0]: no dependsOn tasks (aggregation check is skipped, so only dependsOn select runs)
    selectWhereResults = [[]];

    await resolveCompletedTask('child-1', 'ws-1');

    // Should NOT create aggregation task
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('still creates aggregation when mission is active (multi-child)', async () => {
    findFirstResults[0] = { parentTaskId: 'parent-1' };
    findFirstResults[1] = { id: 'parent-1', mode: 'planning', title: 'Plan X', workspaceId: 'ws-1', missionId: 'mission-1' };

    // Mission is active
    missionsFindFirstResults[0] = { id: 'mission-1', status: 'active' };

    mockFindMany.mockResolvedValue([
      { id: 'child-1', status: 'completed', workspaceId: 'ws-1', title: 'Step 1', result: null },
      { id: 'child-2', status: 'completed', workspaceId: 'ws-1', title: 'Step 2', result: null },
    ]);

    // select[0]: no existing aggregation task
    // select[1]: no dependsOn tasks
    selectWhereResults = [[], []];

    await resolveCompletedTask('child-1', 'ws-1');

    expect(mockInsert).toHaveBeenCalledTimes(1);
  });
});

describe('dependency failure cascade', () => {
  beforeEach(resetMocks);

  it('cascades failure to dependent tasks when a dep fails', async () => {
    // findFirst[0]: failed task has no parent
    findFirstResults[0] = { parentTaskId: null };
    // findFirst[1]: task status is failed
    findFirstResults[1] = { mode: 'execution', missionId: null, status: 'failed' };
    // select[0]: one pending task depends on the failed task
    selectWhereResults = [
      [{ id: 'dependent-1', title: 'Phase 2', workspaceId: 'ws-1', status: 'pending' }],
    ];
    // findFirst[2]: failed task title for error message
    findFirstResults[2] = { title: 'Phase 1' };
    // Recursive call for auto-failed dependent-1:
    // findFirst[3]: dependent-1 has no parent
    findFirstResults[3] = { parentTaskId: null };
    // findFirst[4]: dependent-1 status (now failed)
    findFirstResults[4] = { mode: 'execution', missionId: null, status: 'failed' };
    // select[1]: no further dependents
    selectWhereResults[1] = [];

    await resolveCompletedTask('task-A', 'ws-1');

    // Should auto-fail the dependent task
    expect(mockUpdate).toHaveBeenCalled();
    // Should fire TASK_DEPENDENCY_FAILED event
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'workspace-ws-1',
      'task:dependency_failed',
      {
        taskId: 'dependent-1',
        failedDependency: 'task-A',
        failedDependencyTitle: 'Phase 1',
      }
    );
  });

  it('does NOT cascade to already-completed tasks', async () => {
    findFirstResults[0] = { parentTaskId: null };
    findFirstResults[1] = { mode: 'execution', missionId: null, status: 'failed' };
    // select[0]: no non-terminal tasks depend on it (completed tasks are filtered out by SQL)
    selectWhereResults = [[]];

    await resolveCompletedTask('task-A', 'ws-1');

    // No cascade, no events
    expect(mockTriggerEvent).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does NOT fire TASK_UNBLOCKED when a dep fails (only completed deps unblock)', async () => {
    // When a dep fails, we cascade failure — NOT unblock
    findFirstResults[0] = { parentTaskId: null };
    findFirstResults[1] = { mode: 'execution', missionId: null, status: 'failed' };
    // select[0]: dependent task exists
    selectWhereResults = [
      [{ id: 'dependent-1', title: 'Phase 2', workspaceId: 'ws-1', status: 'pending' }],
    ];
    findFirstResults[2] = { title: 'Phase 1' };
    // Recursive call mocks
    findFirstResults[3] = { parentTaskId: null };
    findFirstResults[4] = { mode: 'execution', missionId: null, status: 'failed' };
    selectWhereResults[1] = [];

    await resolveCompletedTask('task-A', 'ws-1');

    // TASK_DEPENDENCY_FAILED should fire, NOT TASK_UNBLOCKED
    const calls = mockTriggerEvent.mock.calls;
    const eventNames = calls.map((c: any) => c[1]);
    expect(eventNames).toContain('task:dependency_failed');
    expect(eventNames).not.toContain('task:unblocked');
  });
});
