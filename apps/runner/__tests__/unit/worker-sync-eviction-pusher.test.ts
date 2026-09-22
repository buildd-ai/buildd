/**
 * WorkerSync.evictCompletedWorkers — Pusher channel teardown.
 *
 * A 23-day audit of the live runner found an order of magnitude more
 * subscribed Pusher channels than active workers. `subscribeToWorker` is
 * called exactly once, at claim time (workers.ts). `unsubscribeFromWorker`
 * was previously only reachable through RecoveryManager.abort() — every
 * other termination path (normal completion, auth failure, budget exceeded,
 * server-side refusal, reconciliation, markDone, and this eviction sweep
 * itself) left the channel subscribed for the rest of the process's life,
 * recoverable only by a full process restart (PusherManager.destroy()).
 *
 * evictCompletedWorkers() is the one place every terminal worker eventually
 * passes through before being dropped from memory — whether it got there via
 * an explicit abort (already unsubscribed, redundant call) or via any of the
 * other paths above (never unsubscribed until now) — so it's the correct
 * choke point to make teardown unconditional.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worker-sync-eviction-pusher.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';

mock.module('../../src/worker-store', () => ({
  saveWorker: mock(() => {}),
  loadAllWorkers: mock(() => []),
}));

mock.module('../../src/git-operations', () => ({
  cleanupWorktree: mock(async () => {}),
}));

mock.module('../../src/session-logger', () => ({
  sessionLog: mock(() => {}),
}));

import { WorkerSync, type WorkerSyncContext } from '../../src/worker-sync';
import type { LocalWorker } from '../../src/types';

const mockUnsubscribeFromWorker = mock((_workerId: string) => {});

function makeSync() {
  const ctx: WorkerSyncContext = {
    config: { localUiUrl: 'http://localhost:8766' } as any,
    buildd: { updateWorker: mock(async () => ({})) } as any,
    workers: new Map(),
    sessions: new Map(),
    dirtyWorkers: new Set<string>(),
    dirtyForDisk: new Set<string>(),
    emit: mock(() => {}),
    abort: mock(async () => {}) as any,
    sendMessage: mock(async () => {}) as any,
    getAdaptiveStaleTimeout: () => 300_000,
    setAdaptiveStaleTimeout: mock(() => {}),
    recentCycleTimes: [],
    probedWorkers: new Set<string>(),
    addMilestone: mock(() => {}),
    buildUserMessage: mock((content: string) => ({ content })),
    unsubscribeFromWorker: mockUnsubscribeFromWorker,
  };
  return { sync: new WorkerSync(ctx), ctx };
}

function makeWorker(overrides: Partial<LocalWorker> = {}): LocalWorker {
  return {
    id: 'w-1',
    taskId: 't-1',
    taskTitle: 'fixture',
    workspaceId: 'ws-1',
    workspaceName: 'fixture workspace',
    branch: 'fixture/branch',
    status: 'done',
    startedAt: Date.now(),
    lastActivity: Date.now() - 11 * 60 * 1000,
    completedAt: Date.now() - 11 * 60 * 1000,
    messages: [],
    milestones: [],
    toolCalls: [],
    commits: [],
    output: [],
    hasNewActivity: false,
    currentAction: '',
    subagentTasks: [],
    checkpoints: [],
    checkpointEvents: new Set(),
    phaseText: null,
    phaseStart: null,
    phaseToolCount: 0,
    phaseTools: [],
    ...overrides,
  } as unknown as LocalWorker;
}

describe('WorkerSync.evictCompletedWorkers — Pusher channel teardown', () => {
  beforeEach(() => {
    mockUnsubscribeFromWorker.mockClear();
  });

  test('unsubscribes the worker channel when a done worker is evicted', () => {
    const { sync, ctx } = makeSync();
    ctx.workers.set('w-1', makeWorker({ status: 'done' }));

    sync.evictCompletedWorkers();

    expect(ctx.workers.has('w-1')).toBe(false);
    expect(mockUnsubscribeFromWorker).toHaveBeenCalledWith('w-1');
  });

  test('unsubscribes the worker channel when an error worker is evicted', () => {
    const { sync, ctx } = makeSync();
    ctx.workers.set('w-err', makeWorker({ id: 'w-err', status: 'error' }));

    sync.evictCompletedWorkers();

    expect(mockUnsubscribeFromWorker).toHaveBeenCalledWith('w-err');
  });

  test('does not unsubscribe a worker that is retained (within retention window)', () => {
    const { sync, ctx } = makeSync();
    ctx.workers.set('w-fresh', makeWorker({ id: 'w-fresh', status: 'done', lastActivity: Date.now() - 5 * 60 * 1000 }));

    sync.evictCompletedWorkers();

    expect(ctx.workers.has('w-fresh')).toBe(true);
    expect(mockUnsubscribeFromWorker).not.toHaveBeenCalled();
  });

  test('does not unsubscribe a waiting worker (never evicted)', () => {
    const { sync, ctx } = makeSync();
    ctx.workers.set('w-wait', makeWorker({
      id: 'w-wait',
      status: 'waiting',
      lastActivity: Date.now() - 999 * 60 * 60 * 1000,
    }));

    sync.evictCompletedWorkers();

    expect(mockUnsubscribeFromWorker).not.toHaveBeenCalled();
  });

  test('still evicts (and unsubscribes) even when unsubscribeFromWorker throws', () => {
    const { sync, ctx } = makeSync();
    mockUnsubscribeFromWorker.mockImplementationOnce(() => { throw new Error('pusher client gone'); });
    ctx.workers.set('w-1', makeWorker({ status: 'done' }));

    expect(() => sync.evictCompletedWorkers()).not.toThrow();
    expect(ctx.workers.has('w-1')).toBe(false);
  });
});
