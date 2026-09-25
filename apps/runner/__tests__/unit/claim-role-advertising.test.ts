/**
 * Runner wiring: both claim call sites send advertisedRoleSlugs(environment)
 * as the 5th claimTask argument (availableSkills). role-advertising.test.ts
 * only covers the pure helper; if either call site regresses to `undefined`,
 * no runner ever claims a visual-auditor task and every surface audit holds
 * its mission with CI green.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { LocalUIConfig } from '../../src/types';

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
    resolve: () => '/tmp/test-workspace',
    debugResolve: () => ({}),
    listLocalDirectories: () => [],
    getPathOverrides: () => ({}),
    setPathOverride: () => {},
    scanGitRepos: () => [],
    getProjectRoots: () => ['/tmp'],
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

// Mutable so each test picks what env-scan "found" before constructing the manager.
let scannedEnvKeys: string[] = [];
mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ tools: [], envKeys: scannedEnvKeys, mcp: [] }),
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

describe('claimTask availableSkills wiring', () => {
  let manager: InstanceType<typeof WorkerManager> | undefined;

  beforeEach(() => {
    mockClaimTask.mockReset();
    mockClaimTask.mockImplementation(async () => ({ workers: [] }));
  });

  afterEach(() => {
    manager?.destroy();
    manager = undefined;
    scannedEnvKeys = [];
  });

  function availableSkillsOfLastCall() {
    const calls = mockClaimTask.mock.calls as any[][];
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1][4];
  }

  test('poll path advertises visual-auditor when env-scan found a browser', async () => {
    scannedEnvKeys = ['browser'];
    manager = new WorkerManager(makeConfig());
    await manager.claimPendingTasks();
    expect(availableSkillsOfLastCall()).toEqual(['visual-auditor']);
  });

  test('targeted claim advertises visual-auditor when env-scan found a browser', async () => {
    scannedEnvKeys = ['browser'];
    manager = new WorkerManager(makeConfig());
    await manager.claimAndStart(makeTask() as any).catch(() => {});
    expect(availableSkillsOfLastCall()).toEqual(['visual-auditor']);
  });

  test('poll path sends undefined without a browser', async () => {
    manager = new WorkerManager(makeConfig());
    await manager.claimPendingTasks();
    expect(availableSkillsOfLastCall()).toBeUndefined();
  });

  test('targeted claim sends undefined without a browser', async () => {
    manager = new WorkerManager(makeConfig());
    await manager.claimAndStart(makeTask() as any).catch(() => {});
    expect(availableSkillsOfLastCall()).toBeUndefined();
  });
});
