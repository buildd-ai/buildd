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

  test('flags the reconciliation write so the server records a crashed terminal outcome, not an ordinary failure', () => {
    diskWorkers = [restartKilledFromDisk()];
    const { sync } = makeSync();

    sync.restoreWorkersFromDisk();

    const [, update] = mockUpdateWorker.mock.calls[0] as any[];
    expect(update.crashReconciled).toBe(true);
  });

  test('carries whatever cost/token numbers the crashed session had accumulated, so the terminal record is not measurement-blind', () => {
    diskWorkers = [restartKilledFromDisk({
      resultMeta: { totalCostUsd: 1.23, numTurns: 7 },
      tokenTally: { inputTokens: 4000, outputTokens: 900 },
    })];
    const { sync } = makeSync();

    sync.restoreWorkersFromDisk();

    const [, update] = mockUpdateWorker.mock.calls[0] as any[];
    expect(update.costUsd).toBe(1.23);
    expect(update.inputTokens).toBe(4000);
    expect(update.outputTokens).toBe(900);
    expect(update.resultMeta?.numTurns).toBe(7);
  });

  test('omits attribution fields entirely when the crashed session never got far enough to accumulate any', () => {
    diskWorkers = [restartKilledFromDisk()];
    const { sync } = makeSync();

    sync.restoreWorkersFromDisk();

    const [, update] = mockUpdateWorker.mock.calls[0] as any[];
    expect(update.costUsd).toBeUndefined();
    expect(update.inputTokens).toBeUndefined();
    expect(update.outputTokens).toBeUndefined();
    expect(update.resultMeta).toBeUndefined();
  });
});

describe('WorkerSync.restoreWorkersFromDisk — already-terminal records are left on disk', () => {
  beforeEach(() => {
    mockUpdateWorker.mockClear();
    diskWorkers = [];
  });

  test('a worker that was already done before this restart is not loaded into memory', () => {
    diskWorkers = [restartKilledFromDisk({
      id: 'w-done',
      status: 'done',
      error: undefined,
      killedByRestart: undefined,
    })];
    const { sync, ctx } = makeSync();

    sync.restoreWorkersFromDisk();

    // getWorkers() merges done/error disk history separately (loadTerminalWorkersCached) —
    // loading it into ctx.workers too just means evictCompletedWorkers deletes it
    // again on the very next tick. That churn is the bug: worker_evicted was 37.7%
    // of all per-worker log entries, almost entirely restart-reload-then-evict.
    expect(ctx.workers.has('w-done')).toBe(false);
  });

  test('a worker that was already error before this restart (not killed by this one) is not loaded into memory', () => {
    diskWorkers = [restartKilledFromDisk({
      id: 'w-old-error',
      status: 'error',
      error: 'Task failed three restarts ago',
      killedByRestart: undefined,
    })];
    const { sync, ctx } = makeSync();

    sync.restoreWorkersFromDisk();

    expect(ctx.workers.has('w-old-error')).toBe(false);
    // Old terminal records need no reconciliation — they already reported.
    expect(mockUpdateWorker).not.toHaveBeenCalled();
  });

  test('a worker THIS restart just killed (working -> error) is still loaded into memory', () => {
    diskWorkers = [restartKilledFromDisk()]; // id: w-restart, killedByRestart: true
    const { sync, ctx } = makeSync();

    sync.restoreWorkersFromDisk();

    expect(ctx.workers.has('w-restart')).toBe(true);
    expect(ctx.workers.get('w-restart')?.status).toBe('error');
  });

  test('a waiting worker is still loaded into memory (resumable)', () => {
    diskWorkers = [restartKilledFromDisk({
      id: 'w-waiting',
      status: 'waiting',
      error: undefined,
      killedByRestart: undefined,
    })];
    const { sync, ctx } = makeSync();

    sync.restoreWorkersFromDisk();

    expect(ctx.workers.has('w-waiting')).toBe(true);
  });

  test('a mix of terminal and live records only loads the live ones', () => {
    diskWorkers = [
      restartKilledFromDisk({ id: 'w-done-1', status: 'done', error: undefined, killedByRestart: undefined }),
      restartKilledFromDisk({ id: 'w-done-2', status: 'error', error: 'old', killedByRestart: undefined }),
      restartKilledFromDisk({ id: 'w-waiting-1', status: 'waiting', error: undefined, killedByRestart: undefined }),
      restartKilledFromDisk({ id: 'w-killed-1' }), // killedByRestart: true
    ];
    const { sync, ctx } = makeSync();

    sync.restoreWorkersFromDisk();

    expect([...ctx.workers.keys()].sort()).toEqual(['w-killed-1', 'w-waiting-1']);
  });
});

// ─── R-37 / R-38: a restart continues what it can, and says what it could not ──

