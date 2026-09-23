/**
 * Regression: `WorkerManager.destroy()` force-removed the worktree of EVERY
 * worker with a live session.
 *
 * Two defects in one block:
 *
 *  1. No ownership check. It shelled out to `git worktree remove --force`
 *     inline (its own `require('child_process')` copy), on the one code path
 *     where every worker is torn down at once.
 *  2. No retention rule. `done` and `waiting` workers keep their worktree for
 *     session resume — the `finally` block in startSession says so explicitly —
 *     so every runner restart ate a resumable tree and left the persisted
 *     record pointing at a path that no longer existed.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/destroy-worktree-retention.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import type { LocalWorker, LocalUIConfig } from '../../src/types';
import { __setGitOpsDeps, __resetGitOpsDeps } from '../../src/git-operations';

// ─── Mocks (mirror eviction-worktree-ownership.test.ts) ──────────────────────

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    streamInput: mock(() => {}),
    supportedModels: async () => [],
    [Symbol.asyncIterator]() {
      return { async next() { return { value: undefined, done: true }; } };
    },
  }),
}));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mock(async () => ({}));
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

mock.module('fs', () => ({
  existsSync: () => false,
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
  loadTerminalWorkersCached: () => [],
  __resetDiskWorkersCache: () => {},
  loadWorker: mock(() => null),
  deleteWorker: mock(() => {}),
}));

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

// `destroy()` removes synchronously, so the assertion is on execSync itself
// rather than on a cleanupWorktree spy.
let syncCmds: string[] = [];
let rmPaths: string[] = [];
/** `git rev-list --count origin/<b>..<b>` — everything pushed by default. */
let unpushedCount = '0';

beforeAll(() => {
  __setGitOpsDeps({
    execSync: ((cmd: string) => {
      syncCmds.push(cmd);
      if (cmd.includes('rev-list --count')) return unpushedCount;
      return '';
    }) as any,
    execFile: ((_f: any, _a: any, _o: any, cb: any) => cb(null, '', '')) as any,
    existsSync: (() => false) as any,
    mkdirSync: (() => {}) as any,
    readFileSync: (() => '') as any,
    appendFileSync: () => {},
    rmSync: ((p: string) => { rmPaths.push(p); }) as any,
    sessionLog: () => {},
  });
});

afterAll(() => {
  __resetGitOpsDeps();
});

const { WorkerManager } = await import('../../src/workers');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(): LocalUIConfig {
  return {
    projectsRoot: '/tmp',
    builddServer: 'http://localhost:3000',
    apiKey: 'test-key',
    maxConcurrent: 4,
    model: 'claude-sonnet-4-5-20250929',
    serverless: true,
  };
}

function makeWorker(id: string, overrides?: Partial<LocalWorker>): LocalWorker {
  return {
    id,
    taskId: `task-${id}`,
    taskTitle: 'Test task',
    taskDescription: 'Do something',
    workspaceId: 'ws-1',
    workspaceName: 'test-workspace',
    branch: `buildd/${id}-slug`,
    status: 'working',
    hasNewActivity: false,
    lastActivity: Date.now(),
    startedAt: Date.now(),
    milestones: [],
    currentAction: 'Working',
    commits: [],
    output: [],
    toolCalls: [],
    messages: [],
    phaseText: null,
    phaseStart: null,
    phaseToolCount: 0,
    phaseTools: [],
    subagentTasks: [],
    subagentTasksObservedCount: 0,
    checkpoints: [],
    checkpointEvents: new Set(),
    ...overrides,
  } as LocalWorker;
}

/** In the workers map only — `destroy()` iterates sessions, not workers. */
function seedWorkerOnly(manager: any, worker: LocalWorker) {
  (manager.workers as Map<string, LocalWorker>).set(worker.id, worker);
}

function seed(manager: any, worker: LocalWorker) {
  seedWorkerOnly(manager, worker);
  (manager.sessions as Map<string, unknown>).set(worker.id, {
    repoPath: '/tmp/repo',
    abortController: new AbortController(),
    inputStream: { end: () => {} },
  });
}

const removedPaths = () =>
  syncCmds
    .filter(c => c.includes('worktree remove --force'))
    .map(c => (c.match(/"([^"]+)"/) ?? [])[1]);

describe('WorkerManager.destroy() worktree teardown', () => {
  let manager: any;

  beforeEach(() => {
    syncCmds = [];
    rmPaths = [];
    unpushedCount = '0';
    manager = new WorkerManager(makeConfig());
  });

  test('keeps the worktree of a `done` worker — session resume depends on it', () => {
    const wt = '/tmp/repo/.buildd-worktrees/buildd_w-done-slug';
    seed(manager, makeWorker('w-done', { status: 'done', worktreePath: wt }));

    manager.destroy();

    expect(removedPaths()).not.toContain(wt);
    expect(rmPaths).not.toContain(wt);
  });

  test('keeps the worktree of a `waiting` worker', () => {
    const wt = '/tmp/repo/.buildd-worktrees/buildd_w-wait-slug';
    seed(manager, makeWorker('w-wait', { status: 'waiting', worktreePath: wt }));

    manager.destroy();

    expect(removedPaths()).not.toContain(wt);
    expect(rmPaths).not.toContain(wt);
  });

  test('does not remove a path another live worker also owns', () => {
    // Branch-keyed worktree paths make this reachable: an older failed worker
    // retains its record (and a session) while a newer worker on the same task
    // is checked out at the same directory. Only the older one has a session,
    // so only its teardown runs — and it must not take the live one's tree.
    const shared = '/tmp/repo/.buildd-worktrees/mission_shared';
    seed(manager, makeWorker('w-old', { status: 'error', worktreePath: shared }));
    seedWorkerOnly(manager, makeWorker('w-new', { status: 'working', worktreePath: shared }));

    manager.destroy();

    expect(removedPaths()).not.toContain(shared);
    expect(rmPaths).not.toContain(shared);
  });

  test('retains a tree whose commits are not on origin', () => {
    const wt = '/tmp/repo/.buildd-worktrees/buildd_w-unpushed-slug';
    unpushedCount = '2';
    seed(manager, makeWorker('w-unpushed', { status: 'error', worktreePath: wt }));

    manager.destroy();

    expect(removedPaths()).not.toContain(wt);
    expect(rmPaths).not.toContain(wt);
  });

  test('still removes an unowned, fully-pushed, non-terminal-retained worktree', () => {
    const wt = '/tmp/repo/.buildd-worktrees/buildd_w-err-slug';
    seed(manager, makeWorker('w-err', { status: 'error', worktreePath: wt }));

    manager.destroy();

    expect(removedPaths()).toContain(wt);
  });
});
