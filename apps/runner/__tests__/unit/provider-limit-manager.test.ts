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

const rateLimit = (info: Record<string, unknown>) => ({ type: 'system', subtype: 'rate_limit', rate_limit_info: info });

describe('provider limit warning', () => {
  let manager: InstanceType<typeof WorkerManager>;
  afterAll(() => { cleanupTestWorkspace(); });
  beforeEach(() => { claimTaskMock.mockClear(); });
  afterEach(() => { manager?.destroy(); });

  function setup(backend: 'claude' | 'codex' = 'claude') {
    initTestWorkspace();
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker();
    worker.taskBackend = backend as any;
    injectWorker(manager, worker);
    return worker;
  }
  const send = (w: LocalWorker, info: Record<string, unknown>) => (manager as any).handleMessage(w, rateLimit(info));

  test('a Claude warning stops new Claude claims while the running session continues (AC-9)', async () => {
    const worker = setup();
    const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
    await send(worker, { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt });

    expect(worker.status).toBe('working');
    expect((manager as any).sessions.get(worker.id).abortController.signal.aborted).toBe(false);

    const started = await manager.claimAndStart({ id: 't-claude', workspaceId: 'ws-1', backend: 'claude' } as any);
    expect(started).toBeNull();
    expect(claimTaskMock).not.toHaveBeenCalled();
  });

  test('a Claude warning leaves Codex claims running, and the poll reports the held provider', async () => {
    const worker = setup();
    const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
    await send(worker, { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt });

    await manager.claimPendingTasks();
    expect(claimTaskMock).toHaveBeenCalledTimes(1);
    const opts = claimTaskMock.mock.calls[0][7] as any;
    expect(opts.limitWalls).toEqual([{ provider: 'claude', status: 'warning', kind: 'five_hour', resetsAt: new Date(resetsAt * 1000).toISOString() }]);

    claimTaskMock.mockClear();
    await manager.claimAndStart({ id: 't-codex', workspaceId: 'ws-1', backend: 'codex' } as any).catch(() => {});
    expect(claimTaskMock).toHaveBeenCalledTimes(1);
  });

  test('a poll that returns a Claude and a Codex worker starts only the Codex one and releases the Claude one', async () => {
    const worker = setup();
    await send(worker, { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: Math.floor((Date.now() + 3_600_000) / 1000) });
    claimTaskMock.mockResolvedValueOnce({ workers: [
      { id: 'cw-claude', taskId: 't1', task: { id: 't1', backend: 'claude' } },
      { id: 'cw-codex', taskId: 't2', task: { id: 't2', backend: 'codex' } },
    ] } as any);
    const startMock = mock(async (cw: any) => ({ id: cw.id }) as any);
    (manager as any).startClaimedWorker = startMock;
    const updateMock = mock(async () => ({}));
    (manager as any).buildd.updateWorker = updateMock;

    const started = await manager.claimPendingTasks();
    expect(startMock).toHaveBeenCalledTimes(1);
    expect((startMock.mock.calls[0] as any[])[0].id).toBe('cw-codex');
    expect(started.map((w: any) => w.id)).toEqual(['cw-codex']);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect((updateMock.mock.calls[0] as any[])[0]).toBe('cw-claude');
    expect((updateMock.mock.calls[0] as any[])[1].status).toBe('failed');
  });

  test('a single-provider hold does not emit circuit_breaker paused', async () => {
    const worker = setup();
    const events: any[] = [];
    (manager as any).emit = (e: any) => events.push(e);
    await send(worker, { status: 'allowed_warning', resetsAt: Math.floor((Date.now() + 3_600_000) / 1000) });
    expect(events.some(e => e.type === 'circuit_breaker' && e.paused)).toBe(false);
    expect(events.some(e => e.type === 'provider_limit' && e.provider === 'claude')).toBe(true);
  });

  test('a Codex warning does not stop Claude work', async () => {
    const worker = setup('codex');
    await send(worker, { status: 'allowed_warning', resetsAt: Math.floor((Date.now() + 3_600_000) / 1000) });
    claimTaskMock.mockClear();
    await manager.claimAndStart({ id: 't-claude', workspaceId: 'ws-1', backend: 'claude' } as any).catch(() => {});
    expect(claimTaskMock).toHaveBeenCalledTimes(1);
    expect(await manager.claimAndStart({ id: 't-codex', workspaceId: 'ws-1', backend: 'codex' } as any)).toBeNull();
  });

  test('the hold is lifted at resetsAt', async () => {
    const worker = setup();
    await send(worker, { status: 'allowed_warning', resetsAt: Math.floor((Date.now() + 3_600_000) / 1000) });
    const holds = (manager as any).providerLimits;
    expect(holds.isHeld('claude')).toBe(true);
    expect(holds.isHeld('claude', Date.now() + 3_600_001)).toBe(false);
  });

  test('a warning does not pause the whole runner', async () => {
    const worker = setup();
    await send(worker, { status: 'allowed_warning', resetsAt: Math.floor((Date.now() + 3_600_000) / 1000) });
    expect(manager.getInternalState().circuitBreaker.paused).toBe(false);
    expect((manager as any).claimsPaused).toBe(false);
  });

  test('a rejection holds only its provider too, and is reported as a rejection', async () => {
    const worker = setup();
    const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
    await send(worker, { status: 'rejected', rateLimitType: 'seven_day', resetsAt });
    expect((manager as any).claimsPaused).toBe(false);
    expect((manager as any).providerLimits.report()[0]).toMatchObject({ provider: 'claude', status: 'rejected', kind: 'seven_day' });
  });

  test('nothing is stored beyond the reset time (R-19)', async () => {
    const worker = setup();
    const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
    await send(worker, { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt, utilization: 0.93 });
    await send(worker, { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt, utilization: 0.97 });
    const holds = (manager as any).providerLimits;
    expect(holds.list()).toHaveLength(1);
    expect(Object.keys(holds.list()[0]).sort()).toEqual(['kind', 'provider', 'status', 'untilMs']);
    expect(JSON.stringify(manager.getInternalState())).not.toContain('0.97');
  });
});
