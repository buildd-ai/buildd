/**
 * WorkerSync abort-handling tests.
 *
 * Regression guard for the lost-update race that killed live workers ~1s after
 * they started: the server answered a benign compare-and-swap miss with a bare
 * `{ abort: true }` (no reason, no actualStatus) and the runner hard-aborted the
 * healthy SDK session, recording `error = 'Terminated by server'`, turns = 2,
 * cost = 0.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worker-sync-abort.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';

// ─── Mocks (must be registered before importing WorkerSync) ─────────────────

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

// ─── Harness ────────────────────────────────────────────────────────────────

let updateWorkerResponse: any = {};
const mockUpdateWorker = mock(async () => updateWorkerResponse);
const mockAbort = mock(async (_id: string, _reason?: string) => {});
const mockSendMessage = mock(async (_id: string, _msg: string) => {});

function makeWorker(overrides: Partial<any> = {}): any {
  return {
    id: 'w-1',
    status: 'working',
    currentAction: 'Editing files',
    milestones: [],
    subagentTasks: [],
    phaseText: '',
    phaseToolCount: 0,
    startedAt: Date.now() - 1000,
    lastActivity: Date.now(),
    ...overrides,
  };
}

function makeSync(worker: any) {
  const ctx: WorkerSyncContext = {
    config: { localUiUrl: 'http://localhost:8766' } as any,
    buildd: { updateWorker: mockUpdateWorker } as any,
    workers: new Map([[worker.id, worker]]),
    sessions: new Map(),
    dirtyWorkers: new Set<string>(),
    dirtyForDisk: new Set<string>(),
    emit: mock(() => {}),
    abort: mockAbort as any,
    sendMessage: mockSendMessage as any,
    getAdaptiveStaleTimeout: () => 300_000,
    setAdaptiveStaleTimeout: mock(() => {}),
    recentCycleTimes: [],
    probedWorkers: new Set<string>(),
    addMilestone: mock(() => {}),
    buildUserMessage: mock((content: string) => ({ content })),
  };
  return { sync: new WorkerSync(ctx), ctx };
}

describe('WorkerSync.syncWorkerToServer — abort handling', () => {
  beforeEach(() => {
    mockUpdateWorker.mockClear();
    mockAbort.mockClear();
    mockSendMessage.mockClear();
    updateWorkerResponse = {};
  });

  test('a bare {abort:true} conflict does NOT kill the worker', async () => {
    updateWorkerResponse = { error: 'Worker state changed concurrently', abort: true };
    const worker = makeWorker();
    const { sync, ctx } = makeSync(worker);

    await sync.syncWorkerToServer(worker);

    expect(mockAbort).not.toHaveBeenCalled();
    expect(worker.status).toBe('working');
    expect(worker.error).toBeUndefined();
    expect(worker.completedAt).toBeUndefined();
    // Re-queued for another sync attempt rather than terminated.
    expect(ctx.dirtyWorkers.has(worker.id)).toBe(true);
  });

  test('an explicitly retryable conflict does NOT kill the worker', async () => {
    updateWorkerResponse = {
      error: 'Worker state changed concurrently',
      abort: true,
      retryable: true,
      actualStatus: 'running',
    };
    const worker = makeWorker();
    const { sync, ctx } = makeSync(worker);

    await sync.syncWorkerToServer(worker);

    expect(mockAbort).not.toHaveBeenCalled();
    expect(worker.status).toBe('working');
    expect(ctx.dirtyWorkers.has(worker.id)).toBe(true);
  });

  test('a non-terminal actualStatus with no reason does NOT kill the worker', async () => {
    updateWorkerResponse = { abort: true, actualStatus: 'waiting_input' };
    const worker = makeWorker();
    const { sync } = makeSync(worker);

    await sync.syncWorkerToServer(worker);

    expect(mockAbort).not.toHaveBeenCalled();
    expect(worker.status).toBe('working');
  });

  test('a stated terminal cause still aborts and records the real reason', async () => {
    updateWorkerResponse = {
      abort: true,
      reason: 'Interrupted — human takeover',
      actualStatus: 'failed',
      hasDeliverables: false,
    };
    const worker = makeWorker();
    const { sync } = makeSync(worker);

    await sync.syncWorkerToServer(worker);

    expect(mockAbort).toHaveBeenCalledTimes(1);
    expect(worker.status).toBe('error');
    expect(worker.error).toBe('Interrupted — human takeover');
    expect(worker.completedAt).toBeTruthy();
  });

  test('the completed/deliverables sync race still finishes the worker cleanly', async () => {
    updateWorkerResponse = { abort: true, actualStatus: 'completed', hasDeliverables: true };
    const worker = makeWorker();
    const { sync } = makeSync(worker);

    await sync.syncWorkerToServer(worker);

    expect(mockAbort).not.toHaveBeenCalled();
    expect(worker.status).toBe('done');
    expect(worker.completedAt).toBeTruthy();
  });

  test('pending instructions are still delivered on a clean sync', async () => {
    updateWorkerResponse = { instructions: 'please rebase' };
    const worker = makeWorker();
    const { sync } = makeSync(worker);

    await sync.syncWorkerToServer(worker);

    expect(mockAbort).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(worker.id, 'please rebase');
  });
});
