/**
 * WorkerSync.restoreWorkersFromDisk — server notification on runner restart.
 *
 * Regression guard for the orphan source behind the bulk of the
 * "Stale worker expired" reaper population.
 *
 * Claude SDK sessions cannot survive a runner restart, so every worker
 * persisted as 'working' is a zombie at load time. `restoreWorkersFromDisk`
 * carries an explicit "Notify server so it doesn't stay 'running' forever"
 * branch for exactly this case — but it keyed off `status === 'working'`, and
 * `loadAllWorkers` already rewrites 'working' → 'error' on disk as it loads
 * (to stop zombies holding concurrency seats). By the time the branch ran the
 * status was 'error', so the notification never fired and the server row sat at
 * 'running' until the reaper killed it a full cycle later — on every restart,
 * for every in-flight worker.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worker-sync-restore.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';

// ─── Mocks (must be registered before importing WorkerSync) ─────────────────

let diskWorkers: any[] = [];

mock.module('../../src/worker-store', () => ({
  saveWorker: mock(() => {}),
  loadAllWorkers: mock(() => diskWorkers),
}));

mock.module('../../src/git-operations', () => ({
  cleanupWorktree: mock(async () => {}),
}));

mock.module('../../src/session-logger', () => ({
  sessionLog: mock(() => {}),
}));

import { WorkerSync, type WorkerSyncContext } from '../../src/worker-sync';

// ─── Harness ────────────────────────────────────────────────────────────────

const mockUpdateWorker = mock(async () => ({}));

function makeSync() {
  const ctx: WorkerSyncContext = {
    config: { localUiUrl: 'http://localhost:8766' } as any,
    buildd: { updateWorker: mockUpdateWorker } as any,
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
  };
  return { sync: new WorkerSync(ctx), ctx };
}

/** Shape a worker arrives in AFTER loadAllWorkers has applied its zombie rewrite. */
function restartKilledFromDisk(overrides: Partial<any> = {}): any {
  return {
    id: 'w-restart',
    status: 'error',
    error: 'Killed: runner restarted, in-flight session terminated',
    killedByRestart: true,
    milestones: [],
    subagentTasks: [],
    checkpoints: [],
    lastActivity: Date.now() - 60_000,
    ...overrides,
  };
}

describe('WorkerSync.restoreWorkersFromDisk — restart orphan notification', () => {
  beforeEach(() => {
    mockUpdateWorker.mockClear();
    diskWorkers = [];
  });

  test('notifies the server for a worker the loader already marked restart-killed', () => {
    diskWorkers = [restartKilledFromDisk()];
    const { sync } = makeSync();

    sync.restoreWorkersFromDisk();

    // Without this the server row stays 'running' until the reaper expires it.
    expect(mockUpdateWorker).toHaveBeenCalledTimes(1);
    const [workerId, update] = mockUpdateWorker.mock.calls[0] as any[];
    expect(workerId).toBe('w-restart');
    expect(update.status).toBe('failed');
  });

  test('still notifies for a worker persisted as stale (loader leaves those alone)', () => {
    // loadAllWorkers only rewrites 'working', so 'stale' arrives unchanged.
    diskWorkers = [restartKilledFromDisk({
      id: 'w-stale',
      status: 'stale',
      error: undefined,
      killedByRestart: undefined,
    })];
    const { sync } = makeSync();

    sync.restoreWorkersFromDisk();

    expect(mockUpdateWorker).toHaveBeenCalledTimes(1);
    expect((mockUpdateWorker.mock.calls[0] as any[])[0]).toBe('w-stale');
  });

  test('does not notify for a worker that finished cleanly before the restart', () => {
    // A genuinely completed worker already reported its terminal state; another
    // 'failed' write would overwrite a good outcome with a spurious failure.
    diskWorkers = [restartKilledFromDisk({
      id: 'w-done',
      status: 'done',
      error: undefined,
      killedByRestart: undefined,
    })];
    const { sync } = makeSync();

    sync.restoreWorkersFromDisk();

    expect(mockUpdateWorker).not.toHaveBeenCalled();
  });

  test('does not notify for a waiting worker (kept resumable on purpose)', () => {
    diskWorkers = [restartKilledFromDisk({
      id: 'w-waiting',
      status: 'waiting',
      error: undefined,
      killedByRestart: undefined,
    })];
    const { sync } = makeSync();

    sync.restoreWorkersFromDisk();

    expect(mockUpdateWorker).not.toHaveBeenCalled();
  });
});
