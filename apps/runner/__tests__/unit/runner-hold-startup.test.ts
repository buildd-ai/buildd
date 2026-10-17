/**
 * A runner that starts on hold claims nothing at startup (task 7d42431c; spec
 * "Runner on your terminal" R-32..R-35, R-38).
 *
 * The bug: after an auto-update restart with `hold` in config.json, three new
 * agents started within a minute. index.ts constructed the WorkerManager before
 * it set up the hold, and the constructor's Pusher setup runs a startup claim
 * poll at once. That poll's gate read "no hold store" as "not held" and its
 * claim told the server `hold: null`, so the server's backstop let it through.
 *
 * Temp state only: fs, the server client and Pusher are mocked; nothing
 * touches ~/.buildd or a real server.
 */
import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { readFileSync as realReadFileSync } from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initTestWorkspace, getTestWorkspace, cleanupTestWorkspace } from '../test-workspace';
import type { LocalUIConfig } from '../../src/types';
import type { RunnerHold } from '@buildd/shared';

let stateChange: ((s: { previous: string; current: string }) => void) | null = null;
const indexSource = realReadFileSync(join(import.meta.dir, '../../src/index.ts'), 'utf8');

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
    connection = { bind: (_ev: string, fn: (s: any) => void) => { stateChange = fn; } };
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


function makeConfig(overrides?: Partial<LocalUIConfig>): LocalUIConfig {
  return {
    projectsRoot: '/tmp',
    builddServer: 'http://127.0.0.1:1',
    apiKey: 'test-key',
    maxConcurrent: 3,
    model: 'claude-sonnet-4-5-20250929',
    serverless: true,
    // Pusher configured: the constructor subscribes and runs its startup poll.
    pusherKey: 'k',
    pusherCluster: 'c',
    ...overrides,
  } as LocalUIConfig;
}

function memoryHold(start: RunnerHold | null = null) {
  let stored: RunnerHold | null = start;
  return { read: () => stored, write: (h: RunnerHold | null) => { stored = h; } };
}

const quiet = { log: () => {}, warn: () => {} };
const settle = () => new Promise(r => setTimeout(r, 20));

describe('a runner that starts on hold', () => {
  let manager: InstanceType<typeof WorkerManager> | null = null;

  afterAll(() => cleanupTestWorkspace());
  beforeEach(() => {
    initTestWorkspace();
    stateChange = null;
    mockClaimTask.mockReset();
    mockClaimTask.mockImplementation(async () => ({ workers: [{ id: 'w-1', branch: 'buildd/test', task: null }] }));
  });
  afterEach(() => {
    manager?.destroy();
    manager = null;
    initRunnerHold(null);
  });

  test('makes no startup claim when the hold is set up before the manager', async () => {
    initRunnerHold({ io: memoryHold({ since: new Date().toISOString(), until: null }), logger: quiet });
    manager = new WorkerManager(makeConfig());
    await settle();
    expect(mockClaimTask).not.toHaveBeenCalled();
  });

  test('why order matters: a manager built before the hold claims at once, telling the server hold: null', async () => {
    manager = new WorkerManager(makeConfig());
    await settle();
    expect(mockClaimTask).toHaveBeenCalled();
    expect((mockClaimTask.mock.calls[0] as any[])[6]?.hold).toBeNull();
  });

  test('makes no claim when Pusher reconnects while held', async () => {
    initRunnerHold({ io: memoryHold({ since: new Date().toISOString(), until: null }), logger: quiet });
    manager = new WorkerManager(makeConfig());
    await settle();
    expect(stateChange).not.toBeNull();
    stateChange!({ previous: 'connecting', current: 'connected' });
    await settle();
    expect(mockClaimTask).not.toHaveBeenCalled();
  });

  test('index.ts sets up the hold before it constructs any WorkerManager', () => {
    // Strip comments so prose naming either symbol does not count.
    const code = indexSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const hold = code.indexOf('initRunnerHold(');
    const firstManager = code.indexOf('new WorkerManager(');
    expect(hold).toBeGreaterThan(-1);
    expect(firstManager).toBeGreaterThan(-1);
    expect(hold).toBeLessThan(firstManager);
  });

  test('idle jobs (knowledge ingest, Scout, model probe) do not start while held', async () => {
    initRunnerHold({ io: memoryHold({ since: new Date().toISOString(), until: null }), logger: quiet });
    manager = new WorkerManager(makeConfig({ pusherKey: undefined, pusherCluster: undefined } as any));
    const polled: string[] = [];
    (manager as any).knowledgeIngestPoller = { poll: async () => { polled.push('ingest'); } };
    (manager as any).scoutHostPoller = { poll: async () => { polled.push('scout'); } };
    (manager as any).modelProbePoller = { poll: async () => { polled.push('probe'); } };
    (manager as any).pollIdleJobs(0);
    expect(polled).toEqual([]);
    initRunnerHold(null);
    (manager as any).pollIdleJobs(0);
    expect(polled.sort()).toEqual(['ingest', 'probe', 'scout']);
  });
});
