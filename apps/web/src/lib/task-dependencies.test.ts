import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mock functions
const mockFindFirst = mock(() => null as any);
const mockFindMany = mock(() => [] as any);
const mockSelect = mock();
const mockFrom = mock();
const mockWhere = mock(() => [] as any);

// Track chained select calls to return different results
let selectCallCount = 0;
let selectWhereResults: any[][] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: {
        findFirst: mockFindFirst,
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

describe('task-dependencies', () => {
  beforeEach(() => {
    mockFindFirst.mockReset();
    mockFindMany.mockReset();
    mockSelect.mockReset();
    mockFrom.mockReset();
    mockWhere.mockReset();
    mockTriggerEvent.mockReset();
    selectCallCount = 0;
    selectWhereResults = [];
  });

  it('does nothing when task has no parent and nothing depends on it', async () => {
    // Task has no parentTaskId
    mockFindFirst.mockResolvedValue({ parentTaskId: null });
    // No tasks depend on it
    selectWhereResults = [[]];

    await resolveCompletedTask('task-1', 'ws-1');

    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('fires CHILDREN_COMPLETED when all siblings done', async () => {
    // Task has a parent
    mockFindFirst.mockResolvedValue({ parentTaskId: 'parent-1' });
    // All children of that parent are in terminal state
    mockFindMany.mockResolvedValue([
      { id: 'task-1', status: 'completed', workspaceId: 'ws-1' },
      { id: 'task-2', status: 'failed', workspaceId: 'ws-1' },
      { id: 'task-3', status: 'completed', workspaceId: 'ws-1' },
    ]);
    // No tasks depend on it
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
    // Task has a parent
    mockFindFirst.mockResolvedValue({ parentTaskId: 'parent-1' });
    // Some children are not in terminal state
    mockFindMany.mockResolvedValue([
      { id: 'task-1', status: 'completed', workspaceId: 'ws-1' },
      { id: 'task-2', status: 'waiting', workspaceId: 'ws-1' },
      { id: 'task-3', status: 'in_progress', workspaceId: 'ws-1' },
    ]);
    // No tasks depend on it
    selectWhereResults = [[]];

    await resolveCompletedTask('task-1', 'ws-1');

    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('fires TASK_UNBLOCKED when completing a dependency', async () => {
    // Task has no parent
    mockFindFirst.mockResolvedValue({ parentTaskId: null });
    // One task depends on the completed task, and it's the only dep
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
    // Task has no parent
    mockFindFirst.mockResolvedValue({ parentTaskId: null });
    // Dependent task has two deps, one still pending
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
    // Task has no parent
    mockFindFirst.mockResolvedValue({ parentTaskId: null });
    // Two tasks depend on the completed task
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
