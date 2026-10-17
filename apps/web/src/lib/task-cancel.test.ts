import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockWorkersFindFirst = mock(() => Promise.resolve(null as any));
const mockTriggerEvent = mock(() => Promise.resolve());
const mockReleaseAndNotify = mock(() => Promise.resolve());
const mockResolveCompletedTask = mock(() => Promise.resolve());

const mockTasksFindFirst = mock(() => Promise.resolve(null as any));
const mockWorkersFindMany = mock(() => Promise.resolve([] as any[]));
mock.module('@buildd/core/db', () => ({
  db: { query: { workers: { findFirst: mockWorkersFindFirst, findMany: mockWorkersFindMany }, tasks: { findFirst: mockTasksFindFirst } } },
}));
const mockSettle = mock((_taskId: string, _cause: string) => Promise.resolve(0));
mock.module('@/lib/sessionless-worker-settle', () => ({ settleSessionlessWorkersOfTask: mockSettle }));
const mockAttemptEnded = mock(async (_p: any, _c?: any) => ({ handled: true }));
mock.module('@/lib/workflow/seam', () => ({ attemptEnded: mockAttemptEnded }));
// T4 goes through the one client (AC-9): the kernel's door, not the seam.
const realKernelClient = await import('@/lib/workflow/kernel-client');
mock.module('@/lib/workflow/kernel-client', () => ({ ...realKernelClient, attemptEnded: mockAttemptEnded }));
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: {
    workspace: (id: string) => `workspace-${id}`,
    worker: (id: string) => `worker-${id}`,
  },
  events: { WORKER_COMMAND: 'worker:command', TASK_UPDATED: 'task:updated' },
}));
mock.module('@/lib/path-claim-release', () => ({ releaseAndNotify: mockReleaseAndNotify }));
mock.module('@/lib/task-dependencies', () => ({ resolveCompletedTask: mockResolveCompletedTask }));
const mockReopenCompletedMission = mock(() => Promise.resolve({ reopened: true }));
mock.module('@/lib/mission-loop', () => ({ reopenCompletedMission: mockReopenCompletedMission }));
const mockReconcileSubjectEvent = mock((..._args: any[]) => Promise.resolve({ cancelled: [], lostRace: [], decisions: [] }));
mock.module('@/lib/supersession', () => ({ reconcileSubjectEvent: mockReconcileSubjectEvent }));
mock.module('@/lib/mission-feed', () => ({
  systemActor: (label: string) => ({ kind: 'system', id: null, label }),
}));

const mockWakeTask = mock(async (_id: string, _cause: string) => {});
mock.module('@/lib/dispatch-authority', () => ({
  wakeTask: mockWakeTask,
  wakeTasks: async () => {},
  announceTaskCreated: async () => {},
  kickDispatch: () => {},
  enqueueTaskDispatch: async () => {},
  drainDispatchOutbox: async () => ({}),
  deliverTaskDispatch: async () => 'skipped:test',
  routeForCause: () => ({}),
  webhookWants: () => false,
  primaryCause: (_c: readonly string[], fallback: string) => fallback,
  reseedDispatchTimer: async () => {},
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
}));

import { applyTaskCancelSideEffects, applyTaskDeleteSideEffects, applyTaskReopenSideEffects, emitTaskUpdated } from './task-cancel';

const TASK = { id: 'task-1', workspaceId: 'ws-1', missionId: null };

