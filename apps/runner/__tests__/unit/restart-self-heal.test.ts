/**
 * Tests for restart self-heal: when the runner restarts, interrupted workers
 * should check the server before being marked as failed.
 *
 * Run: bun test apps/runner/__tests__/unit/restart-self-heal.test.ts
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

// Disk workers that simulate a restart: these were "working" when the process died
const diskWorkers: LocalWorker[] = [];

mock.module('../../src/worker-store', () => ({
  saveWorker: () => {},
  loadAllWorkers: () => diskWorkers.map(w => ({ ...w, checkpointEvents: new Set(w.checkpointEvents || []) })),
  loadWorker: (id: string) => diskWorkers.find(w => w.id === id) || null,
  deleteWorker: () => {},
}));

mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ tools: [], envKeys: [], mcp: [] }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  extractVarReferences: () => [],
  parseMcpJsonContent: () => [],
  parseMcpJson: () => [],
  scanMcpServersRich: () => [],
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
    startedAt: Date.now() - 60_000,
    lastActivity: Date.now() - 10_000,
    messages: [],
    milestones: [],
    toolCalls: [],
    commits: [],
    output: [],
    hasNewActivity: false,
    currentAction: 'Working on something',
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

// Use serverless:true so the constructor doesn't trigger heartbeat/pusher/reconcile,
// then manually call restoreWorkersFromDisk to test the self-heal path.
const testConfig: LocalUIConfig = {
  projectRoots: ['/tmp'],
  builddServer: 'http://localhost:3000',
  apiKey: 'test-key',
  maxConcurrent: 3,
  model: 'claude-sonnet-4-20250514',
  serverless: true,
};

const { WorkerManager } = await import('../../src/workers');

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('restart self-heal', () => {
  beforeEach(() => {
    mockUpdateWorker.mockClear();
    mockGetWorkerRemote.mockClear();
    diskWorkers.length = 0;
  });

  test('self-heals to done when server says completed', async () => {
    const worker = makeWorker({ id: 'w-heal-done', status: 'working' });
    diskWorkers.push(worker);

    mockGetWorkerRemote.mockResolvedValue({
      status: 'completed',
      task: { status: 'completed' },
    });

    const manager = new WorkerManager(testConfig);
    // restoreWorkersFromDisk runs in constructor (serverless mode still calls it)
    // but reconcileInterruptedWorkers is async — give it time to resolve
    await new Promise(resolve => setTimeout(resolve, 100));

    const restored = manager.getWorker('w-heal-done');
    expect(restored?.status).toBe('done');
    expect(restored?.currentAction).toContain('Completed');
    // Should NOT have called updateWorker with failed status
    const failCalls = mockUpdateWorker.mock.calls.filter(
      (c: any) => c[1]?.status === 'failed'
    );
    expect(failCalls.length).toBe(0);
  });

  test('marks as error when server says still running', async () => {
    const worker = makeWorker({ id: 'w-heal-running', status: 'working' });
    diskWorkers.push(worker);

    mockGetWorkerRemote.mockResolvedValue({
      status: 'running',
      task: { status: 'assigned' },
    });

    const manager = new WorkerManager(testConfig);
    await new Promise(resolve => setTimeout(resolve, 100));

    const restored = manager.getWorker('w-heal-running');
    expect(restored?.status).toBe('error');
    expect(restored?.error).toBe('Process restarted');
    // Should have notified server
    const failCalls = mockUpdateWorker.mock.calls.filter(
      (c: any) => c[1]?.status === 'failed'
    );
    expect(failCalls.length).toBe(1);
  });

  test('marks as error when server is unreachable', async () => {
    const worker = makeWorker({ id: 'w-heal-unreachable', status: 'working' });
    diskWorkers.push(worker);

    mockGetWorkerRemote.mockRejectedValue(new Error('Network error'));

    const manager = new WorkerManager(testConfig);
    await new Promise(resolve => setTimeout(resolve, 100));

    const restored = manager.getWorker('w-heal-unreachable');
    expect(restored?.status).toBe('error');
    expect(restored?.error).toContain('Process restarted');
  });

  test('marks as error when worker not found on server (404)', async () => {
    const worker = makeWorker({ id: 'w-heal-404', status: 'working' });
    diskWorkers.push(worker);

    mockGetWorkerRemote.mockResolvedValue(null);

    const manager = new WorkerManager(testConfig);
    await new Promise(resolve => setTimeout(resolve, 100));

    const restored = manager.getWorker('w-heal-404');
    expect(restored?.status).toBe('error');
    expect(restored?.error).toBe('Process restarted');
  });

  test('self-heals when task completed even if worker status is still running', async () => {
    const worker = makeWorker({ id: 'w-heal-task-done', status: 'working' });
    diskWorkers.push(worker);

    // Worker still shows "running" but the task itself is completed
    // (agent called complete_task which updated the task, but worker status wasn't synced)
    mockGetWorkerRemote.mockResolvedValue({
      status: 'running',
      task: { status: 'completed' },
    });

    const manager = new WorkerManager(testConfig);
    await new Promise(resolve => setTimeout(resolve, 100));

    const restored = manager.getWorker('w-heal-task-done');
    expect(restored?.status).toBe('done');
  });

  test('handles mix of completed and interrupted workers', async () => {
    diskWorkers.push(makeWorker({ id: 'w-mix-1', status: 'working', taskTitle: 'Completed task' }));
    diskWorkers.push(makeWorker({ id: 'w-mix-2', status: 'stale', taskTitle: 'Interrupted task' }));
    diskWorkers.push(makeWorker({ id: 'w-mix-3', status: 'done', taskTitle: 'Already done' }));

    mockGetWorkerRemote
      .mockResolvedValueOnce({ status: 'completed', task: { status: 'completed' } })
      .mockResolvedValueOnce({ status: 'running', task: { status: 'assigned' } });

    const manager = new WorkerManager(testConfig);
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(manager.getWorker('w-mix-1')?.status).toBe('done');      // self-healed
    expect(manager.getWorker('w-mix-2')?.status).toBe('error');     // truly interrupted
    expect(manager.getWorker('w-mix-3')?.status).toBe('done');      // unchanged
  });

  test('workers start in stale status during reconciliation check', () => {
    const worker = makeWorker({ id: 'w-transient', status: 'working' });
    diskWorkers.push(worker);

    // Don't resolve the mock — simulates slow server
    mockGetWorkerRemote.mockImplementation(() => new Promise(() => {}));

    const manager = new WorkerManager(testConfig);
    // Immediately after construction, worker should be stale (not error yet)
    const restored = manager.getWorker('w-transient');
    expect(restored?.status).toBe('stale');
    expect(restored?.currentAction).toContain('Checking server');
  });
});
