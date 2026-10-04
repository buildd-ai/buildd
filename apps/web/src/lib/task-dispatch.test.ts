import { describe, it, expect, mock, beforeEach } from 'bun:test';

// The deprecated compat wrappers only label a cause and hand it to the
// dispatch authority. Delivery policy per cause is tested in
// dispatch-authority.test.ts; the primitives in task-dispatch-delivery.test.ts.

const mockWakeTask = mock(async (..._args: unknown[]) => {});
const mockAnnounce = mock(async (..._args: unknown[]) => {});
mock.module('@/lib/dispatch-authority', () => ({
  wakeTask: mockWakeTask,
  wakeTasks: mock(async () => {}),
  announceTaskCreated: mockAnnounce,
  enqueueTaskDispatch: mock(async () => {}),
  kickDispatch: mock(() => {}),
  drainDispatchOutbox: mock(async () => ({ claimed: 0, delivered: 0, skipped: 0, failed: 0 })),
  deliverTaskDispatch: mock(async () => 'pusher'),
  reseedDispatchTimer: mock(async () => {}),
  primaryCause: mock(() => 'task.created'),
  routeForCause: mock(() => ({})),
  webhookWants: mock(() => false),
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
}));
mock.module('@buildd/core/db', () => ({ db: { query: {} } }));
mock.module('@/lib/github', () => ({ dispatchToGitHubActions: mock(async () => true), isGitHubAppConfigured: () => false }));

import {
  dispatchNewTask,
  dispatchPlanChildTask,
  dispatchRetriedTask,
  dispatchUnblockedTask,
} from './task-dispatch';

const TASK = { id: 'task-1', title: 'T', description: null, workspaceId: 'ws-1' };
const WS = { name: 'ws' };

beforeEach(() => {
  mockWakeTask.mockClear();
  mockAnnounce.mockClear();
});

describe('dispatchNewTask', () => {
  it('announces to the dashboard, then wakes with task.created', async () => {
    await dispatchNewTask(TASK, WS);
    expect(mockAnnounce).toHaveBeenCalledWith(TASK, WS);
    expect(mockWakeTask).toHaveBeenCalledWith('task-1', 'task.created', { targetLocalUiUrl: undefined });
  });

  it('carries a targeted local runner and an explicit cause', async () => {
    await dispatchNewTask(TASK, WS, { assignToLocalUiUrl: 'http://x', cause: 'review.fix_requested' });
    expect(mockWakeTask).toHaveBeenCalledWith('task-1', 'review.fix_requested', { targetLocalUiUrl: 'http://x' });
  });
});

describe('dispatchUnblockedTask', () => {
  it('maps the legacy event option to a cause', async () => {
    await dispatchUnblockedTask(TASK, WS);
    await dispatchUnblockedTask(TASK, WS, { event: 'task.unblocked' });
    await dispatchUnblockedTask(TASK, WS, { event: 'task.retry' });
    await dispatchUnblockedTask(TASK, WS, { event: 'task.created' });
    expect(mockWakeTask.mock.calls.map(c => c[1])).toEqual([
      'dependency.satisfied', 'dependency.satisfied', 'manual.start', 'plan_child.ready',
    ]);
  });

  it('an explicit cause wins over the event', async () => {
    await dispatchUnblockedTask(TASK, WS, { event: 'task.retry', cause: 'path_claim.released' });
    expect(mockWakeTask).toHaveBeenCalledWith('task-1', 'path_claim.released');
  });

  it('never announces: the task already exists on the dashboard', async () => {
    await dispatchUnblockedTask(TASK, WS);
    expect(mockAnnounce).not.toHaveBeenCalled();
  });
});

describe('dispatchRetriedTask', () => {
  it('wakes with task.requeued by default, or the given cause', async () => {
    await dispatchRetriedTask(TASK, WS);
    await dispatchRetriedTask(TASK, WS, { cause: 'task.reassigned' });
    expect(mockWakeTask.mock.calls.map(c => c[1])).toEqual(['task.requeued', 'task.reassigned']);
    expect(mockAnnounce).not.toHaveBeenCalled();
  });
});

describe('dispatchPlanChildTask', () => {
  it('wakes with plan_child.ready', async () => {
    await dispatchPlanChildTask(TASK, WS);
    expect(mockWakeTask).toHaveBeenCalledWith('task-1', 'plan_child.ready');
    expect(mockAnnounce).not.toHaveBeenCalled();
  });
});
