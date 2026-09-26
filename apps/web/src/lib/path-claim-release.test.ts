/**
 * releaseAndNotify must tell the waiting AGENT, not just the workspace channel.
 *
 * `path_released` is the one message in the system that changes what a running
 * agent should do next ("the file you were blocked on is free — rebase, your
 * base moved"). It had no producer: releaseAndNotify stamped notifiedAt and
 * fired a Pusher event on the workspace channel, which no runner subscribes to
 * (the runner only joins worker-<id> channels) and no web client handles. The
 * MCP check_path_claim response nonetheless promises the agent that this event
 * will reach it.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockReleaseClaims = mock(async (_taskId: string) => null as any);
const mockTriggerEvent = mock(async () => {});
const mockEnqueue = mock(async () => true);
const mockRearm = mock(async () => {});
const mockWorkersFindMany = mock(async () => [] as any[]);
const mockTasksFindFirst = mock(async () => null as any);

mock.module('@buildd/core/path-claim', () => ({
  releaseClaims: mockReleaseClaims,
  rearmWaiter: mockRearm,
}));
mock.module('@buildd/core/worker-messages', () => ({
  enqueueWorkerMessage: mockEnqueue,
  buildWorkerMessage: (input: any) => ({
    id: 'generated-id',
    sentAt: '2026-09-04T12:00:00.000Z',
    hopCount: 0,
    ...input,
  }),
  WORKER_MESSAGE_CAP: 3,
}));
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { workspace: (id: string) => `workspace-${id}` },
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: (...args: any[]) => mockWorkersFindMany(...args) },
      tasks: { findFirst: (...args: any[]) => mockTasksFindFirst(...args) },
    },
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  workers: { taskId: 'task_id', mergedAt: 'merged_at', prLifecycleStatus: 'pr_lifecycle_status', prNumber: 'pr_number' },
  tasks: { id: 'id', status: 'status' },
}));
mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
}));

const { releaseAndNotify, resolveReleaseReasonForTask } = await import('./path-claim-release');

const WS = 'ws-1';
const HOLDER = 'task-holder';
const WAITER_A = 'task-waiter-a';
const WAITER_B = 'task-waiter-b';

beforeEach(() => {
  mockReleaseClaims.mockReset();
  mockTriggerEvent.mockClear();
  mockEnqueue.mockClear();
  mockRearm.mockClear();
  mockEnqueue.mockImplementation(async () => true);
  mockWorkersFindMany.mockReset();
  mockWorkersFindMany.mockResolvedValue([]);
  mockTasksFindFirst.mockReset();
  mockTasksFindFirst.mockResolvedValue(null);
});

describe('releaseAndNotify', () => {
  it('enqueues a path_released message for each notified waiter', async () => {
    mockReleaseClaims.mockResolvedValue({
      workspaceId: WS,
      releasedPaths: ['packages/core/db/schema.ts', 'apps/web/src/lib/foo.ts'],
      notifiedWaiters: [WAITER_A, WAITER_B],
      waiters: [
        { waitingTaskId: WAITER_A, blockedPath: 'packages/core/db/schema.ts' },
        { waitingTaskId: WAITER_B, blockedPath: 'apps/web/src/lib/foo.ts' },
      ],
    });

    await releaseAndNotify(HOLDER, 'merged');

    expect(mockEnqueue).toHaveBeenCalledTimes(2);
    const [taskA, msgA] = mockEnqueue.mock.calls[0] as any[];
    expect(taskA).toBe(WAITER_A);
    expect(msgA.type).toBe('path_released');
    expect(msgA.fromTaskId).toBe(HOLDER);
    expect(msgA.toTaskId).toBe(WAITER_A);
    expect(msgA.body.paths).toEqual(['packages/core/db/schema.ts']);
    expect(typeof msgA.body.releasedAt).toBe('string');

    const [taskB, msgB] = mockEnqueue.mock.calls[1] as any[];
    expect(taskB).toBe(WAITER_B);
    expect(msgB.body.paths).toEqual(['apps/web/src/lib/foo.ts']);
  });

  it('groups multiple blocked paths for the same waiter into one message', async () => {
    mockReleaseClaims.mockResolvedValue({
      workspaceId: WS,
      releasedPaths: ['a.ts', 'b.ts'],
      notifiedWaiters: [WAITER_A, WAITER_A],
      waiters: [
        { waitingTaskId: WAITER_A, blockedPath: 'a.ts' },
        { waitingTaskId: WAITER_A, blockedPath: 'b.ts' },
      ],
    });

    await releaseAndNotify(HOLDER, 'merged');

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const [, msg] = mockEnqueue.mock.calls[0] as any[];
    expect(msg.body.paths).toEqual(['a.ts', 'b.ts']);
  });

  it('still fires the workspace Pusher event', async () => {
    mockReleaseClaims.mockResolvedValue({
      workspaceId: WS,
      releasedPaths: ['a.ts'],
      notifiedWaiters: [WAITER_A],
      waiters: [{ waitingTaskId: WAITER_A, blockedPath: 'a.ts' }],
    });

    await releaseAndNotify(HOLDER, 'merged');

    const evt = mockTriggerEvent.mock.calls.find((c: any[]) => c[1] === 'path_claim_released');
    expect(evt).toBeDefined();
    expect((evt as any[])[2].waitingTaskIds).toEqual([WAITER_A]);
  });

  it('enqueues nothing when there are no waiters', async () => {
    mockReleaseClaims.mockResolvedValue({
      workspaceId: WS,
      releasedPaths: ['a.ts'],
      notifiedWaiters: [],
      waiters: [],
    });

    await releaseAndNotify(HOLDER, 'merged');

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('does nothing when the task held no claims', async () => {
    mockReleaseClaims.mockResolvedValue(null);
    await releaseAndNotify(HOLDER, 'merged');
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockTriggerEvent).not.toHaveBeenCalled();
  });

  it('a failed enqueue re-arms that waiter and does not stop the others', async () => {
    mockReleaseClaims.mockResolvedValue({
      workspaceId: WS,
      releasedPaths: ['a.ts', 'b.ts'],
      notifiedWaiters: [WAITER_A, WAITER_B],
      waiters: [
        { waitingTaskId: WAITER_A, blockedPath: 'a.ts' },
        { waitingTaskId: WAITER_B, blockedPath: 'b.ts' },
      ],
    });
    mockEnqueue.mockImplementationOnce(async () => { throw new Error('db down'); });

    await releaseAndNotify(HOLDER, 'merged');

    expect(mockEnqueue).toHaveBeenCalledTimes(2);
    expect(mockTriggerEvent).toHaveBeenCalled();
    // Without this the waiter is stranded for good: releaseClaims already
    // stamped notifiedAt, so no later release and no starvation check finds it.
    expect(mockRearm).toHaveBeenCalledTimes(1);
    expect(mockRearm.mock.calls[0]).toEqual([HOLDER, WAITER_A]);
  });

  it('carries the release reason into the message body', async () => {
    mockReleaseClaims.mockResolvedValue({
      workspaceId: WS,
      releasedPaths: ['a.ts'],
      notifiedWaiters: [WAITER_A],
      waiters: [{ waitingTaskId: WAITER_A, blockedPath: 'a.ts' }],
    });

    await releaseAndNotify(HOLDER, 'abandoned');

    const [, msg] = mockEnqueue.mock.calls[0] as any[];
    expect(msg.body.reason).toBe('abandoned');
  });

  it('does not re-arm when the waiting task row is simply gone', async () => {
    mockReleaseClaims.mockResolvedValue({
      workspaceId: WS,
      releasedPaths: ['a.ts'],
      notifiedWaiters: [WAITER_A],
      waiters: [{ waitingTaskId: WAITER_A, blockedPath: 'a.ts' }],
    });
    mockEnqueue.mockImplementation(async () => false);

    await releaseAndNotify(HOLDER, 'merged');

    expect(mockRearm).not.toHaveBeenCalled();
  });

  it('falls back to the released paths when the result carries no per-waiter detail', async () => {
    // Older callers / cached shapes: notifiedWaiters without `waiters`.
    mockReleaseClaims.mockResolvedValue({
      workspaceId: WS,
      releasedPaths: ['a.ts'],
      notifiedWaiters: [WAITER_A],
    });

    await releaseAndNotify(HOLDER, 'merged');

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const [, msg] = mockEnqueue.mock.calls[0] as any[];
    expect(msg.body.paths).toEqual(['a.ts']);
  });
});

describe('resolveReleaseReasonForTask', () => {
  it('returns merged when any worker recorded a merge', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { mergedAt: new Date(), prLifecycleStatus: null, prNumber: 5 },
    ]);
    expect(await resolveReleaseReasonForTask(HOLDER)).toBe('merged');
  });

  it('returns merged from prLifecycleStatus even without mergedAt', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { mergedAt: null, prLifecycleStatus: 'merged', prNumber: 5 },
    ]);
    expect(await resolveReleaseReasonForTask(HOLDER)).toBe('merged');
  });

  it('returns pending_merge when the task is completed with a still-open PR', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { mergedAt: null, prLifecycleStatus: 'pr_open', prNumber: 5 },
    ]);
    mockTasksFindFirst.mockResolvedValue({ status: 'completed' });
    expect(await resolveReleaseReasonForTask(HOLDER)).toBe('pending_merge');
  });

  it('returns abandoned when the task never merged and never completed', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { mergedAt: null, prLifecycleStatus: 'pr_open', prNumber: 5 },
    ]);
    mockTasksFindFirst.mockResolvedValue({ status: 'pending' });
    expect(await resolveReleaseReasonForTask(HOLDER)).toBe('abandoned');
  });

  it('returns abandoned when there is no open PR at all', async () => {
    mockWorkersFindMany.mockResolvedValue([{ mergedAt: null, prLifecycleStatus: null, prNumber: null }]);
    expect(await resolveReleaseReasonForTask(HOLDER)).toBe('abandoned');
  });

  it('returns abandoned when the task has no workers', async () => {
    mockWorkersFindMany.mockResolvedValue([]);
    expect(await resolveReleaseReasonForTask(HOLDER)).toBe('abandoned');
  });
});