describe('WorkerSync.restoreWorkersFromDisk — paused, not failed, when the session survived', () => {
  beforeEach(() => {
    mockUpdateWorker.mockClear();
    diskWorkers = [];
  });

  /** Everything on disk except what `gone` names. */
  function probe(gone: { worktree?: boolean; session?: boolean; codex?: boolean } = {}) {
    return {
      worktreeExists: () => !gone.worktree,
      claudeSessionExists: () => !gone.session,
      codexThreadExists: () => !gone.codex,
    };
  }

  function syncWith(p: ReturnType<typeof probe>) {
    const made = makeSync();
    made.ctx.resumeProbe = p;
    return made;
  }

  const crashed = (o: Partial<any> = {}) => restartKilledFromDisk({
    id: 'w-crash',
    taskId: 'task-crash',
    sessionId: 'sess-crash-1',
    worktreePath: '/tmp/wt-crash',
    ...o,
  });

  // Spec 47c97f48 (r1): killed while the runner paused it for an update.
  test('a crash while an update pause was pending restores it as paused for the update, not as a person\'s pause', () => {
    diskWorkers = [crashed({ pauseRequestedAt: Date.now() - 5_000, pauseRequestedFor: 'update' })];
    const { sync, ctx } = syncWith(probe());

    sync.restoreWorkersFromDisk();

    const w = ctx.workers.get('w-crash')!;
    expect(w.status).toBe('waiting');
    expect(w.resumeOnStart).toBe('update');
    expect(w.waitingFor?.context).toMatch(/^Paused for update/);
    expect(w.pauseRequestedFor).toBeUndefined();
  });

  test('a crash (no grace) with the worktree and the session file still there restores it as paused, to be continued', () => {
    diskWorkers = [crashed()];
    const { sync, ctx } = syncWith(probe());

    sync.restoreWorkersFromDisk();

    const w = ctx.workers.get('w-crash')!;
    expect(w.status).toBe('waiting');
    expect(w.waitingFor?.type).toBe('pause');
    expect(w.resumeOnStart).toBe('crash');
    expect(w.sessionId).toBe('sess-crash-1');
    expect(w.killedByRestart).toBeUndefined();
    // Never "Process restarted": nothing is reported failed.
    expect(mockUpdateWorker.mock.calls.some((c: any[]) => c[1]?.status === 'failed')).toBe(false);
  });

  test('a pause a person asked for while a tool ran stays theirs after a kill: not auto-continued', () => {
    diskWorkers = [crashed({ pauseRequestedAt: 1_700_000_000_000 })];
    const { sync, ctx } = syncWith(probe());

    sync.restoreWorkersFromDisk();

    const w = ctx.workers.get('w-crash')!;
    expect(w.status).toBe('waiting');
    expect(w.waitingFor?.type).toBe('pause');
    expect(w.resumeOnStart).toBeUndefined();
    expect(w.pauseRequestedAt).toBeUndefined();
  });

  test('a Codex run needs its thread, not a Claude session', () => {
    diskWorkers = [crashed({ taskBackend: 'codex', sessionId: undefined, codexThreadId: 'thread-abc123' })];
    const { sync, ctx } = syncWith(probe({ session: true }));
    sync.restoreWorkersFromDisk();
    expect(ctx.workers.get('w-crash')!.status).toBe('waiting');
  });

  test('its session file gone: a new attempt, and the reason names the session file', () => {
    diskWorkers = [crashed()];
    const { sync, ctx } = syncWith(probe({ session: true }));

    sync.restoreWorkersFromDisk();

    const w = ctx.workers.get('w-crash')!;
    expect(w.status).toBe('error');
    expect(w.error).toMatch(/^Process restarted: its session file is gone/);
    expect(w.error).toMatch(/new attempt from its last pushed commit/);
    const [, update] = mockUpdateWorker.mock.calls[0] as any[];
    expect(update.status).toBe('failed');
    expect(update.error).toContain('its session file');
    expect(update.crashReconciled).toBe(true);
  });

  test('its worktree and session both gone: the reason names both', () => {
    diskWorkers = [crashed()];
    const { sync } = syncWith(probe({ worktree: true, session: true }));
    sync.restoreWorkersFromDisk();
    const [, update] = mockUpdateWorker.mock.calls[0] as any[];
    expect(update.error).toContain('its worktree and its session file are gone');
  });

  test('a worker paused by a stop keeps waiting, ready to continue', () => {
    diskWorkers = [crashed({
      status: 'waiting', killedByRestart: undefined, error: 'paused: by the runner',
      waitingFor: { type: 'pause', prompt: 'Paused' }, resumeOnStart: 'shutdown',
    })];
    const { sync, ctx } = syncWith(probe());
    sync.restoreWorkersFromDisk();
    expect(ctx.workers.get('w-crash')!.status).toBe('waiting');
    expect(ctx.workers.get('w-crash')!.resumeOnStart).toBe('shutdown');
    expect(mockUpdateWorker).not.toHaveBeenCalled();
  });

  test('R-38: a paused worker whose worktree is gone starts again as a new attempt, saying so', () => {
    diskWorkers = [crashed({
      status: 'waiting', killedByRestart: undefined,
      waitingFor: { type: 'pause', prompt: 'Paused' }, resumeOnStart: 'shutdown',
    })];
    const { sync, ctx } = syncWith(probe({ worktree: true }));

    sync.restoreWorkersFromDisk();

    const w = ctx.workers.get('w-crash')!;
    expect(w.status).toBe('error');
    expect(w.waitingFor).toBeUndefined();
    const [, update] = mockUpdateWorker.mock.calls[0] as any[];
    expect(update.status).toBe('failed');
    expect(update.error).toContain('its worktree is gone');
  });

  test('a worker waiting on a question is left alone', () => {
    diskWorkers = [crashed({
      status: 'waiting', killedByRestart: undefined,
      waitingFor: { type: 'question', prompt: 'Which one?' },
    })];
    const { sync, ctx } = syncWith(probe({ worktree: true, session: true }));
    sync.restoreWorkersFromDisk();
    expect(ctx.workers.get('w-crash')!.status).toBe('waiting');
    expect(mockUpdateWorker).not.toHaveBeenCalled();
  });
});