describe('applyTaskCancelSideEffects', () => {
  beforeEach(() => {
    mockWorkersFindFirst.mockReset();
    mockWorkersFindFirst.mockResolvedValue(null);
    mockTasksFindFirst.mockReset();
    mockTasksFindFirst.mockResolvedValue(null);
    mockAttemptEnded.mockClear();
    mockTriggerEvent.mockReset();
    mockTriggerEvent.mockResolvedValue(undefined);
    mockReleaseAndNotify.mockReset();
    mockReleaseAndNotify.mockResolvedValue(undefined);
    mockResolveCompletedTask.mockReset();
    mockResolveCompletedTask.mockResolvedValue(undefined);
  });

  it('tells the kernel a cancelled fix attempt ended (lost), even with no live worker', async () => {
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', deliveryId: 'd1', deliveryRole: 'fix', context: { workflowAttemptId: 'a1' } });

    await applyTaskCancelSideEffects(TASK);

    expect(mockAttemptEnded).toHaveBeenCalledTimes(1);
    expect(mockAttemptEnded.mock.calls[0][0]).toMatchObject({
      task: { id: 'task-1', workspaceId: 'ws-1', deliveryId: 'd1', deliveryRole: 'fix' },
      status: 'lost',
      // 295486ba: says it is a cancel, so a CI repair nobody claimed spends nothing.
      cancelled: true,
      source: 'cancel',
    });
    // Through the kernel client (AC-9): the control plane applies it in own mode.
    expect(mockAttemptEnded.mock.calls[0][1]).toEqual({ principal: { kind: 'system', id: 'system:task_cancel' } });
  });

  it('a cancelled review round is a takeover, not an infra failure the kernel re-files', async () => {
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', deliveryId: 'd1', deliveryRole: 'review', context: { workflowRoundId: 'r1' } });

    await applyTaskCancelSideEffects(TASK);

    expect(mockAttemptEnded.mock.calls[0][0]).toMatchObject({ source: 'cancel', reviewFailure: 'human_takeover' });
  });

  it('leaves reviewFailure off a cancelled non-review attempt', async () => {
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', deliveryId: 'd1', deliveryRole: 'fix', context: {} });

    await applyTaskCancelSideEffects(TASK);

    expect(mockAttemptEnded.mock.calls[0][0].reviewFailure).toBeUndefined();
  });

  it('does not touch the kernel for a task with no delivery', async () => {
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', deliveryId: null, deliveryRole: null, context: {} });
    await applyTaskCancelSideEffects(TASK);
    expect(mockAttemptEnded).not.toHaveBeenCalled();
  });

  it('settles a worker parked on a question: no session is left to report its end', async () => {
    mockSettle.mockClear();
    await applyTaskCancelSideEffects(TASK);
    expect(mockSettle).toHaveBeenCalledWith('task-1', 'task_cancelled');
  });

  it('aborts an active worker, releases claims, resolves and emits TASK_UPDATED', async () => {
    mockWorkersFindFirst.mockResolvedValue({ id: 'w-9' });

    await applyTaskCancelSideEffects(TASK);

    expect(mockTriggerEvent).toHaveBeenCalledWith(
      'worker-w-9',
      'worker:command',
      expect.objectContaining({ action: 'abort', reason: 'task_cancelled' }),
    );
    expect(mockReleaseAndNotify).toHaveBeenCalledWith('task-1', 'abandoned');
    expect(mockResolveCompletedTask).toHaveBeenCalledWith('task-1', 'ws-1');
    expect(mockTriggerEvent).toHaveBeenCalledWith('workspace-ws-1', 'task:updated', {
      task: { id: 'task-1', status: 'cancelled', workspaceId: 'ws-1', missionId: null },
    });
  });

  it('fires the supersession cancelled event so the task\'s open retries go with it', async () => {
    mockReconcileSubjectEvent.mockClear();
    await applyTaskCancelSideEffects(TASK);
    expect(mockReconcileSubjectEvent).toHaveBeenCalledTimes(1);
    expect(mockReconcileSubjectEvent.mock.calls[0][0]).toMatchObject({ kind: 'cancelled', workspaceId: 'ws-1', taskId: 'task-1' });
  });

  it('resolves tasks without a missionId too (not only mission tasks)', async () => {
    await applyTaskCancelSideEffects({ ...TASK, missionId: null });
    expect(mockResolveCompletedTask).toHaveBeenCalledTimes(1);
  });

  it('sends no abort when there is no active worker', async () => {
    await applyTaskCancelSideEffects(TASK);
    const commands = mockTriggerEvent.mock.calls.filter((c: any[]) => c[1] === 'worker:command');
    expect(commands).toHaveLength(0);
  });

  it('one failing side effect does not stop the others or throw', async () => {
    mockReleaseAndNotify.mockRejectedValue(new Error('db down'));
    mockWorkersFindFirst.mockRejectedValue(new Error('db down'));

    await expect(applyTaskCancelSideEffects(TASK)).resolves.toBeUndefined();
    expect(mockResolveCompletedTask).toHaveBeenCalled();
    expect(mockTriggerEvent).toHaveBeenCalledWith('workspace-ws-1', 'task:updated', expect.anything());
  });
});

