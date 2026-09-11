/**
 * The periodic sync loop (WorkerSync.syncWorkerToServer) must re-send the
 * worker's actual checked-out branch on every tick — see worker-sync.ts's
 * `update` payload construction.
 *
 * Before #2305, a PATCH /api/workers/[id] body could get its `branch` field
 * silently corrupted to the literal string "[REDACTED:credential]" by an
 * over-eager secret-pattern heuristic, permanently wedging `create_pr` for
 * that worker (every `head` guess was compared against the corrupted value).
 * #2305 fixed the pattern, but a worker whose row was corrupted BEFORE that
 * fix deployed had no way to self-heal — the branch was only ever sent once,
 * at startup. Re-sending it on every sync tick means any already-running
 * worker fixes its own stale/corrupted DB row within one cycle, without being
 * killed and restarted on a fresh branch.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worker-sync-branch-resync.test.ts
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

mock.module('child_process', () => ({ execSync: mock(() => '') }));
mock.module('fs', () => ({ existsSync: mock(() => false) }));

import { WorkerSync, type WorkerSyncContext } from '../../src/worker-sync';

const seenPayloads: any[] = [];
const mockUpdateWorker = mock(async (_id: string, update: any) => {
  seenPayloads.push(update);
  return {};
});

function makeWorker(overrides: Partial<any> = {}): any {
  return {
    id: 'w-branch-resync',
    status: 'working',
    currentAction: 'Editing files',
    milestones: [],
    subagentTasks: [],
    phaseText: '',
    phaseToolCount: 0,
    startedAt: Date.now() - 1000,
    lastActivity: Date.now(),
    branch: 'buildd/abc12345-some-task',
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
    abort: mock(async () => {}) as any,
    sendMessage: mock(async () => {}) as any,
    getAdaptiveStaleTimeout: () => 300_000,
    setAdaptiveStaleTimeout: mock(() => {}),
    recentCycleTimes: [],
    probedWorkers: new Set<string>(),
    addMilestone: mock(() => {}),
    buildUserMessage: mock((content: string) => ({ content })),
  };
  return new WorkerSync(ctx);
}

describe('WorkerSync branch re-sync', () => {
  beforeEach(() => {
    mockUpdateWorker.mockClear();
    seenPayloads.length = 0;
  });

  test('includes the worker\'s actual branch on every sync tick', async () => {
    const worker = makeWorker({ branch: 'buildd/abc12345-some-task' });
    await makeSync(worker).syncWorkerToServer(worker);

    expect(seenPayloads[0].branch).toBe('buildd/abc12345-some-task');
  });

  test('re-sends branch across multiple ticks (self-heals a stale server row)', async () => {
    const worker = makeWorker({ branch: 'mission/spec-conformance-the-discrepancy-ledger-f02e0dc0-w961bce4e' });
    const sync = makeSync(worker);

    await sync.syncWorkerToServer(worker);
    await sync.syncWorkerToServer(worker);

    expect(seenPayloads).toHaveLength(2);
    for (const payload of seenPayloads) {
      expect(payload.branch).toBe('mission/spec-conformance-the-discrepancy-ledger-f02e0dc0-w961bce4e');
    }
  });

  test('omits branch when the worker has none set', async () => {
    const worker = makeWorker({ branch: undefined });
    await makeSync(worker).syncWorkerToServer(worker);

    expect(seenPayloads[0].branch).toBeUndefined();
  });
});
