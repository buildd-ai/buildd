/**
 * The periodic sync loop (WorkerSync.syncWorkerToServer) must report the
 * worktree's dirty-tracked-files state on every tick — see
 * worker-sync.ts:computeDirtyWorktree.
 *
 * This is the signal the complete_task gate (apps/web/src/app/api/workers/[id]/
 * route.ts) reads to refuse a worker that edited files, never committed, and
 * completes via the agent's own MCP tool call — a call that reaches the server
 * directly over HTTP with no local git access of its own, so the worker row's
 * `dirty_worktree` column (kept fresh by this loop) is the only thing the gate
 * can check at that instant.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worker-sync-dirty-worktree.test.ts
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

let statusPorcelainOutput = '';
const mockExecSync = mock((cmd: string) => {
  if (cmd.includes('status --porcelain')) return statusPorcelainOutput;
  // computeTouchedPaths' `git diff --name-only` — no touched paths by default.
  return '';
});
mock.module('child_process', () => ({ execSync: mockExecSync }));

let worktreeExists = true;
mock.module('fs', () => ({ existsSync: mock(() => worktreeExists) }));

import { WorkerSync, type WorkerSyncContext } from '../../src/worker-sync';

const seenPayloads: any[] = [];
const mockUpdateWorker = mock(async (_id: string, update: any) => {
  seenPayloads.push(update);
  return {};
});

function makeWorker(overrides: Partial<any> = {}): any {
  return {
    id: 'w-dirty',
    status: 'working',
    currentAction: 'Editing files',
    milestones: [],
    subagentTasks: [],
    phaseText: '',
    phaseToolCount: 0,
    startedAt: Date.now() - 1000,
    lastActivity: Date.now(),
    worktreePath: '/repo/.buildd-worktrees/buildd_w-dirty',
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

describe('WorkerSync dirty-worktree reporting', () => {
  beforeEach(() => {
    mockUpdateWorker.mockClear();
    seenPayloads.length = 0;
    statusPorcelainOutput = '';
    worktreeExists = true;
  });

  test('reports dirtyWorktree=true when a tracked file is modified', async () => {
    statusPorcelainOutput = ' M apps/web/src/foo.ts\n';
    const worker = makeWorker();
    await makeSync(worker).syncWorkerToServer(worker);

    expect(seenPayloads[0].dirtyWorktree).toBe(true);
  });

  test('reports dirtyWorktree=false when only untracked files are present', async () => {
    statusPorcelainOutput = '?? scratch.txt\n';
    const worker = makeWorker();
    await makeSync(worker).syncWorkerToServer(worker);

    expect(seenPayloads[0].dirtyWorktree).toBe(false);
  });

  test('reports dirtyWorktree=false on a clean worktree', async () => {
    statusPorcelainOutput = '';
    const worker = makeWorker();
    await makeSync(worker).syncWorkerToServer(worker);

    expect(seenPayloads[0].dirtyWorktree).toBe(false);
  });

  test('omits dirtyWorktree when no worktree exists yet', async () => {
    worktreeExists = false;
    const worker = makeWorker({ worktreePath: undefined });
    await makeSync(worker).syncWorkerToServer(worker);

    expect(seenPayloads[0].dirtyWorktree).toBeUndefined();
  });
});