describe('emitTaskUpdated', () => {
  it('never throws when the push fails', async () => {
    mockTriggerEvent.mockRejectedValue(new Error('pusher down'));
    await expect(
      emitTaskUpdated({ ...TASK, status: 'completed' }),
    ).resolves.toBeUndefined();
  });
});

describe('applyTaskReopenSideEffects', () => {
  beforeEach(() => {
    mockTriggerEvent.mockReset();
    mockTriggerEvent.mockResolvedValue(undefined);
    mockReopenCompletedMission.mockReset();
    mockReopenCompletedMission.mockResolvedValue({ reopened: true });
    mockWakeTask.mockReset();
    mockWakeTask.mockResolvedValue(undefined);
  });

  // Reopened tasks used to sit until a runner polled: TASK_UPDATED is a
  // dashboard event, not a wake.
  it('wakes the reopened task as task.requeued, with or without a mission', async () => {
    await applyTaskReopenSideEffects(TASK, 'github issue reopened');
    expect(mockWakeTask).toHaveBeenCalledWith('task-1', 'task.requeued');
    await applyTaskReopenSideEffects({ ...TASK, missionId: 'm-1' }, 'github issue reopened');
    expect(mockWakeTask).toHaveBeenCalledTimes(2);
  });

  it('a failed wake does not stop the mission reopen', async () => {
    mockWakeTask.mockRejectedValue(new Error('db blip'));
    await applyTaskReopenSideEffects({ ...TASK, missionId: 'm-1' }, 'x');
    expect(mockReopenCompletedMission).toHaveBeenCalled();
  });

  it('emits TASK_UPDATED pending and reopens the mission', async () => {
    await applyTaskReopenSideEffects({ ...TASK, missionId: 'm-1' }, 'github issue reopened');
    expect(mockTriggerEvent).toHaveBeenCalledWith('workspace-ws-1', 'task:updated', {
      task: { id: 'task-1', status: 'pending', workspaceId: 'ws-1', missionId: 'm-1' },
    });
    expect(mockReopenCompletedMission).toHaveBeenCalledWith(
      'm-1',
      { kind: 'system', id: null, label: 'github issue reopened' },
    );
  });

  it('skips the mission reopen when the task has no mission', async () => {
    await applyTaskReopenSideEffects(TASK, 'x');
    expect(mockReopenCompletedMission).not.toHaveBeenCalled();
  });
});

describe('applyTaskDeleteSideEffects', () => {
  beforeEach(() => {
    mockSettle.mockReset();
    mockSettle.mockResolvedValue(1);
    mockWorkersFindMany.mockReset();
    mockWorkersFindMany.mockResolvedValue([]);
    mockTriggerEvent.mockReset();
    mockTriggerEvent.mockResolvedValue(undefined);
    mockReleaseAndNotify.mockReset();
    mockReleaseAndNotify.mockResolvedValue(undefined);
  });

  it('settles parked workers, aborts live sessions and releases claims before the row goes', async () => {
    mockWorkersFindMany.mockResolvedValue([{ id: 'w-live' }]);
    await applyTaskDeleteSideEffects('task-1');
    expect(mockSettle).toHaveBeenCalledWith('task-1', 'task_deleted');
    expect(mockTriggerEvent).toHaveBeenCalledWith('worker-w-live', 'worker:command', expect.objectContaining({ action: 'abort' }));
    expect(mockReleaseAndNotify).toHaveBeenCalledWith('task-1', 'abandoned');
  });

  it('never throws: a failed settle still releases the claims', async () => {
    mockSettle.mockRejectedValue(new Error('db down'));
    await applyTaskDeleteSideEffects('task-1');
    expect(mockReleaseAndNotify).toHaveBeenCalledWith('task-1', 'abandoned');
  });
});
