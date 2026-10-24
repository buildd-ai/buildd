/**
 * Spec 0dc7c6de AC-9 and the runner half of AC-5: the provider's own limit warning stops new
 * work on that provider while the running session continues; the other provider keeps going;
 * the hold lifts at resetsAt; nothing but the reset time is kept.
 */

import { describe, test, expect, mock, afterEach, beforeEach, setDefaultTimeout, afterAll } from 'bun:test';
import { tmpdir } from 'os';
import { initTestWorkspace, getTestWorkspace, cleanupTestWorkspace } from '../test-workspace';
import type { LocalWorker, LocalUIConfig } from '../../src/types';

setDefaultTimeout(15_000);

// ─── Mocks ───────────────────────────────────────────────────────────────────

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (_opts: any) => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() {
      return { async next() { return { value: undefined, done: true }; } };
    },
  }),
}));

const claimTaskMock = mock(async (..._a: any[]) => ({ workers: [] as any[] }));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mock(async () => ({}));
    claimTask = claimTaskMock;
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

mock.module('pusher-js', () => ({
  default: class {
    connection = { bind: () => {} };
    subscribe() { return { bind: () => {}, unbind_all: () => {}, unbind: () => {} }; }
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
  scanEnvironment: () => ({
    platform: 'linux',
    arch: 'x64',
    tools: [],
    envKeys: [],
    mcp: [],
    mcpServers: [],
    labels: { type: 'local', os: 'linux', arch: 'x64', hostname: 'test' },
    scannedAt: new Date(0).toISOString(),
  }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  parseMcpJson: () => [],
  scanMcpServersRich: () => [],
  checkBwrapSupport: () => false,
  checkBwrapMountIsolationSupport: () => false,
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

function makeWorker(id = 'w-tr-1'): LocalWorker {
  return {
    id,
    taskId: 'task-tr',
    taskTitle: 'Test terminal_reason',
    taskDescription: 'Do something',
    workspaceId: 'ws-1',
    workspaceName: 'test-workspace',
    branch: 'buildd/test',
    status: 'working',
    hasNewActivity: false,
    lastActivity: Date.now(),
    milestones: [],
    currentAction: 'Running...',
    commits: [],
    output: [],
    toolCalls: [],
    messages: [],
    phaseText: null,
    phaseStart: null,
    phaseToolCount: 0,
    phaseTools: [],
  };
}

function injectWorker(manager: InstanceType<typeof WorkerManager>, worker: LocalWorker) {
  (manager as any).workers.set(worker.id, worker);
  (manager as any).sessions.set(worker.id, {
    abortController: new AbortController(),
    cwd: getTestWorkspace(),
    repoPath: getTestWorkspace(),
    generation: 1,
    inputStream: {
      enqueue: () => {},
      end: () => {},
      [Symbol.asyncIterator]() {
        return { next: async () => ({ value: undefined as any, done: true }) };
      },
    },
  });
}

function makeResultMessage(opts: {
  terminalReason?: string;
  permissionDenials?: Array<{ tool_name?: string; tool?: string }>;
  numTurns?: number;
} = {}) {
  return {
    type: 'result',
    subtype: 'success',
    stop_reason: 'end_turn',
    terminal_reason: opts.terminalReason,
    num_turns: opts.numTurns ?? 5,
    permission_denials: opts.permissionDenials ?? [],
    duration_ms: 1000,
    duration_api_ms: 500,
    usage: { byModel: {} },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('claims pause when every available provider is held (R-18)', () => {
  let manager: InstanceType<typeof WorkerManager>;
  afterAll(() => { cleanupTestWorkspace(); });
  beforeEach(() => { claimTaskMock.mockClear(); });
  afterEach(() => { manager?.destroy(); });

  function setup(auth: { claude: boolean; codex: boolean }) {
    initTestWorkspace();
    manager = new WorkerManager(makeConfig());
    const m = manager as any;
    m.modelAuth = { source: auth.claude ? 'api_key' : 'none' };
    m.codexAuth = auth.codex ? 'api_key' : 'none';
    m.hasCredentials = auth.claude;
    return m;
  }
  const hold = (m: any, provider: 'claude' | 'codex', untilMs: number) => {
    const worker = makeWorker(`w-${provider}`);
    worker.taskBackend = provider as any;
    injectWorker(manager, worker);
    m.holdProvider({ provider, status: 'rejected', kind: 'five_hour', untilMs }, worker);
  };

  test('a Claude-only runner with Claude held makes no claim, and resumes at reset', async () => {
    const m = setup({ claude: true, codex: false });
    hold(m, 'claude', Date.now() + 3_600_000);

    expect(m.claimsPaused).toBe(true);
    expect(await manager.claimPendingTasks()).toEqual([]);
    expect(claimTaskMock).not.toHaveBeenCalled();

    m.claimsPausedUntil = Date.now() - 1;
    await manager.claimPendingTasks();
    expect(m.claimsPaused).toBe(false);
    expect(claimTaskMock).toHaveBeenCalledTimes(1);
  });

  test('with Claude and Codex both available, holding only Claude still claims', async () => {
    const m = setup({ claude: true, codex: true });
    hold(m, 'claude', Date.now() + 3_600_000);

    expect(m.claimsPaused).toBe(false);
    await manager.claimPendingTasks();
    expect(claimTaskMock).toHaveBeenCalledTimes(1);
  });

  test('with both available and both held, claims pause', async () => {
    const m = setup({ claude: true, codex: true });
    hold(m, 'claude', Date.now() + 3_600_000);
    hold(m, 'codex', Date.now() + 3_600_000);

    expect(m.claimsPaused).toBe(true);
    expect(await manager.claimPendingTasks()).toEqual([]);
    expect(claimTaskMock).not.toHaveBeenCalled();
  });

  test('a runner with no detected provider does not pause', async () => {
    const m = setup({ claude: false, codex: false });
    hold(m, 'claude', Date.now() + 3_600_000);

    expect(m.claimsPaused).toBe(false);
  });
});
