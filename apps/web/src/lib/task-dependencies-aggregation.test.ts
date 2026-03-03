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

// Track findFirst calls to return different results
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

describe('task-dependencies aggregation', () => {
  beforeEach(() => {
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
  });

  it('creates aggregation task when planning parent children all complete', async () => {
    // First findFirst: get completed task's parentTaskId
    findFirstResults[0] = { parentTaskId: 'parent-1' };
    // Second findFirst: get parent task details (planning mode)
    findFirstResults[1] = { id: 'parent-1', mode: 'planning', title: 'Plan feature X', workspaceId: 'ws-1' };

    // findMany: all children in terminal state
    mockFindMany.mockResolvedValue([
      { id: 'child-1', status: 'completed', workspaceId: 'ws-1', title: 'Step 1', result: { summary: 'Done step 1' } },
      { id: 'child-2', status: 'completed', workspaceId: 'ws-1', title: 'Step 2', result: { summary: 'Done step 2' } },
    ]);

    // First select/where: check for dependsOn (no dependent tasks)
    // Second select/where: check for existing aggregation task (none)
    selectWhereResults = [[], []];

    await resolveCompletedTask('child-1', 'ws-1');

    // Should have fired CHILDREN_COMPLETED
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'workspace-ws-1',
      'task:children_completed',
      expect.objectContaining({ parentTaskId: 'parent-1' })
    );

    // Should have inserted an aggregation task
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        title: 'Aggregate results: Plan feature X',
        description: 'Synthesize the results from all completed sub-tasks into a final deliverable.',
        mode: 'execution',
        parentTaskId: 'parent-1',
        status: 'pending',
        creationSource: 'api',
        outputRequirement: 'artifact_required',
      })
    );
  });

  it('does NOT create aggregation task for non-planning parent', async () => {
    // First findFirst: get completed task's parentTaskId
    findFirstResults[0] = { parentTaskId: 'parent-1' };
    // Second findFirst: parent is execution mode
    findFirstResults[1] = { id: 'parent-1', mode: 'execution', title: 'Execute something', workspaceId: 'ws-1' };

    // findMany: all children in terminal state
    mockFindMany.mockResolvedValue([
      { id: 'child-1', status: 'completed', workspaceId: 'ws-1', title: 'Step 1', result: null },
    ]);

    // First select/where: dependsOn check (none)
    selectWhereResults = [[]];

    await resolveCompletedTask('child-1', 'ws-1');

    // Should have fired CHILDREN_COMPLETED
    expect(mockTriggerEvent).toHaveBeenCalled();

    // Should NOT have inserted an aggregation task
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('does NOT create duplicate aggregation task', async () => {
    // First findFirst: get completed task's parentTaskId
    findFirstResults[0] = { parentTaskId: 'parent-1' };
    // Second findFirst: parent is planning mode
    findFirstResults[1] = { id: 'parent-1', mode: 'planning', title: 'Plan feature X', workspaceId: 'ws-1' };

    // findMany: all children in terminal state
    mockFindMany.mockResolvedValue([
      { id: 'child-1', status: 'completed', workspaceId: 'ws-1', title: 'Step 1', result: null },
      { id: 'agg-1', status: 'completed', workspaceId: 'ws-1', title: 'Aggregate results: Plan feature X', result: null },
    ]);

    // First select/where: existing aggregation task found (from maybeCreateAggregationTask)
    // Second select/where: dependsOn check (none)
    selectWhereResults = [[{ id: 'agg-1' }], []];

    await resolveCompletedTask('child-1', 'ws-1');

    // Should NOT have inserted a new aggregation task
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('includes child results in aggregation context', async () => {
    // First findFirst: get completed task's parentTaskId
    findFirstResults[0] = { parentTaskId: 'parent-1' };
    // Second findFirst: parent is planning mode
    findFirstResults[1] = { id: 'parent-1', mode: 'planning', title: 'Analyze data', workspaceId: 'ws-1' };

    const childResults = [
      { id: 'c-1', status: 'completed', workspaceId: 'ws-1', title: 'Gather data', result: { summary: 'Collected 100 records' } },
      { id: 'c-2', status: 'failed', workspaceId: 'ws-1', title: 'Process data', result: null },
      { id: 'c-3', status: 'completed', workspaceId: 'ws-1', title: 'Validate data', result: { summary: 'All valid' } },
    ];

    mockFindMany.mockResolvedValue(childResults);

    // First select/where: dependsOn check (none)
    // Second select/where: no existing aggregation task
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
