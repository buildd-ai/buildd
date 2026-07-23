/**
 * Waiting-worker worktree reclamation tests.
 *
 * Abandoned `waiting` workers are never evicted from memory/disk (kept for
 * history + possible resume), so their worktree would leak forever. The
 * eviction sweep must reclaim the worktree (only — the record survives) once
 * the worker has been idle past the 24h TTL, and must retain it before then.
 *
 * Run: bun test apps/runner/__tests__/unit/waiting-worktree-eviction.test.ts
 */

import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';
import type { LocalWorker, LocalUIConfig } from '../../src/types';
import { WAITING_WORKTREE_TTL_MS } from '../../src/worktree-utils';

// ─── Mocks (mirror e2e-worktree-cleanup.test.ts) ─────────────────────────────

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

// Capture cleanupWorktree calls (git-operations is imported by worker-sync).
const mockCleanupWorktree = mock(async () => {});
mock.module('../../src/git-operations', () => ({
  cleanupWorktree: mockCleanupWorktree,
  setupWorktree: mock(async () => null),
  collectGitStats: mock(async () => ({})),
}));

mock.module('../../src/skills.js', () => ({ syncSkillToLocal: async () => {} }));
mock.module('../../src/session-logger', () => ({
  sessionLog: () => {}, readSessionLogs: () => [], cleanupOldLogs: () => {}, claimLog: () => {},
}));
mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ platform: 'linux', arch: 'x64', tools: [], envKeys: [] }),
  checkMcpPreFlight: () => ({ warnings: [] }),
  checkBwrapSupport: () => true,
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
    id: 'w-wait-1',
    taskId: 'task-1',
    taskTitle: 'Test task',
    taskDescription: 'Do something',
    workspaceId: 'ws-1',
    workspaceName: 'test-workspace',
    branch: 'buildd/abc-wait',
    status: 'waiting',
    hasNewActivity: false,
    lastActivity: Date.now(),
    startedAt: Date.now(),
    milestones: [],
    currentAction: 'Waiting...',
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

describe('waiting worker worktree reclamation', () => {
  let manager: InstanceType<typeof WorkerManager>;
  const worktreePath = '/tmp/repo/.buildd-worktrees/buildd_abc-wait';

  afterEach(() => {
    manager?.destroy();
    mockExistsSync = () => false;
  });

  beforeEach(() => {
    mockCleanupWorktree.mockClear();
    mockExistsSync = (p: string) => p === worktreePath;
  });

  test('retains the worktree of a recently-waiting worker (before 24h TTL)', () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker({ worktreePath, lastActivity: Date.now() - 60_000 }); // 1 min ago
    inject(manager, worker);

    (manager as any).workerSync.evictCompletedWorkers();

    // Not cleaned, record still present, worktreePath preserved.
    expect(mockCleanupWorktree).not.toHaveBeenCalled();
    const workers = (manager as any).workers as Map<string, LocalWorker>;
    expect(workers.has('w-wait-1')).toBe(true);
    expect(workers.get('w-wait-1')!.worktreePath).toBe(worktreePath);
  });

  test('reclaims the worktree after the 24h TTL but keeps the worker record', () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker({
      worktreePath,
      lastActivity: Date.now() - (WAITING_WORKTREE_TTL_MS + 60_000),
    });
    inject(manager, worker);

    (manager as any).workerSync.evictCompletedWorkers();

    // Worktree cleaned, from the correct repo root; record retained for history.
    expect(mockCleanupWorktree).toHaveBeenCalledTimes(1);
    expect(mockCleanupWorktree.mock.calls[0][0]).toBe('/tmp/repo/');
    expect(mockCleanupWorktree.mock.calls[0][1]).toBe(worktreePath);
    const workers = (manager as any).workers as Map<string, LocalWorker>;
    expect(workers.has('w-wait-1')).toBe(true); // NOT evicted
    expect(workers.get('w-wait-1')!.worktreePath).toBeUndefined(); // cleared, no repeat attempts
  });

  test('does not attempt cleanup twice once worktreePath is cleared', () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker({
      worktreePath,
      lastActivity: Date.now() - (WAITING_WORKTREE_TTL_MS + 60_000),
    });
    inject(manager, worker);

    (manager as any).workerSync.evictCompletedWorkers();
    (manager as any).workerSync.evictCompletedWorkers();

    expect(mockCleanupWorktree).toHaveBeenCalledTimes(1);
  });
});
