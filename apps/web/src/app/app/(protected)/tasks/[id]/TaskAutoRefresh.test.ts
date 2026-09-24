import { describe, test, expect } from 'bun:test';
import { computeIsTerminalLeaf, createEventHandlers } from './TaskAutoRefresh';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('computeIsTerminalLeaf', () => {
  test('failed task is always terminal', () => {
    expect(computeIsTerminalLeaf('failed', 'normal', false, false)).toBe(true);
    expect(computeIsTerminalLeaf('failed', 'planning', true, true)).toBe(true);
  });

  test('completed non-planning leaf with no open PR is terminal', () => {
    expect(computeIsTerminalLeaf('completed', 'normal', false, false)).toBe(true);
  });

  test('completed task with open PR is NOT terminal — stays subscribed for CI updates', () => {
    expect(computeIsTerminalLeaf('completed', 'normal', false, true)).toBe(false);
  });

  test('completed planning task is NOT terminal (planning can have subtasks)', () => {
    expect(computeIsTerminalLeaf('completed', 'planning', false, false)).toBe(false);
  });

  test('completed task with subtasks is NOT terminal', () => {
    expect(computeIsTerminalLeaf('completed', 'normal', true, false)).toBe(false);
  });

  test('completed task with subtasks AND open PR is NOT terminal', () => {
    expect(computeIsTerminalLeaf('completed', 'normal', true, true)).toBe(false);
  });

  test('pending task is NOT terminal', () => {
    expect(computeIsTerminalLeaf('pending', 'normal', false, false)).toBe(false);
  });

  test('running task is NOT terminal', () => {
    expect(computeIsTerminalLeaf('running', 'normal', false, false)).toBe(false);
  });
});

describe('createEventHandlers', () => {
  function mockRouter() {
    const calls: number[] = [];
    return { router: { refresh: () => calls.push(Date.now()) }, calls };
  }

  test('worker:progress is debounced — it does not refresh synchronously', () => {
    const { router, calls } = mockRouter();
    const handlers = createEventHandlers(router, 'task-progress', []);
    handlers.handleWorkerEvent({ taskId: 'task-progress' });
    expect(calls.length).toBe(0);
  });

  test('worker:progress + worker:completed for one taskId end up as a single refresh, not two', async () => {
    const { router, calls } = mockRouter();
    const handlers = createEventHandlers(router, 'task-mixed', []);
    handlers.handleWorkerEvent({ taskId: 'task-mixed' }); // debounced worker:progress
    handlers.handleWorkerTerminal({ taskId: 'task-mixed' }); // worker:completed — flushes immediately
    expect(calls.length).toBe(1);
    // the earlier debounced progress call must have been cleared by the flush,
    // not left to fire a second refresh later
    await sleep(2100);
    expect(calls.length).toBe(1);
  }, 10000);

  test('worker:completed/failed refresh immediately (terminal — status transition)', () => {
    const { router, calls } = mockRouter();
    const handlers = createEventHandlers(router, 'task-terminal', []);
    handlers.handleWorkerTerminal({ taskId: 'task-terminal' });
    expect(calls.length).toBe(1);
  });

  test('task:claimed, task:unblocked, task:children_completed, task:updated all refresh immediately', () => {
    const { router, calls } = mockRouter();
    const handlers = createEventHandlers(router, 'task-transitions', []);
    handlers.handleClaimed({ task: { id: 'task-transitions' } });
    handlers.handleTaskUnblocked({ taskId: 'task-transitions', resolvedDependency: 'dep-1' });
    handlers.handleChildrenCompleted({ parentTaskId: 'task-transitions', childCount: 1, completed: 1, failed: 0 });
    handlers.handleTaskUpdated({ task: { id: 'task-transitions' } });
    expect(calls.length).toBe(4);
  });

  test('a mismatched taskId is ignored on every handler', () => {
    const { router, calls } = mockRouter();
    const handlers = createEventHandlers(router, 'task-mine', []);
    handlers.handleClaimed({ task: { id: 'task-other' } });
    handlers.handleWorkerEvent({ taskId: 'task-other' });
    handlers.handleWorkerTerminal({ taskId: 'task-other' });
    handlers.handleTaskUnblocked({ taskId: 'task-other', resolvedDependency: 'dep-1' });
    handlers.handleTaskUpdated({ task: { id: 'task-other' } });
    expect(calls.length).toBe(0);
  });

  test('handleTaskCompleted/handleTaskFailed only refresh for a listed dependency', () => {
    const { router, calls } = mockRouter();
    const handlers = createEventHandlers(router, 'task-dependent', ['dep-a', 'dep-b']);
    handlers.handleTaskCompleted({ taskId: 'dep-a' });
    handlers.handleTaskFailed({ taskId: 'unrelated' });
    expect(calls.length).toBe(1);
  });
});
