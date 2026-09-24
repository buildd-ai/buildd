/**
 * WorkerManager.sweepTerminalWorktreesOnDisk — the wiring around
 * sweepTerminalWorktrees (whose own behaviour is pinned, against real git, in
 * terminal-worktree-sweep.test.ts).
 *
 * Pinned here: in-memory workers are filtered out of the records (eviction
 * owns them) but passed as owners; the in-flight setup map is passed live;
 * worktreePath is cleared on removed/archived/missing and kept on `kept`; a
 * kept record is not retried; the disk cache is reset after a pass.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/terminal-worktree-sweep-wiring.test.ts
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { LocalWorker, LocalUIConfig } from '../../src/types';

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() {
      return { async next() { return { value: undefined, done: true }; } };
    },
  }),
}));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mock(async () => ({}));
    getWorkerRemote = mock(async () => null);
    claimTask = mock(async () => ({ workers: [] }));
    getWorkspaceConfig = mock(async () => ({ configStatus: 'unconfigured' }));
    listWorkspaces = mock(async () => []);
    sendHeartbeat = mock(async () => ({}));
    runCleanup = mock(async () => ({}));
    searchFeedbackMemories = mock(async () => []);
    setOutbox() {}
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

type DiskRecord = { id: string; status: string; worktreePath?: string; branch?: string; lastActivity: number };
let disk: DiskRecord[] = [];
const mockSaveWorker = mock((w: DiskRecord) => {
  disk = disk.map(r => (r.id === w.id ? { ...w } : r));
});
const mockResetCache = mock(() => {});

mock.module('../../src/worker-store', () => ({
  saveWorker: mockSaveWorker,
  loadAllWorkers: () => disk.map(r => ({ ...r })),
  loadTerminalWorkersCached: () => [],
  __resetDiskWorkersCache: mockResetCache,
  loadWorker: (id: string) => {
    const r = disk.find(d => d.id === id);
    return r ? { ...r } : null;
  },
  deleteWorker: () => {},
}));

const mockSweep = mock(async (_opts: any) => [] as Array<{ id: string; outcome: string }>);
mock.module('../../src/terminal-worktree-sweep', () => ({
  sweepTerminalWorktrees: mockSweep,
}));

mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ tools: [], envKeys: [], mcp: [] }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  parseMcpJson: () => [],
  scanMcpServersRich: () => [],
  checkBwrapSupport: () => true,
  checkBwrapMountIsolationSupport: () => true,
}));

mock.module('../../src/session-logger', () => ({
  sessionLog: () => {},
  cleanupOldLogs: () => {},
  readSessionLogs: () => [],
  claimLog: () => {},
}));

mock.module('pusher-js', () => ({
  default: class { subscribe() { return { bind() {} }; } connection = { bind() {} }; },
}));

const { WorkerManager } = await import('../../src/workers');

const config: LocalUIConfig = {
  projectRoots: ['/tmp'],
  builddServer: 'http://localhost:3000',
  apiKey: 'test-key',
  maxConcurrent: 3,
  model: 'claude-sonnet-4-20250514',
  serverless: true,
} as LocalUIConfig;

const OLD = Date.now() - 60 * 60 * 1000;
const wt = (name: string) => `/repo/.buildd-worktrees/${name}`;

describe('WorkerManager.sweepTerminalWorktreesOnDisk', () => {
  let manager: any;

  beforeEach(() => {
    disk = [
      { id: 'd-removed', status: 'done', worktreePath: wt('a'), lastActivity: OLD },
      { id: 'd-archived', status: 'error', worktreePath: wt('b'), lastActivity: OLD },
      { id: 'd-missing', status: 'done', worktreePath: wt('c'), lastActivity: OLD },
      { id: 'd-kept', status: 'error', worktreePath: wt('d'), lastActivity: OLD },
      { id: 'in-memory', status: 'done', worktreePath: wt('e'), lastActivity: OLD },
    ];
    mockSweep.mockReset();
    mockSweep.mockImplementation(async () => [
      { id: 'd-removed', outcome: 'removed' },
      { id: 'd-archived', outcome: 'archived' },
      { id: 'd-missing', outcome: 'missing' },
      { id: 'd-kept', outcome: 'kept' },
    ]);
    mockSaveWorker.mockClear();
    mockResetCache.mockClear();
    manager = new WorkerManager(config);
    manager.workers.set('in-memory', { id: 'in-memory', status: 'done', worktreePath: wt('e') } as unknown as LocalWorker);
  });

  afterEach(() => manager?.destroy?.());

  test('passes only disk-only records, with every in-memory worker as an owner', async () => {
    await manager.sweepTerminalWorktreesOnDisk();

    const opts = mockSweep.mock.calls[0][0];
    expect([...opts.records].map((r: DiskRecord) => r.id).sort()).toEqual(['d-archived', 'd-kept', 'd-missing', 'd-removed']);
    expect(opts.inMemoryWorkers).toBe(manager.workers);
    // Live, not a snapshot: a setup that starts mid-pass is still seen.
    expect(opts.busyRepos).toBe(manager.worktreeSetupsInFlight);
  });

  test('clears worktreePath on removed/archived/missing, keeps it on kept, resets the cache', async () => {
    await manager.sweepTerminalWorktreesOnDisk();

    const byId = Object.fromEntries(disk.map(r => [r.id, r]));
    expect(byId['d-removed'].worktreePath).toBeUndefined();
    expect(byId['d-archived'].worktreePath).toBeUndefined();
    expect(byId['d-missing'].worktreePath).toBeUndefined();
    expect(byId['d-kept'].worktreePath).toBe(wt('d'));
    expect(mockSaveWorker.mock.calls.map(([w]) => w.id).sort()).toEqual(['d-archived', 'd-missing', 'd-removed']);
    expect(mockResetCache).toHaveBeenCalled();
  });

  test('a kept record is passed as skipped on the next pass', async () => {
    await manager.sweepTerminalWorktreesOnDisk();
    await manager.sweepTerminalWorktreesOnDisk();

    const second = mockSweep.mock.calls[1][0];
    expect(second.skipIds.has('d-kept')).toBe(true);
  });

  test('a pass that finds nothing does not reset the cache', async () => {
    mockSweep.mockImplementation(async () => []);
    await manager.sweepTerminalWorktreesOnDisk();
    expect(mockResetCache).not.toHaveBeenCalled();
    expect(mockSaveWorker).not.toHaveBeenCalled();
  });

  test('overlapping passes do not run concurrently', async () => {
    let release!: () => void;
    mockSweep.mockImplementation(() => new Promise(r => { release = () => r([]); }));
    const first = manager.sweepTerminalWorktreesOnDisk();
    await manager.sweepTerminalWorktreesOnDisk();
    expect(mockSweep).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});
