/**
 * A person's hold in the claim loop (spec "Runner on your terminal" R-32,
 * R-34, AC-16, AC-17, AC-19): while held the poll and broadcast assignments
 * claim nothing; a claim a person makes still runs; lifting the hold, by hand
 * or at its `until`, claims again. The heartbeat carries the hold (R-35).
 */
import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { tmpdir } from 'os';
import { initTestWorkspace, getTestWorkspace, cleanupTestWorkspace } from '../test-workspace';
import type { LocalUIConfig } from '../../src/types';
import type { RunnerHold } from '@buildd/shared';

// ─── Spy on claimLog directly ─────────────────────────────────────────────────

const claimLogSpy = mock((_entry: any) => {});

mock.module('../../src/session-logger', () => ({
  claimLog: claimLogSpy,
  sessionLog: () => {},
  readSessionLogs: () => [],
  cleanupOldLogs: () => {},
  readClaimLogs: () => [],
}));

// ─── Standard module mocks ────────────────────────────────────────────────────

mock.module('pusher-js', () => ({
  default: class MockPusher {
    connection = { bind: () => {} };
    subscribe = () => ({ bind: () => {}, unbind_all: () => {}, unbind: () => {} });
    unsubscribe = () => {};
    disconnect = () => {};
  },
}));

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (_opts: any) => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { value: undefined, done: true };
        },
      };
    },
  }),
}));

const mockClaimTask = mock(async () => ({ workers: [{ id: 'w-1', branch: 'buildd/test', task: null }] }));
const mockUpdateWorker = mock(async () => ({}));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    claimTask = mockClaimTask;
    updateWorker = mockUpdateWorker;
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
    resolve: () => getTestWorkspace(),
    debugResolve: () => ({}),
    listLocalDirectories: () => [],
    getPathOverrides: () => ({}),
    setPathOverride: () => {},
    scanGitRepos: () => [],
    getProjectRoots: () => [tmpdir()],
  }),
}));

mock.module('../../src/worker-store', () => ({
  saveWorker: () => {},
  loadAllWorkers: () => [],
  loadTerminalWorkersCached: () => [],
  __resetDiskWorkersCache: () => {},
  loadWorker: () => null,
  deleteWorker: () => {},
}));

mock.module('../../src/skills.js', () => ({
  syncSkillToLocal: async () => {},
}));

mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ tools: [], envKeys: [], mcp: [] }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  parseMcpJson: () => [],
  scanMcpServersRich: () => [],
  checkBwrapSupport: () => true,
  checkBwrapMountIsolationSupport: () => true,
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

const { WorkerManager } = await import('../../src/workers');
const { initRunnerHold } = await import('../../src/runner-hold');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<LocalUIConfig>): LocalUIConfig {
  return {
    projectsRoot: '/tmp',
    builddServer: 'http://localhost:3000',
    apiKey: 'test-key',
    maxConcurrent: 2,
    model: 'claude-sonnet-4-5-20250929',
    serverless: true,
    ...overrides,
  };
}

function makeTask() {
  return {
    id: 'task-42',
    title: 'Test task',
    description: 'Do something',
    workspaceId: 'ws-1',
    workspace: { name: 'test-workspace' },
    status: 'waiting',
    priority: 1,
  };
}

