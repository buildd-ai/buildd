/**
 * E2E test worktree cleanup tests — verifies that branches matching
 * e2e test patterns (e.g. `--e2e-test-`) are treated as ephemeral
 * with immediate worktree cleanup and 0 eviction retention.
 *
 * Run: bun test apps/runner/__tests__/unit/e2e-worktree-cleanup.test.ts
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
  claimLog: () => {},
}));

mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ platform: 'linux', arch: 'x64', tools: [], envKeys: [] }),
  checkMcpPreFlight: () => ({ warnings: [] }),
}));

const { WorkerManager, isEphemeralTestBranch } = await import('../../src/workers');

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
    id: 'w-e2e-1',
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
) {
  const workers = (manager as any).workers as Map<string, LocalWorker>;
  workers.set(worker.id, worker);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('isEphemeralTestBranch', () => {
  test('matches e2e-test branch pattern', () => {
    expect(isEphemeralTestBranch('buildd/abcd1234--e2e-test-echo-test-1234')).toBe(true);
  });

  test('matches with different prefixes', () => {
    expect(isEphemeralTestBranch('task-abcd1234--e2e-test-long-task')).toBe(true);
    expect(isEphemeralTestBranch('custom/prefix--e2e-test-concurrent')).toBe(true);
  });

  test('does not match regular branches', () => {
    expect(isEphemeralTestBranch('buildd/abcd1234-my-feature')).toBe(false);
    expect(isEphemeralTestBranch('main')).toBe(false);
    expect(isEphemeralTestBranch('feature/new-thing')).toBe(false);
  });

  test('handles undefined/empty branch', () => {
    expect(isEphemeralTestBranch(undefined)).toBe(false);
    expect(isEphemeralTestBranch('')).toBe(false);
  });
});

describe('E2E test worktree eviction', () => {
  let manager: InstanceType<typeof WorkerManager>;

  afterEach(() => {
    manager?.destroy();
    mockExistsSync = () => false;
  });

  beforeEach(() => {
    queryCallCount = 0;
    mockMessages = [];
    mockUpdateWorker.mockClear();
    mockSaveWorker.mockClear();
    mockLoadWorker.mockClear();
    mockLoadAllWorkers.mockClear();
  });

  test('immediately evicts done e2e-test workers (0 retention)', () => {
    manager = new WorkerManager(makeConfig());

    // E2E test worker that just completed (0 seconds ago)
    const worker = makeWorker({
      status: 'done',
      branch: 'buildd/abcd1234--e2e-test-echo-test-123',
      lastActivity: Date.now(), // just now — would normally be retained
    });
    injectWorker(manager, worker);

    (manager as any).workerSync.evictCompletedWorkers();

    const workers = (manager as any).workers as Map<string, LocalWorker>;
    expect(workers.has('w-e2e-1')).toBe(false);
  });

  test('immediately evicts error e2e-test workers (0 retention)', () => {
    manager = new WorkerManager(makeConfig());

    const worker = makeWorker({
      id: 'w-e2e-err',
      status: 'error',
      branch: 'buildd/abcd1234--e2e-test-abort-test',
      lastActivity: Date.now(),
    });
    injectWorker(manager, worker);

    (manager as any).workerSync.evictCompletedWorkers();

    const workers = (manager as any).workers as Map<string, LocalWorker>;
    expect(workers.has('w-e2e-err')).toBe(false);
  });

  test('still retains recent non-e2e done workers', () => {
    manager = new WorkerManager(makeConfig());

    const worker = makeWorker({
      status: 'done',
      branch: 'buildd/abcd1234-real-feature',
      lastActivity: Date.now(), // just now
    });
    injectWorker(manager, worker);

    (manager as any).workerSync.evictCompletedWorkers();

    const workers = (manager as any).workers as Map<string, LocalWorker>;
    expect(workers.has('w-e2e-1')).toBe(true);
  });

  test('cleans up worktree for evicted e2e-test worker', () => {
    manager = new WorkerManager(makeConfig());

    const worktreePath = '/tmp/repo/.buildd-worktrees/buildd_abcd1234--e2e-test-echo';
    mockExistsSync = (p: string) => p === worktreePath;

    const worker = makeWorker({
      status: 'done',
      branch: 'buildd/abcd1234--e2e-test-echo',
      worktreePath,
      lastActivity: Date.now(),
    });
    injectWorker(manager, worker);

    (manager as any).workerSync.evictCompletedWorkers();

    const workers = (manager as any).workers as Map<string, LocalWorker>;
    expect(workers.has('w-e2e-1')).toBe(false);
  });
});
