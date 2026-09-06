/**
 * Worktree paths are keyed on the requested branch (see setupWorktree in
 * git-operations.ts), not on worker id — a retry on the same task computes
 * the identical path. That means a failed worker's record can outlive it in
 * memory (pending eviction retention) while a newer worker on the same task
 * is actively checked out at that same path. The eviction sweep must not
 * tear down a worktree another live worker owns.
 *
 * Regression coverage for: a prior failed worker's eviction cleanup deleted
 * the worktree out from under a newer, still-running worker on the same task.
 *
 * Run: bun test apps/runner/__tests__/unit/eviction-worktree-ownership.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, mock, afterAll, afterEach } from 'bun:test';
import type { LocalWorker, LocalUIConfig } from '../../src/types';
import { WAITING_WORKTREE_TTL_MS } from '../../src/worktree-utils';
import { __setGitOpsDeps, __resetGitOpsDeps } from '../../src/git-operations';

// ─── Mocks (mirror waiting-worktree-eviction.test.ts) ────────────────────────

let mockMessages: any[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (_opts: any) => {
    const msgs = [...mockMessages];
    let idx = 0;
    return {
      streamInput: mock(() => {}),
      supportedModels: async () => [],
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (idx < msgs.length) return { value: msgs[idx++], done: false };
            return { value: undefined, done: true };
          },
        };
      },
    };
  },
}));

const mockUpdateWorker = mock(async () => ({}));
mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mockUpdateWorker;
    claimTask = mock(async () => ({ workers: [] }));
    getWorkspaceConfig = mock(async () => ({ configStatus: 'unconfigured' }));
    getCompactObservations = mock(async () => ({ markdown: '', count: 0 }));
    searchObservations = mock(async () => []);
    getBatchObservations = mock(async () => []);
    createObservation = mock(async () => ({}));
    listWorkspaces = mock(async () => []);
    sendHeartbeat = mock(async () => ({}));
    runCleanup = mock(async () => ({}));
    searchFeedbackMemories = mock(async () => []);
    getWorkerRemote = mock(async () => null);
  },
}));

mock.module('../../src/workspace', () => ({
  createWorkspaceResolver: () => ({
    resolve: () => '/tmp/test-workspace',
    debugResolve: () => ({}),
    listLocalDirectories: () => [],
    getPathOverrides: () => ({}),
    setPathOverride: () => {},
    scanGitRepos: () => [],
    getProjectRoots: () => ['/tmp'],
  }),
}));

mock.module('pusher-js', () => ({
  default: class {
    subscribe() { return { bind: () => {} }; }
    unsubscribe() {}
    disconnect() {}
  },
}));

let mockExistsSync = (_path: string) => false;
mock.module('fs', () => ({
  existsSync: (path: string) => mockExistsSync(path),
  readFileSync: () => '{}',
  writeFileSync: () => {},
  mkdirSync: () => {},
  unlinkSync: () => {},
  renameSync: () => {},
  readdirSync: () => [],
  appendFileSync: () => {},
  statSync: () => ({ size: 0, mtimeMs: 0 }),
  copyFileSync: () => {},
  rmSync: () => {},
}));

mock.module('../../src/worker-store', () => ({
  saveWorker: mock(() => {}),
  loadAllWorkers: mock(() => [] as LocalWorker[]),
  loadWorker: mock(() => null),
  deleteWorker: mock(() => {}),
}));

// Capture cleanupWorktree calls via dep injection spy (avoids mock.module pollution
// that would cause git-operations.test.ts to receive the mocked setupWorktree).
const mockCleanupWorktree = mock(async () => {});

beforeAll(() => {
  __setGitOpsDeps({
    cleanupSpy: mockCleanupWorktree,
    execSync: (() => '') as any,
    execFile: ((_f: any, _a: any, _o: any, cb: any) => cb(null, '', '')) as any,
    existsSync: (p: string) => mockExistsSync(p),
    mkdirSync: (() => {}) as any,
    readFileSync: (() => '') as any,
    appendFileSync: () => {},
    rmSync: () => {},
  });
});

afterAll(() => {
  __resetGitOpsDeps();
});

mock.module('../../src/skills.js', () => ({ syncSkillToLocal: async () => {} }));
mock.module('../../src/session-logger', () => ({
  sessionLog: () => {}, readSessionLogs: () => [], cleanupOldLogs: () => {}, claimLog: () => {},
}));
mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ platform: 'linux', arch: 'x64', tools: [], envKeys: [] }),
  checkMcpPreFlight: () => ({ warnings: [] }),
  checkBwrapSupport: () => true,
  checkBwrapMountIsolationSupport: () => true,
}));

const { WorkerManager } = await import('../../src/workers');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(): LocalUIConfig {
  return {
    projectsRoot: '/tmp',
    builddServer: 'http://localhost:3000',
    apiKey: 'test-key',
    maxConcurrent: 2,
    model: 'claude-sonnet-4-5-20250929',
    serverless: true,
  };
}

function makeWorker(overrides?: Partial<LocalWorker>): LocalWorker {
  return {
    id: 'w-1',
    taskId: 'task-1',
    taskTitle: 'Test task',
    taskDescription: 'Do something',
    workspaceId: 'ws-1',
    workspaceName: 'test-workspace',
    branch: 'buildd/task-1-retry',
    status: 'error',
    hasNewActivity: false,
    lastActivity: Date.now(),
    startedAt: Date.now(),
    milestones: [],
    currentAction: 'Errored',
    commits: [],
    output: [],
    toolCalls: [],
    messages: [],
    phaseText: null,
    phaseStart: null,
    phaseToolCount: 0,
    phaseTools: [],
    subagentTasks: [],
    checkpoints: [],
    checkpointEvents: new Set(),
    ...overrides,
  };
}

function inject(manager: InstanceType<typeof WorkerManager>, worker: LocalWorker) {
  ((manager as any).workers as Map<string, LocalWorker>).set(worker.id, worker);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('eviction cleanup respects worktree ownership across workers', () => {
  let manager: InstanceType<typeof WorkerManager>;
  const sharedPath = '/tmp/repo/.buildd-worktrees/buildd_task-1-retry';

  afterEach(() => {
    manager?.destroy();
    mockExistsSync = () => false;
  });

  beforeEach(() => {
    mockCleanupWorktree.mockClear();
    mockExistsSync = (p: string) => p === sharedPath;
  });

  test('does not delete the worktree when a newer active worker on the same task shares the path', () => {
    // Retry scenario: a failed worker (w-old) and its replacement (w-new) both
    // compute the same branch-keyed worktree path. w-old's retention window
    // elapses while w-new is actively working out of that same directory.
    manager = new WorkerManager(makeConfig());

    const oldWorker = makeWorker({
      id: 'w-old',
      status: 'error',
      lastActivity: Date.now() - 11 * 60 * 1000, // past the 10-min retention
      worktreePath: sharedPath,
    });
    const newWorker = makeWorker({
      id: 'w-new',
      status: 'working',
      lastActivity: Date.now(),
      worktreePath: sharedPath,
    });
    inject(manager, oldWorker);
    inject(manager, newWorker);

    (manager as any).workerSync.evictCompletedWorkers();

    expect(mockCleanupWorktree).not.toHaveBeenCalled();

    const workers = (manager as any).workers as Map<string, LocalWorker>;
    expect(workers.has('w-old')).toBe(false); // old record still evicted from memory
    expect(workers.has('w-new')).toBe(true);
    expect(workers.get('w-new')!.worktreePath).toBe(sharedPath); // untouched
  });

  test('deletes the worktree on eviction when no other worker owns the path', () => {
    manager = new WorkerManager(makeConfig());

    const worker = makeWorker({
      id: 'w-solo',
      status: 'error',
      lastActivity: Date.now() - 11 * 60 * 1000,
      worktreePath: sharedPath,
    });
    inject(manager, worker);

    (manager as any).workerSync.evictCompletedWorkers();

    expect(mockCleanupWorktree).toHaveBeenCalledTimes(1);
    const workers = (manager as any).workers as Map<string, LocalWorker>;
    expect(workers.has('w-solo')).toBe(false);
  });

  test('still deletes the worktree when the other worker sharing the path is itself terminal', () => {
    // Two failed workers on the same task, both evicted in the same sweep —
    // ownership only matters when the other worker is actually still alive.
    manager = new WorkerManager(makeConfig());

    const workerA = makeWorker({
      id: 'w-a',
      status: 'error',
      lastActivity: Date.now() - 11 * 60 * 1000,
      worktreePath: sharedPath,
    });
    const workerB = makeWorker({
      id: 'w-b',
      status: 'done',
      lastActivity: Date.now() - 11 * 60 * 1000,
      worktreePath: sharedPath,
    });
    inject(manager, workerA);
    inject(manager, workerB);

    (manager as any).workerSync.evictCompletedWorkers();

    // Both terminal workers are evicted in the same sweep, and each
    // independently attempts cleanup of the (now-removed) shared path — the
    // second call is a redundant no-op, not a correctness issue this test covers.
    expect(mockCleanupWorktree).toHaveBeenCalled();
    const workers = (manager as any).workers as Map<string, LocalWorker>;
    expect(workers.has('w-a')).toBe(false);
    expect(workers.has('w-b')).toBe(false);
  });

  test('waiting-worker TTL reclaim skips cleanup when a newer active worker owns the path', () => {
    manager = new WorkerManager(makeConfig());

    const abandonedWaiting = makeWorker({
      id: 'w-abandoned',
      status: 'waiting',
      lastActivity: Date.now() - (WAITING_WORKTREE_TTL_MS + 60_000),
      worktreePath: sharedPath,
    });
    const activeReplacement = makeWorker({
      id: 'w-replacement',
      status: 'working',
      lastActivity: Date.now(),
      worktreePath: sharedPath,
    });
    inject(manager, abandonedWaiting);
    inject(manager, activeReplacement);

    (manager as any).workerSync.evictCompletedWorkers();

    expect(mockCleanupWorktree).not.toHaveBeenCalled();
    const workers = (manager as any).workers as Map<string, LocalWorker>;
    // Waiting worker record is retained (never evicted) but its stale
    // worktreePath reference is cleared either way — it no longer owns it.
    expect(workers.has('w-abandoned')).toBe(true);
    expect(workers.get('w-abandoned')!.worktreePath).toBeUndefined();
    expect(workers.get('w-replacement')!.worktreePath).toBe(sharedPath);
  });

  test('waiting-worker TTL reclaim still cleans up when no other worker owns the path', () => {
    manager = new WorkerManager(makeConfig());

    const abandonedWaiting = makeWorker({
      id: 'w-abandoned-solo',
      status: 'waiting',
      lastActivity: Date.now() - (WAITING_WORKTREE_TTL_MS + 60_000),
      worktreePath: sharedPath,
    });
    inject(manager, abandonedWaiting);

    (manager as any).workerSync.evictCompletedWorkers();

    expect(mockCleanupWorktree).toHaveBeenCalledTimes(1);
    const workers = (manager as any).workers as Map<string, LocalWorker>;
    expect(workers.has('w-abandoned-solo')).toBe(true);
    expect(workers.get('w-abandoned-solo')!.worktreePath).toBeUndefined();
  });
});
