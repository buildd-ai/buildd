/**
 * Tests for local worker reconciliation against remote state.
 *
 * Verifies that stale local worker files (whose remote tasks are
 * 404/completed/failed) get cleaned up periodically.
 *
 * Run: bun test apps/runner/__tests__/unit/reconcile.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { LocalWorker, LocalUIConfig } from '../../src/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() {
      return { async next() { return { value: undefined, done: true }; } };
    },
  }),
}));

const mockUpdateWorker = mock(async () => ({}));
const mockGetWorkerRemote = mock(async (_id: string) => null as any);
const mockListWorkspaces = mock(async () => []);
const mockSendHeartbeat = mock(async () => ({}));
const mockRunCleanup = mock(async () => ({}));
const mockClaimTask = mock(async () => ({ workers: [] }));
const mockGetWorkspaceConfig = mock(async () => ({ configStatus: 'unconfigured' }));
const mockGetCompactObservations = mock(async () => ({ markdown: '', count: 0 }));
const mockSearchObservations = mock(async () => []);
const mockGetBatchObservations = mock(async () => []);
const mockCreateObservation = mock(async () => ({}));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mockUpdateWorker;
    getWorkerRemote = mockGetWorkerRemote;
    claimTask = mockClaimTask;
    getWorkspaceConfig = mockGetWorkspaceConfig;
    getCompactObservations = mockGetCompactObservations;
    searchObservations = mockSearchObservations;
    getBatchObservations = mockGetBatchObservations;
    createObservation = mockCreateObservation;
    listWorkspaces = mockListWorkspaces;
    sendHeartbeat = mockSendHeartbeat;
    runCleanup = mockRunCleanup;
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

// Mock worker-store — no disk workers for these tests (we inject directly via addWorkerForTest)
mock.module('../../src/worker-store', () => ({
  saveWorker: () => {},
  loadAllWorkers: () => [],
  loadWorker: () => null,
  deleteWorker: () => {},
}));

mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ tools: [], envKeys: [], mcp: [] }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
}));

mock.module('../../src/session-logger', () => ({
  sessionLog: () => {},
  cleanupOldLogs: () => {},
  readSessionLogs: () => [],
  claimLog: () => {},
}));

mock.module('../../src/history-store', () => ({
  archiveSession: () => {},
  initHistoryStore: () => {},
}));

mock.module('../../src/skills.js', () => ({
  syncSkillToLocal: () => {},
}));

mock.module('pusher-js', () => ({
  default: class { subscribe() { return { bind() {} }; } connection = { bind() {} }; },
}));

// Mock fs to prevent real filesystem operations
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
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeWorker(overrides: Partial<LocalWorker> = {}): LocalWorker {
  return {
    id: overrides.id || `w-${Math.random().toString(36).slice(2, 8)}`,
    taskId: overrides.taskId || 'task-1',
    taskTitle: 'Test task',
    workspaceId: 'ws-1',
    workspaceName: 'Test',
    branch: 'buildd/test',
    status: 'working',
    lastActivity: Date.now(),
    messages: [],
    milestones: [],
    toolCalls: [],
    commits: [],
    output: [],
    hasNewActivity: false,
    currentAction: '',
    subagentTasks: [],
    checkpoints: [],
    checkpointEvents: new Set(),
    phaseText: null,
    phaseStart: null,
    phaseToolCount: 0,
    phaseTools: [],
    ...overrides,
  };
}

const testConfig: LocalUIConfig = {
  projectRoots: ['/tmp'],
  builddServer: 'http://localhost:3000',
  apiKey: 'test-key',
  maxConcurrent: 3,
  model: 'claude-sonnet-4-20250514',
  serverless: true, // Avoid heartbeat/pusher/reconcile in constructor
};

// Import WorkerManager after all mocks
const { WorkerManager } = await import('../../src/workers');

// Helper to inject workers directly into the manager's internal map
function injectWorker(manager: any, worker: LocalWorker) {
  manager.workers.set(worker.id, worker);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('reconcileLocalWorkers', () => {
  beforeEach(() => {
    mockUpdateWorker.mockClear();
    mockGetWorkerRemote.mockClear();
  });

  test('cleans up local worker when remote worker is 404 (not found)', async () => {
    const manager = new WorkerManager(testConfig);
    const worker = makeWorker({ id: 'w-stale-404', status: 'waiting', taskId: 'task-gone' });
    injectWorker(manager, worker);

    mockGetWorkerRemote.mockResolvedValue(null);

    const result = await manager.reconcileLocalWorkers();

    expect(result.cleaned).toBe(1);
    expect(result.checked).toBe(1);
    const updated = manager.getWorker('w-stale-404');
    expect(updated?.status).toBe('error');
    expect(updated?.error).toContain('remote');
  });

  test('cleans up local worker when remote task is completed', async () => {
    const manager = new WorkerManager(testConfig);
    const worker = makeWorker({ id: 'w-stale-completed', status: 'waiting', taskId: 'task-done' });
    injectWorker(manager, worker);

    mockGetWorkerRemote.mockResolvedValue({ status: 'completed', task: { status: 'completed' } });

    const result = await manager.reconcileLocalWorkers();

    expect(result.cleaned).toBe(1);
    const updated = manager.getWorker('w-stale-completed');
    expect(updated?.status).toBe('done');
  });

  test('cleans up local worker when remote task is failed', async () => {
    const manager = new WorkerManager(testConfig);
    const worker = makeWorker({ id: 'w-stale-failed', status: 'waiting', taskId: 'task-failed' });
    injectWorker(manager, worker);

    mockGetWorkerRemote.mockResolvedValue({ status: 'failed', task: { status: 'failed' } });

    const result = await manager.reconcileLocalWorkers();

    expect(result.cleaned).toBe(1);
    const updated = manager.getWorker('w-stale-failed');
    expect(updated?.status).toBe('error');
    expect(updated?.error).toContain('remote');
  });

  test('cleans up local worker when remote worker status is completed', async () => {
    const manager = new WorkerManager(testConfig);
    const worker = makeWorker({ id: 'w-remote-done', status: 'working' });
    injectWorker(manager, worker);

    mockGetWorkerRemote.mockResolvedValue({ status: 'completed', task: { status: 'completed' } });

    const result = await manager.reconcileLocalWorkers();

    expect(result.cleaned).toBe(1);
    expect(manager.getWorker('w-remote-done')?.status).toBe('done');
  });

  test('skips local workers already in terminal state (done/error)', async () => {
    const manager = new WorkerManager(testConfig);
    injectWorker(manager, makeWorker({ id: 'w-done', status: 'done' }));
    injectWorker(manager, makeWorker({ id: 'w-error', status: 'error' }));

    const result = await manager.reconcileLocalWorkers();

    expect(result.checked).toBe(0);
    expect(result.cleaned).toBe(0);
    expect(mockGetWorkerRemote).not.toHaveBeenCalled();
  });

  test('leaves worker alone when remote status is still running', async () => {
    const manager = new WorkerManager(testConfig);
    const worker = makeWorker({ id: 'w-active', status: 'working' });
    injectWorker(manager, worker);

    mockGetWorkerRemote.mockResolvedValue({ status: 'running', task: { status: 'assigned' } });

    const result = await manager.reconcileLocalWorkers();

    expect(result.cleaned).toBe(0);
    expect(result.checked).toBe(1);
    expect(manager.getWorker('w-active')?.status).toBe('working');
  });

  test('handles multiple stale workers in one reconciliation pass', async () => {
    const manager = new WorkerManager(testConfig);
    injectWorker(manager, makeWorker({ id: 'w-multi-1', status: 'working', taskId: 't1' }));
    injectWorker(manager, makeWorker({ id: 'w-multi-2', status: 'waiting', taskId: 't2' }));
    injectWorker(manager, makeWorker({ id: 'w-multi-3', status: 'stale', taskId: 't3' }));
    injectWorker(manager, makeWorker({ id: 'w-multi-4', status: 'done', taskId: 't4' })); // skip

    // w1: 404, w2: completed, w3: failed
    mockGetWorkerRemote
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 'completed', task: { status: 'completed' } })
      .mockResolvedValueOnce({ status: 'failed', task: { status: 'failed' } });

    const result = await manager.reconcileLocalWorkers();

    expect(result.checked).toBe(3); // skipped w4 (done)
    expect(result.cleaned).toBe(3);
  });

  test('handles API errors gracefully without crashing', async () => {
    const manager = new WorkerManager(testConfig);
    const worker = makeWorker({ id: 'w-api-error', status: 'working' });
    injectWorker(manager, worker);

    mockGetWorkerRemote.mockRejectedValue(new Error('Network error'));

    const result = await manager.reconcileLocalWorkers();

    expect(result.checked).toBe(1);
    expect(result.cleaned).toBe(0);
    expect(manager.getWorker('w-api-error')?.status).toBe('working');
  });

  test('leaves worker alone when remote status is starting', async () => {
    const manager = new WorkerManager(testConfig);
    const worker = makeWorker({ id: 'w-starting', status: 'working' });
    injectWorker(manager, worker);

    mockGetWorkerRemote.mockResolvedValue({ status: 'starting', task: { status: 'assigned' } });

    const result = await manager.reconcileLocalWorkers();

    expect(result.cleaned).toBe(0);
    expect(manager.getWorker('w-starting')?.status).toBe('working');
  });

  test('returns zero counts when no workers exist', async () => {
    const manager = new WorkerManager(testConfig);

    const result = await manager.reconcileLocalWorkers();

    expect(result.checked).toBe(0);
    expect(result.cleaned).toBe(0);
  });
});
