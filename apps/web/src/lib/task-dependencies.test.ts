import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mock functions
const mockFindFirst = mock(() => null as any);
const mockFindMany = mock(() => [] as any);
const mockSelect = mock();
const mockFrom = mock();
const mockWhere = mock(() => [] as any);
const mockInsertValues = mock(() => Promise.resolve());
const mockInsert = mock();

// Track chained select calls to return different results
let selectCallCount = 0;
let selectWhereResults: any[][] = [];

// Track findFirst calls to return different results per call
let findFirstCallCount = 0;
let findFirstResults: any[] = [];

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
  },
}));

const mockTriggerEvent = mock(() => Promise.resolve());
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: {
    CHILDREN_COMPLETED: 'task:children_completed',
    TASK_UNBLOCKED: 'task:unblocked',
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
  selectCallCount = 0;
  selectWhereResults = [];
  findFirstCallCount = 0;
  findFirstResults = [];
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
    // findFirst[1]: parent is planning mode
    findFirstResults[1] = { id: 'parent-1', mode: 'planning', title: 'Plan feature X', workspaceId: 'ws-1' };

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
    findFirstResults[1] = { id: 'parent-1', mode: 'planning', title: 'Plan feature X', workspaceId: 'ws-1' };

    mockFindMany.mockResolvedValue([
      { id: 'child-1', status: 'completed', workspaceId: 'ws-1', title: 'Step 1', result: null },
      { id: 'agg-1', status: 'completed', workspaceId: 'ws-1', title: 'Aggregate results: Plan feature X', result: null },
    ]);

    // select[0]: existing aggregation task found
    // select[1]: no dependsOn tasks
    selectWhereResults = [[{ id: 'agg-1' }], []];

    await resolveCompletedTask('child-1', 'ws-1');

    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('includes child results in aggregation context', async () => {
    findFirstResults[0] = { parentTaskId: 'parent-1' };
    findFirstResults[1] = { id: 'parent-1', mode: 'planning', title: 'Analyze data', workspaceId: 'ws-1' };

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
});
