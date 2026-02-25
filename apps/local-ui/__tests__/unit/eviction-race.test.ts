/**
 * Eviction race condition tests — verifies behavior when follow-up messages
 * arrive before/after worker eviction from memory.
 *
 * Tests cover:
 * - Eviction timing (10-minute retention window)
 * - sendMessage behavior after eviction
 * - Session cleanup during eviction
 * - Worktree cleanup during eviction
 * - getWorker() disk fallback for evicted workers
 *
 * Run: bun test apps/local-ui/__tests__/unit/eviction-race.test.ts
 */

import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';
import type { LocalWorker, LocalUIConfig } from '../../src/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

let mockMessages: any[] = [];
let queryCallCount = 0;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (_opts: any) => {
    queryCallCount++;
    const msgs = [...mockMessages];
    let idx = 0;
    return {
      streamInput: mock(() => {}),
      supportedModels: async () => [],
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (idx < msgs.length) {
              return { value: msgs[idx++], done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    };
  },
}));

const mockUpdateWorker = mock(async () => ({}));
const mockClaimTask = mock(async () => ({ workers: [] }));
const mockGetWorkspaceConfig = mock(async () => ({ configStatus: 'unconfigured' }));
const mockGetCompactObservations = mock(async () => ({ markdown: '', count: 0 }));
const mockSearchObservations = mock(async () => []);
const mockGetBatchObservations = mock(async () => []);
const mockCreateObservation = mock(async () => ({}));
const mockListWorkspaces = mock(async () => []);
const mockSendHeartbeat = mock(async () => ({}));
const mockRunCleanup = mock(async () => ({}));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mockUpdateWorker;
    claimTask = mockClaimTask;
    getWorkspaceConfig = mockGetWorkspaceConfig;
    getCompactObservations = mockGetCompactObservations;
    searchObservations = mockSearchObservations;
    getBatchObservations = mockGetBatchObservations;
    createObservation = mockCreateObservation;
    listWorkspaces = mockListWorkspaces;
    sendHeartbeat = mockSendHeartbeat;
    runCleanup = mockRunCleanup;
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
}));

const mockSaveWorker = mock(() => {});
const mockLoadAllWorkers = mock(() => [] as LocalWorker[]);
const mockLoadWorker = mock((_id: string) => null as LocalWorker | null);
const mockDeleteWorker = mock(() => {});

mock.module('../../src/worker-store', () => ({
  saveWorker: mockSaveWorker,
  loadAllWorkers: mockLoadAllWorkers,
  loadWorker: mockLoadWorker,
  deleteWorker: mockDeleteWorker,
}));

mock.module('../../src/skills.js', () => ({
  syncSkillToLocal: async () => {},
}));

mock.module('../../src/session-logger', () => ({
  sessionLog: () => {},
  readSessionLogs: () => [],
  cleanupOldLogs: () => {},
}));

mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ platform: 'linux', arch: 'x64', tools: [], envKeys: [] }),
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
    id: 'w-evict-1',
    taskId: 'task-1',
    taskTitle: 'Test task',
    taskDescription: 'Do something',
    workspaceId: 'ws-1',
    workspaceName: 'test-workspace',
    branch: 'buildd/test',
    status: 'working',
    hasNewActivity: false,
    lastActivity: Date.now(),
    milestones: [],
    currentAction: 'Working...',
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

