/**
 * Tests for the terminal_reason SDK 0.3.216 surface in WorkerManager.handleMessage().
 *
 * When a session ends with a distinguishable reason the runner emits an
 * informative milestone so the dashboard shows actionable context:
 *   'max_turns'     → milestone suggesting raising maxTurns
 *   'aborted_tools' → milestone naming the blocked tool
 *   other values    → no extra milestone (already surfaced by subtype handling)
 *
 * Run: bun test apps/runner/__tests__/unit/terminal-reason.test.ts
 */

import { describe, test, expect, mock, afterEach, setDefaultTimeout } from 'bun:test';
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
    cwd: '/tmp/test-workspace',
    repoPath: '/tmp/test-workspace',
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

describe('terminal_reason milestone', () => {
  let manager: InstanceType<typeof WorkerManager>;

  afterEach(() => {
    manager?.destroy();
  });

  test('max_turns: adds milestone suggesting raising the turn limit', async () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker();
    injectWorker(manager, worker);

    await (manager as any).handleMessage(
      worker,
      makeResultMessage({ terminalReason: 'max_turns', numTurns: 50 }),
    );

    const labels = worker.milestones.map((m: any) => m.label as string);
    expect(labels.some(l => l.includes('Max turns') && l.includes('maxTurns'))).toBe(true);
  });

  test('aborted_tools: adds milestone with the blocking tool name', async () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker('w-tr-2');
    injectWorker(manager, worker);

    await (manager as any).handleMessage(
      worker,
      makeResultMessage({
        terminalReason: 'aborted_tools',
        permissionDenials: [{ tool_name: 'Bash', tool: 'Bash' }],
      }),
    );

    const labels = worker.milestones.map((m: any) => m.label as string);
    expect(labels.some(l => l.includes('Bash') && l.includes('denied'))).toBe(true);
  });

  test('aborted_tools: falls back to "a tool" when permission_denials is empty', async () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker('w-tr-3');
    injectWorker(manager, worker);

    await (manager as any).handleMessage(
      worker,
      makeResultMessage({ terminalReason: 'aborted_tools', permissionDenials: [] }),
    );

    const labels = worker.milestones.map((m: any) => m.label as string);
    expect(labels.some(l => l.includes('a tool') && l.includes('denied'))).toBe(true);
  });

  test('other terminal_reason values do not add an extra milestone', async () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker('w-tr-4');
    injectWorker(manager, worker);

    await (manager as any).handleMessage(
      worker,
      makeResultMessage({ terminalReason: 'completed' }),
    );

    const labels = worker.milestones.map((m: any) => m.label as string);
    expect(labels.some(l => l.includes('Max turns') || l.includes('blocked'))).toBe(false);
  });

  test('no terminal_reason does not add an extra milestone', async () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker('w-tr-5');
    injectWorker(manager, worker);

    await (manager as any).handleMessage(worker, makeResultMessage({}));

    const labels = worker.milestones.map((m: any) => m.label as string);
    expect(labels.some(l => l.includes('Max turns') || l.includes('blocked'))).toBe(false);
  });

  test('stores terminal_reason in resultMeta regardless of value', async () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker('w-tr-6');
    injectWorker(manager, worker);

    await (manager as any).handleMessage(
      worker,
      makeResultMessage({ terminalReason: 'max_turns', numTurns: 10 }),
    );

    expect((worker as any).resultMeta?.terminalReason).toBe('max_turns');
    expect((worker as any).resultMeta?.numTurns).toBe(10);
  });
});