function collectEvents(manager: InstanceType<typeof WorkerManager>) {
  const events: any[] = [];
  manager.onEvent((e: any) => events.push(e));
  return events;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

function memoryHold(start: RunnerHold | null = null) {
  let stored: RunnerHold | null = start;
  return { read: () => stored, write: (h: RunnerHold | null) => { stored = h; }, get: () => stored };
}

describe('claim loop under a hold', () => {
  let manager: InstanceType<typeof WorkerManager>;

  afterAll(() => cleanupTestWorkspace());
  beforeEach(() => {
    initTestWorkspace();
    mockClaimTask.mockReset();
    mockClaimTask.mockImplementation(async () => ({ workers: [] }));
  });
  afterEach(() => {
    manager?.destroy();
    initRunnerHold(null);
  });

  test('held: the poll claims nothing and never asks the server', async () => {
    const store = initRunnerHold({ io: memoryHold(), logger: { log: () => {}, warn: () => {} } })!;
    store.hold(null);
    manager = new WorkerManager(makeConfig());
    expect(await manager.claimPendingTasks()).toEqual([]);
    expect(mockClaimTask).not.toHaveBeenCalled();
  });

  test('held: a broadcast assignment is not claimed', async () => {
    initRunnerHold({ io: memoryHold(), logger: { log: () => {}, warn: () => {} } })!.hold(null);
    manager = new WorkerManager(makeConfig());
    expect(await manager.claimAndStart(makeTask())).toBeNull();
    expect(mockClaimTask).not.toHaveBeenCalled();
  });

  test('held: a claim a person makes still goes to the server (R-34)', async () => {
    initRunnerHold({ io: memoryHold(), logger: { log: () => {}, warn: () => {} } })!.hold(null);
    manager = new WorkerManager(makeConfig());
    await manager.claimAndStart(makeTask(), { byPerson: true }).catch(() => null);
    expect(mockClaimTask).toHaveBeenCalledTimes(1);
    expect((mockClaimTask.mock.calls[0] as any[])[3]).toBe('task-42');
  });

  test('resumed: the next poll claims again (AC-17)', async () => {
    const store = initRunnerHold({ io: memoryHold(), logger: { log: () => {}, warn: () => {} } })!;
    store.hold(null);
    manager = new WorkerManager(makeConfig());
    await manager.claimPendingTasks();
    expect(mockClaimTask).not.toHaveBeenCalled();
    store.resume();
    await manager.claimPendingTasks();
    expect(mockClaimTask).toHaveBeenCalledTimes(1);
    // The broad claim says it is not held, so the server's backstop lets it through.
    expect((mockClaimTask.mock.calls[0] as any[])[6]?.hold).toBeNull();
  });

  test('--for: once until passes the poll claims again with no command (AC-19)', async () => {
    let now = Date.now();
    const store = initRunnerHold({ io: memoryHold(), now: () => now, setTimer: () => 0 as any, clearTimer: () => {}, logger: { log: () => {}, warn: () => {} } })!;
    store.hold(60_000);
    manager = new WorkerManager(makeConfig());
    await manager.claimPendingTasks();
    expect(mockClaimTask).not.toHaveBeenCalled();
    now += 61_000;
    await manager.claimPendingTasks();
    expect(mockClaimTask).toHaveBeenCalledTimes(1);
  });

  test('the heartbeat reports the hold, then null once lifted (R-35)', async () => {
    const store = initRunnerHold({ io: memoryHold(), logger: { log: () => {}, warn: () => {} } })!;
    const hold = store.hold(null);
    manager = new WorkerManager(makeConfig());
    (manager as any).environment = { tools: [], envKeys: [], mcp: [], labels: {}, scannedAt: new Date().toISOString() };
    expect((manager as any).heartbeatEnvironment().hold).toEqual(hold);
    store.resume();
    expect((manager as any).heartbeatEnvironment().hold).toBeNull();
  });
});

describe('Pause and concurrency 0 from buildd.dev (spec 97b1bd0b R-18, AC-12)', () => {
  let manager: InstanceType<typeof WorkerManager>;
  const quiet = { log: () => {}, warn: () => {} };

  afterAll(() => cleanupTestWorkspace());
  beforeEach(() => {
    initTestWorkspace();
    mockClaimTask.mockReset();
    mockClaimTask.mockImplementation(async () => ({ workers: [] }));
  });
  afterEach(() => {
    manager?.destroy();
    initRunnerHold(null);
  });

  test('a dashboard Pause: the poll claims nothing and the running agents are left to finish', async () => {
    const store = initRunnerHold({ io: memoryHold(), logger: quiet })!;
    manager = new WorkerManager(makeConfig({ maxConcurrent: 3 }));
    const running = [
      { id: 'w-a', status: 'working', taskTitle: 'a' },
      { id: 'w-b', status: 'working', taskTitle: 'b' },
    ];
    for (const w of running) (manager as any).workers.set(w.id, { ...w });
    expect(manager.applyServerHold({ paused: true, setBy: 'Max', setAt: Date.now() })).toBe(true);
    expect(store.isHeld()).toBe(true);
    expect(store.changeMeta()).toMatchObject({ origin: 'dashboard', setBy: 'Max' });
    expect(await manager.claimPendingTasks()).toEqual([]);
    expect(mockClaimTask).not.toHaveBeenCalled();
    // Nothing was stopped or paused: both still work until they finish.
    expect([...(manager as any).workers.values()].map((w: any) => w.status)).toEqual(['working', 'working']);
    // The slots stay as they were, so Resume brings them back.
    expect((manager as any).config.maxConcurrent).toBe(3);
  });

  test('a dashboard Resume lifts the hold and the next poll claims again, at the slots it had', async () => {
    const store = initRunnerHold({ io: memoryHold(), logger: quiet })!;
    store.hold(null, { changedAt: 1000, origin: 'dashboard', setBy: 'Max' });
    manager = new WorkerManager(makeConfig({ maxConcurrent: 3 }));
    expect(manager.applyServerHold({ paused: false, setBy: 'Max', setAt: 2000 })).toBe(true);
    expect(store.isHeld()).toBe(false);
    await manager.claimPendingTasks();
    expect(mockClaimTask).toHaveBeenCalledTimes(1);
    expect((manager as any).config.maxConcurrent).toBe(3);
  });

  test('a `buildd resume` made after the dashboard Pause is not overwritten', async () => {
    const store = initRunnerHold({ io: memoryHold(), logger: quiet })!;
    store.hold(null, { changedAt: 1000, origin: 'dashboard', setBy: 'Max' });
    store.resume(); // on this machine, now
    manager = new WorkerManager(makeConfig());
    expect(manager.applyServerHold({ paused: true, setBy: 'Max', setAt: 1000 })).toBe(false);
    expect(store.isHeld()).toBe(false);
  });

  test('concurrency 0: the poll claims nothing and never asks the server', async () => {
    initRunnerHold({ io: memoryHold(), logger: quiet });
    manager = new WorkerManager(makeConfig({ maxConcurrent: 0 }));
    expect(await manager.claimPendingTasks()).toEqual([]);
    expect(mockClaimTask).not.toHaveBeenCalled();
  });

  test('a dashboard 0 is applied and starts no claim', async () => {
    initRunnerHold({ io: memoryHold(), logger: quiet });
    manager = new WorkerManager(makeConfig({ maxConcurrent: 3 }));
    expect(manager.applyServerSlots({ slots: 0, setBy: 'Max', setAt: Date.now() + 1000 })).toBe(true);
    expect((manager as any).config.maxConcurrent).toBe(0);
    expect(await manager.claimPendingTasks()).toEqual([]);
    expect(mockClaimTask).not.toHaveBeenCalled();
  });

  test('the heartbeat carries the time of the last hold or resume', async () => {
    const store = initRunnerHold({ io: memoryHold(), logger: quiet })!;
    store.hold(null, { changedAt: 4242, origin: 'machine', setBy: null });
    manager = new WorkerManager(makeConfig());
    (manager as any).environment = { tools: [], envKeys: [], mcp: [], labels: {}, scannedAt: new Date().toISOString() };
    const send = (manager as any).buildd.sendHeartbeat;
    send.mockClear();
    await (manager as any).sendHeartbeat();
    const args = send.mock.calls.at(-1) as any[];
    expect(args.at(-1)).toBe(4242);
  });
});
