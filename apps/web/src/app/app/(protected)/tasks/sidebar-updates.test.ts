import { describe, test, expect } from 'bun:test';

/**
 * Tests for sidebar task update logic.
 * Validates that:
 * 1. updatedAt only changes on actual status transitions (not every progress tick)
 * 2. Tasks maintain stable sort order during repeated same-status updates
 */

interface Task {
  id: string;
  title: string;
  status: string;
  updatedAt: Date;
  waitingFor?: { type: string; prompt: string; options?: string[] } | null;
}

interface Workspace {
  id: string;
  name: string;
  tasks: Task[];
}

interface WorkerUpdate {
  id: string;
  taskId: string | null;
  status: string;
  workspaceId: string;
  waitingFor?: { type: string; prompt: string; options?: string[] } | null;
}

// Extracted from WorkspaceSidebar.tsx — the core update logic
function applyWorkerUpdate(workspaces: Workspace[], worker: WorkerUpdate): Workspace[] {
  if (!worker.taskId) return workspaces;

  const taskStatus = worker.status === 'completed' ? 'completed'
    : worker.status === 'failed' ? 'failed'
      : worker.status === 'waiting_input' ? 'waiting_input'
        : worker.status === 'running' ? 'running'
          : 'assigned';

  const waitingFor = worker.status === 'waiting_input' ? worker.waitingFor : null;

  return workspaces.map(ws => ({
    ...ws,
    tasks: ws.tasks.map(task => {
      if (task.id !== worker.taskId) return task;
      const isTerminal = task.status === 'completed' || task.status === 'failed';
      if (isTerminal && taskStatus !== 'completed' && taskStatus !== 'failed') return task;
      const statusChanged = task.status !== taskStatus;
      return {
        ...task,
        status: taskStatus,
        updatedAt: statusChanged ? new Date() : task.updatedAt,
        waitingFor,
      };
    })
  }));
}

function getStatusPriority(status: string): number {
  switch (status) {
    case 'running':
    case 'assigned':
    case 'waiting_input':
      return 0;
    case 'pending':
    case 'failed':
      return 2;
    case 'completed':
      return 3;
    default:
      return 4;
  }
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const priorityDiff = getStatusPriority(a.status) - getStatusPriority(b.status);
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

describe('sidebar task updates', () => {
  const baseTime = new Date('2025-01-01T00:00:00Z');

  function makeWorkspaces(tasks: Task[]): Workspace[] {
    return [{ id: 'ws-1', name: 'Test', tasks }];
  }

  test('updatedAt does NOT change on repeated same-status progress events', () => {
    const originalUpdatedAt = new Date('2025-01-01T10:00:00Z');
    const workspaces = makeWorkspaces([
      { id: 'task-1', title: 'Task 1', status: 'running', updatedAt: originalUpdatedAt },
    ]);

    // Simulate 5 rapid progress events with the same "running" status
    let result = workspaces;
    for (let i = 0; i < 5; i++) {
      result = applyWorkerUpdate(result, {
        id: 'w-1',
        taskId: 'task-1',
        status: 'running',
        workspaceId: 'ws-1',
      });
    }

    // updatedAt should remain unchanged since status didn't change
    expect(result[0].tasks[0].updatedAt.getTime()).toBe(originalUpdatedAt.getTime());
  });

  test('updatedAt DOES change on actual status transition', () => {
    const originalUpdatedAt = new Date('2025-01-01T10:00:00Z');
    const workspaces = makeWorkspaces([
      { id: 'task-1', title: 'Task 1', status: 'pending', updatedAt: originalUpdatedAt },
    ]);

    const result = applyWorkerUpdate(workspaces, {
      id: 'w-1',
      taskId: 'task-1',
      status: 'running',
      workspaceId: 'ws-1',
    });

    // updatedAt should be updated since status changed from pending to running
    expect(result[0].tasks[0].updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
    expect(result[0].tasks[0].status).toBe('running');
  });

  test('sort order remains stable during repeated progress events for same-status tasks', () => {
    const tasks: Task[] = [
      { id: 'task-1', title: 'First', status: 'running', updatedAt: new Date('2025-01-01T10:00:00Z') },
      { id: 'task-2', title: 'Second', status: 'running', updatedAt: new Date('2025-01-01T09:00:00Z') },
      { id: 'task-3', title: 'Third', status: 'running', updatedAt: new Date('2025-01-01T08:00:00Z') },
    ];
    let workspaces = makeWorkspaces(tasks);

    // Fire many progress events on task-3 (the one sorted last)
    for (let i = 0; i < 10; i++) {
      workspaces = applyWorkerUpdate(workspaces, {
        id: 'w-3',
        taskId: 'task-3',
        status: 'running',
        workspaceId: 'ws-1',
      });
    }

    // Sort and verify order is stable - task-3 should NOT jump to the top
    const sorted = sortTasks(workspaces[0].tasks);
    expect(sorted[0].id).toBe('task-1'); // Most recently updated
    expect(sorted[1].id).toBe('task-2');
    expect(sorted[2].id).toBe('task-3'); // Should stay at bottom
  });

  test('terminal task states are not overridden by active worker events', () => {
    const workspaces = makeWorkspaces([
      { id: 'task-1', title: 'Done', status: 'completed', updatedAt: baseTime },
    ]);

    const result = applyWorkerUpdate(workspaces, {
      id: 'w-1',
      taskId: 'task-1',
      status: 'running',
      workspaceId: 'ws-1',
    });

    expect(result[0].tasks[0].status).toBe('completed');
    expect(result[0].tasks[0].updatedAt.getTime()).toBe(baseTime.getTime());
  });

  test('status transition from running to waiting_input updates correctly', () => {
    const originalUpdatedAt = new Date('2025-01-01T10:00:00Z');
    const workspaces = makeWorkspaces([
      { id: 'task-1', title: 'Task 1', status: 'running', updatedAt: originalUpdatedAt },
    ]);

    const result = applyWorkerUpdate(workspaces, {
      id: 'w-1',
      taskId: 'task-1',
      status: 'waiting_input',
      workspaceId: 'ws-1',
      waitingFor: { type: 'question', prompt: 'Need help?' },
    });

    expect(result[0].tasks[0].status).toBe('waiting_input');
    expect(result[0].tasks[0].waitingFor?.prompt).toBe('Need help?');
    // updatedAt should change because status changed
    expect(result[0].tasks[0].updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
  });

  test('unrelated tasks are not affected by worker updates', () => {
    const time1 = new Date('2025-01-01T10:00:00Z');
    const time2 = new Date('2025-01-01T09:00:00Z');
    const workspaces = makeWorkspaces([
      { id: 'task-1', title: 'Target', status: 'running', updatedAt: time1 },
      { id: 'task-2', title: 'Other', status: 'pending', updatedAt: time2 },
    ]);

    const result = applyWorkerUpdate(workspaces, {
      id: 'w-1',
      taskId: 'task-1',
      status: 'running',
      workspaceId: 'ws-1',
    });

    // task-2 should be completely untouched
    expect(result[0].tasks[1].updatedAt.getTime()).toBe(time2.getTime());
    expect(result[0].tasks[1].status).toBe('pending');
  });
});
