/**
 * WorkerSync — SDK session teardown on eviction, and the post-completion
 * watchdog in checkStale().
 *
 * Three paths set worker.status = 'done' while the underlying SDK session
 * keeps running (worker:completed, the sync-race branch in
 * syncWorkerToServer, and markDone). evictCompletedWorkers() used to call
 * `sessions.delete(id)` directly — dropping the map entry without aborting
 * the controller or ending the input stream, which leaks the `claude` CLI
 * subprocess. checkStale() only ever watched 'working'/'stale' workers, so a
 * worker that completed (or errored) but whose session hangs on a stuck
 * tool/MCP call was invisible to it — the task's concurrency slot already
 * reads as free while the process is still alive untracked.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worker-sync-session-teardown.test.ts
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
const mockAbort = mock(async (_id: string, _reason?: string) => {});
const mockUpdateWorker = mock(async () => ({}));

function makeSession() {
  return {
    abortController: { abort: mock(() => {}) } as unknown as AbortController,
    inputStream: { end: mock(() => {}) },
  };
}

function makeSync() {
  const ctx: WorkerSyncContext = {
    config: { localUiUrl: 'http://localhost:8766' } as any,
    buildd: { updateWorker: mockUpdateWorker } as any,
    workers: new Map(),
    sessions: new Map(),
    dirtyWorkers: new Set<string>(),
    dirtyForDisk: new Set<string>(),
    emit: mock(() => {}),
    abort: mockAbort as any,
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

describe('WorkerSync.evictCompletedWorkers — SDK session teardown', () => {
  beforeEach(() => {
    mockUnsubscribeFromWorker.mockClear();
    mockAbort.mockClear();
    mockUpdateWorker.mockClear();
  });

  test('aborts the controller and ends the stream before dropping a done worker', () => {
    const { sync, ctx } = makeSync();
    const session = makeSession();
    ctx.workers.set('w-1', makeWorker({ status: 'done' }));
    ctx.sessions.set('w-1', session as any);

    sync.evictCompletedWorkers();

    expect(session.abortController.abort).toHaveBeenCalledTimes(1);
    expect(session.inputStream.end).toHaveBeenCalledTimes(1);
    expect(ctx.sessions.has('w-1')).toBe(false);
    expect(ctx.workers.has('w-1')).toBe(false);
  });

  test('is a no-op teardown when the worker has no live session', () => {
    const { sync, ctx } = makeSync();
    ctx.workers.set('w-1', makeWorker({ status: 'done' }));

    expect(() => sync.evictCompletedWorkers()).not.toThrow();
    expect(ctx.workers.has('w-1')).toBe(false);
  });
});

describe('WorkerSync.checkStale — post-completion session watchdog', () => {
  beforeEach(() => {
    mockUnsubscribeFromWorker.mockClear();
    mockAbort.mockClear();
    mockUpdateWorker.mockClear();
  });

  test('tears down a session still running 6 minutes after the worker completed', () => {
    const { sync, ctx } = makeSync();
    const session = makeSession();
    const completedAt = Date.now() - 6 * 60 * 1000;
    ctx.workers.set('w-1', makeWorker({ status: 'done', completedAt, lastActivity: completedAt }));
    ctx.sessions.set('w-1', session as any);

    sync.checkStale();

    expect(session.abortController.abort).toHaveBeenCalledTimes(1);
    expect(session.inputStream.end).toHaveBeenCalledTimes(1);
    expect(ctx.sessions.has('w-1')).toBe(false);
    // A real completion must not be undone: no server call, no ctx.abort.
    expect(mockAbort).not.toHaveBeenCalled();
    expect(mockUpdateWorker).not.toHaveBeenCalled();
    // The worker record itself is untouched — this is session cleanup, not a failure.
    expect(ctx.workers.get('w-1')?.status).toBe('done');
  });

  test('tears down an errored worker whose session outlived its grace period', () => {
    const { sync, ctx } = makeSync();
    const session = makeSession();
    const completedAt = Date.now() - 10 * 60 * 1000;
    ctx.workers.set('w-err', makeWorker({ id: 'w-err', status: 'error', completedAt, lastActivity: completedAt }));
    ctx.sessions.set('w-err', session as any);

    sync.checkStale();

    expect(session.abortController.abort).toHaveBeenCalledTimes(1);
    expect(ctx.sessions.has('w-err')).toBe(false);
    expect(mockAbort).not.toHaveBeenCalled();
  });

  test('leaves a session alone within the grace period (1 minute after completion)', () => {
    const { sync, ctx } = makeSync();
    const session = makeSession();
    const completedAt = Date.now() - 1 * 60 * 1000;
    ctx.workers.set('w-1', makeWorker({ status: 'done', completedAt, lastActivity: completedAt }));
    ctx.sessions.set('w-1', session as any);

    sync.checkStale();

    expect(session.abortController.abort).not.toHaveBeenCalled();
    expect(session.inputStream.end).not.toHaveBeenCalled();
    expect(ctx.sessions.has('w-1')).toBe(true);
  });

  test('does nothing for a done worker with no live session', () => {
    const { sync, ctx } = makeSync();
    const completedAt = Date.now() - 20 * 60 * 1000;
    ctx.workers.set('w-1', makeWorker({ status: 'done', completedAt, lastActivity: completedAt }));

    expect(() => sync.checkStale()).not.toThrow();
    expect(mockAbort).not.toHaveBeenCalled();
  });

  test('falls back to lastActivity when completedAt is missing', () => {
    const { sync, ctx } = makeSync();
    const session = makeSession();
    const lastActivity = Date.now() - 6 * 60 * 1000;
    ctx.workers.set('w-1', makeWorker({ status: 'done', completedAt: undefined, lastActivity }));
    ctx.sessions.set('w-1', session as any);

    sync.checkStale();

    expect(session.abortController.abort).toHaveBeenCalledTimes(1);
    expect(ctx.sessions.has('w-1')).toBe(false);
  });
});