function injectWorker(
  manager: InstanceType<typeof WorkerManager>,
  worker: LocalWorker,
  opts?: { withSession?: boolean },
) {
  const workers = (manager as any).workers as Map<string, LocalWorker>;
  workers.set(worker.id, worker);

  if (opts?.withSession) {
    const sessions = (manager as any).sessions as Map<string, any>;
    const queue: any[] = [];
    const resolvers: Array<(r: any) => void> = [];
    let done = false;

    const inputStream = {
      enqueue: (msg: any) => {
        if (done) return;
        if (resolvers.length > 0) {
          resolvers.shift()!({ value: msg, done: false });
        } else {
          queue.push(msg);
        }
      },
      end: () => { done = true; resolvers.forEach(r => r({ value: undefined, done: true })); },
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
            if (done) return Promise.resolve({ value: undefined, done: true });
            return new Promise(resolve => resolvers.push(resolve));
          },
        };
      },
    };

    sessions.set(worker.id, {
      inputStream,
      abortController: new AbortController(),
      cwd: '/tmp/test-workspace',
      repoPath: '/tmp/test-workspace',
      generation: 1,
    });
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Eviction race conditions', () => {
  let manager: InstanceType<typeof WorkerManager>;

  afterEach(() => {
    manager?.destroy();
    mockExistsSync = () => false;
  });

  beforeEach(() => {
    queryCallCount = 0;
    mockMessages = [];
    mockUpdateWorker.mockClear();
    mockClaimTask.mockClear();
    mockSaveWorker.mockClear();
    mockLoadWorker.mockClear();
    mockLoadAllWorkers.mockClear();
  });

  describe('Eviction timing', () => {
    test('evicts done workers after 10 minutes', () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        lastActivity: Date.now() - 11 * 60 * 1000, // 11 min ago
      });
      injectWorker(manager, worker);

      (manager as any).evictCompletedWorkers();

      const workers = (manager as any).workers as Map<string, LocalWorker>;
      expect(workers.has('w-evict-1')).toBe(false);
    });

    test('evicts error workers after 10 minutes', () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        id: 'w-err-1',
        status: 'error',
        lastActivity: Date.now() - 11 * 60 * 1000,
      });
      injectWorker(manager, worker);

      (manager as any).evictCompletedWorkers();

      const workers = (manager as any).workers as Map<string, LocalWorker>;
      expect(workers.has('w-err-1')).toBe(false);
    });

    test('retains done workers within 10 minutes', () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        lastActivity: Date.now() - 5 * 60 * 1000, // 5 min ago
      });
      injectWorker(manager, worker);

      (manager as any).evictCompletedWorkers();

      const workers = (manager as any).workers as Map<string, LocalWorker>;
      expect(workers.has('w-evict-1')).toBe(true);
    });

    test('never evicts working workers', () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'working',
        lastActivity: Date.now() - 20 * 60 * 1000, // 20 min ago
      });
      injectWorker(manager, worker);

      (manager as any).evictCompletedWorkers();

      const workers = (manager as any).workers as Map<string, LocalWorker>;
      expect(workers.has('w-evict-1')).toBe(true);
    });
  });

  describe('sendMessage after eviction', () => {
    test('returns false for evicted workers (not in memory)', async () => {
      manager = new WorkerManager(makeConfig());

      // No worker injected — simulates evicted state
      const result = await manager.sendMessage('w-evict-gone', 'Hello?');
      expect(result).toBe(false);
    });

    test('succeeds for in-memory completed workers (before eviction)', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-followup' },
        { type: 'result', subtype: 'success', session_id: 'sess-followup' },
      ];

      const result = await manager.sendMessage('w-evict-1', 'Continue please');
      expect(result).toBe(true);
    });
  });

  describe('Session cleanup during eviction', () => {
    test('deletes session for evicted workers', () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        lastActivity: Date.now() - 11 * 60 * 1000,
      });
      injectWorker(manager, worker, { withSession: true });

      const sessions = (manager as any).sessions as Map<string, any>;
      expect(sessions.has('w-evict-1')).toBe(true);

      (manager as any).evictCompletedWorkers();

      expect(sessions.has('w-evict-1')).toBe(false);
    });

    test('preserves session for retained workers', () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        lastActivity: Date.now() - 5 * 60 * 1000, // within retention
      });
      injectWorker(manager, worker, { withSession: true });

      const sessions = (manager as any).sessions as Map<string, any>;
      expect(sessions.has('w-evict-1')).toBe(true);

      (manager as any).evictCompletedWorkers();

      expect(sessions.has('w-evict-1')).toBe(true);
    });
  });

  describe('Worktree cleanup during eviction', () => {
    test('attempts cleanup when worktreePath exists on disk', () => {
      manager = new WorkerManager(makeConfig());

      const worktreePath = '/tmp/repo/.buildd-worktrees/test-branch';
      mockExistsSync = (p: string) => p === worktreePath;

      const worker = makeWorker({
        status: 'done',
        lastActivity: Date.now() - 11 * 60 * 1000,
        worktreePath,
      });
      injectWorker(manager, worker);

      // Eviction should proceed (worktree cleanup is async and best-effort)
      (manager as any).evictCompletedWorkers();

      const workers = (manager as any).workers as Map<string, LocalWorker>;
      expect(workers.has('w-evict-1')).toBe(false);
    });

    test('skips cleanup when no worktreePath set', () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        lastActivity: Date.now() - 11 * 60 * 1000,
        worktreePath: undefined,
      });
      injectWorker(manager, worker);

      (manager as any).evictCompletedWorkers();

      const workers = (manager as any).workers as Map<string, LocalWorker>;
      expect(workers.has('w-evict-1')).toBe(false);
    });

    test('skips cleanup when worktreePath not on disk', () => {
      manager = new WorkerManager(makeConfig());

      mockExistsSync = () => false; // worktree path doesn't exist

      const worker = makeWorker({
        status: 'done',
        lastActivity: Date.now() - 11 * 60 * 1000,
        worktreePath: '/tmp/repo/.buildd-worktrees/gone-branch',
      });
      injectWorker(manager, worker);

      (manager as any).evictCompletedWorkers();

      const workers = (manager as any).workers as Map<string, LocalWorker>;
      expect(workers.has('w-evict-1')).toBe(false);
    });
  });

  describe('getWorker() disk fallback', () => {
    test('falls through to loadWorker for evicted workers', () => {
      manager = new WorkerManager(makeConfig());

      const diskWorker = makeWorker({
        id: 'w-disk-1',
        status: 'done',
      });
      mockLoadWorker.mockImplementation((id: string) =>
        id === 'w-disk-1' ? diskWorker : null
      );

      // Not in memory — should fall through to disk
      const result = manager.getWorker('w-disk-1');
      expect(result).toBeDefined();
      expect(result?.id).toBe('w-disk-1');
      expect(result?.status).toBe('done');
    });

    test('returns undefined when not on disk either', () => {
      manager = new WorkerManager(makeConfig());

      mockLoadWorker.mockImplementation(() => null);

      const result = manager.getWorker('w-nonexistent');
      expect(result).toBeUndefined();
    });

    test('prefers in-memory over disk', () => {
      manager = new WorkerManager(makeConfig());

      const memWorker = makeWorker({
        id: 'w-mem-1',
        status: 'done',
        currentAction: 'In memory',
      });
      injectWorker(manager, memWorker);

      const diskWorker = makeWorker({
        id: 'w-mem-1',
        status: 'done',
        currentAction: 'On disk',
      });
      mockLoadWorker.mockImplementation(() => diskWorker);

      const result = manager.getWorker('w-mem-1');
      expect(result?.currentAction).toBe('In memory');
    });
  });
});
