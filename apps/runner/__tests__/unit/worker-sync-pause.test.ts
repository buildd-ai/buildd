/**
 * WorkerSync: a PATCH response saying a person paused this run (task baf3809a)
 * reaches WorkerManager.pauseWorker, durably, even with no realtime push.
 *
 * Harness copied from worker-sync-abort.test.ts.
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

describe('WorkerSync — pauseRequested', () => {
  beforeEach(() => {
    mockUpdateWorker.mockClear();
    mockAbort.mockClear();
    updateWorkerResponse = {};
  });

  test('a working worker is handed to onPauseRequested, and never aborted', async () => {
    const worker = makeWorker();
    const { sync, ctx } = makeSync(worker);
    const onPauseRequested = mock(() => {});
    (ctx as any).onPauseRequested = onPauseRequested;
    updateWorkerResponse = { status: 'running', pauseRequested: true };
    await (sync as any).syncWorkerToServer(worker);
    expect(onPauseRequested).toHaveBeenCalledTimes(1);
    expect(mockAbort).not.toHaveBeenCalled();
  });

  test('a pause already pending, or a worker not working, is not handed again', async () => {
    const onPauseRequested = mock(() => {});
    updateWorkerResponse = { status: 'running', pauseRequested: true };
    for (const worker of [makeWorker({ pauseRequestedAt: Date.now() }), makeWorker({ status: 'waiting' })]) {
      const { sync, ctx } = makeSync(worker);
      (ctx as any).onPauseRequested = onPauseRequested;
      await (sync as any).syncWorkerToServer(worker);
    }
    expect(onPauseRequested).not.toHaveBeenCalled();
  });
});
