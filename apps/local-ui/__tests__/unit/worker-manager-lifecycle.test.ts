/**
 * WorkerManager lifecycle tests — abort, retry, markDone, stale detection,
 * eviction, and task assignment.
 *
 * Run: bun test apps/local-ui/__tests__/unit/worker-manager-lifecycle.test.ts
 */

import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';
import type { LocalWorker, LocalUIConfig } from '../../src/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

let mockMessages: any[] = [];
let queryCallCount = 0;
let mockStreamInputFn = mock(() => {});

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (_opts: any) => {
    queryCallCount++;
    const msgs = [...mockMessages];
    let idx = 0;
    return {
      streamInput: mockStreamInputFn,
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (idx < msgs.length) {
              return { value: msgs[idx++], done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    };
  },
}));

const mockUpdateWorker = mock(async () => ({}));
const mockClaimTask = mock(async () => []);
const mockGetWorkspaceConfig = mock(async () => ({ configStatus: 'unconfigured' }));
const mockGetCompactObservations = mock(async () => ({ markdown: '', count: 0 }));
const mockSearchObservations = mock(async () => []);
const mockGetBatchObservations = mock(async () => []);
const mockCreateObservation = mock(async () => ({}));
const mockListWorkspaces = mock(async () => []);
const mockSendHeartbeat = mock(async () => ({}));
const mockRunCleanup = mock(async () => ({}));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mockUpdateWorker;
    claimTask = mockClaimTask;
    getWorkspaceConfig = mockGetWorkspaceConfig;
    getCompactObservations = mockGetCompactObservations;
    searchObservations = mockSearchObservations;
    getBatchObservations = mockGetBatchObservations;
    createObservation = mockCreateObservation;
    listWorkspaces = mockListWorkspaces;
    sendHeartbeat = mockSendHeartbeat;
    runCleanup = mockRunCleanup;
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
}));

mock.module('../../src/worker-store', () => ({
  saveWorker: () => {},
  loadAllWorkers: () => [],
  deleteWorker: () => {},
}));

mock.module('../../src/skills.js', () => ({
  syncSkillToLocal: async () => {},
}));

mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ platform: 'linux', arch: 'x64', tools: [], envKeys: [] }),
}));

const { WorkerManager } = await import('../../src/workers');

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function makeTask(overrides?: Record<string, any>) {
  return {
    id: 'task-1',
    title: 'Test task',
    description: 'Do something',
    workspaceId: 'ws-1',
    workspace: { name: 'test-workspace' },
    status: 'waiting',
    priority: 1,
    ...overrides,
  };
}

async function createWorkerSession(manager: InstanceType<typeof WorkerManager>, workerId = 'w-lc-1') {
  mockMessages = [
    { type: 'system', subtype: 'init', session_id: `sess-${workerId}` },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Working...' }] } },
    { type: 'result', subtype: 'success', session_id: `sess-${workerId}` },
  ];

  mockClaimTask.mockImplementation(async () => [{
    id: workerId,
    branch: `buildd/${workerId}`,
    task: makeTask(),
  }]);

  await manager.claimAndStart(makeTask());
  await new Promise(r => setTimeout(r, 150));
  return manager.getWorker(workerId);
}


// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WorkerManager — lifecycle', () => {
  let manager: InstanceType<typeof WorkerManager>;

  afterEach(() => {
    manager?.destroy();
  });

  beforeEach(() => {
    queryCallCount = 0;
    mockMessages = [];
    mockUpdateWorker.mockClear();
    mockClaimTask.mockClear();
    mockStreamInputFn.mockClear();
  });

  describe('abort()', () => {
    // Helper: register a worker directly (no session) to test abort() in isolation
    function addWorker(mgr: InstanceType<typeof WorkerManager>, id = 'w-lc-1', status = 'working') {
      const workers = (mgr as any).workers as Map<string, any>;
      const worker = {
        id,
        status,
        error: undefined as string | undefined,
        currentAction: 'Working...',
        task: makeTask(),
        branch: `buildd/${id}`,
        output: [],
        toolCalls: [],
        milestones: [],
        commits: [],
        hasNewActivity: false,
        startedAt: Date.now(),
      };
      workers.set(id, worker);
      return worker;
    }

    test('sets error status and emits update', async () => {
      manager = new WorkerManager(makeConfig());
      const events: any[] = [];
      manager.onEvent((e: any) => events.push(e));

      addWorker(manager);

      await manager.abort('w-lc-1');

      const worker = manager.getWorker('w-lc-1');
      expect(worker?.status).toBe('error');
      expect(worker?.error).toBeDefined();
      expect(worker?.currentAction).toBe('Aborted');

      // Should have emitted worker_update with error status
      const abortEvents = events.filter(
        (e: any) => e.type === 'worker_update' && e.worker?.currentAction === 'Aborted'
      );
      expect(abortEvents.length).toBeGreaterThanOrEqual(1);
    });

    test('uses provided reason for error message', async () => {
      manager = new WorkerManager(makeConfig());
      addWorker(manager);

      await manager.abort('w-lc-1', 'User requested cancellation');

      const worker = manager.getWorker('w-lc-1');
      expect(worker?.error).toBe('User requested cancellation');
    });

    test('preserves existing error message (e.g., from loop detection)', async () => {
      manager = new WorkerManager(makeConfig());
      const worker = addWorker(manager);
      worker.error = 'Agent stuck: made 5 identical Read calls';

      await manager.abort('w-lc-1');

      expect(worker?.error).toBe('Agent stuck: made 5 identical Read calls');
    });

    test('reports failed status to server', async () => {
      manager = new WorkerManager(makeConfig());
      mockUpdateWorker.mockClear();

      addWorker(manager);
      await manager.abort('w-lc-1');

      const failedCalls = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'failed'
      );
      expect(failedCalls.length).toBeGreaterThanOrEqual(1);
    });

    test('handles abort of non-existent worker gracefully', async () => {
      manager = new WorkerManager(makeConfig());
      // Should not throw
      await manager.abort('nonexistent');
    });
  });

  describe('retry()', () => {
    test('resets error state and starts new session', async () => {
      manager = new WorkerManager(makeConfig());
      await createWorkerSession(manager);

      // Set worker to error state
      const worker = manager.getWorker('w-lc-1');
      worker!.status = 'error';
      worker!.error = 'Previous failure';
      worker!.completedAt = Date.now();

      const queryCountBefore = queryCallCount;

      // Set up messages for retry session
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-retry' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Retrying.' }] } },
        { type: 'result', subtype: 'success', session_id: 'sess-retry' },
      ];

      await manager.retry('w-lc-1');
      await new Promise(r => setTimeout(r, 150));

      // Worker should be done (retry session completed)
      const updated = manager.getWorker('w-lc-1');
      expect(updated?.error).toBeUndefined();
      expect(updated?.completedAt).toBeDefined(); // Re-set by completion
      expect(queryCallCount).toBeGreaterThan(queryCountBefore);
    });

    test('emits worker_update with working status', async () => {
      manager = new WorkerManager(makeConfig());
      const events: any[] = [];
      manager.onEvent((e: any) => events.push(e));

      await createWorkerSession(manager);
      const worker = manager.getWorker('w-lc-1');
      worker!.status = 'error';

      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-retry2' },
        { type: 'result', subtype: 'success', session_id: 'sess-retry2' },
      ];

      await manager.retry('w-lc-1');

      // Should have emitted a 'Retrying...' update
      const retryEvents = events.filter(
        (e: any) => e.type === 'worker_update' && e.worker?.currentAction === 'Retrying...'
      );
      expect(retryEvents.length).toBeGreaterThanOrEqual(1);
    });

    test('adds retry milestone', async () => {
      manager = new WorkerManager(makeConfig());
      await createWorkerSession(manager);
      const worker = manager.getWorker('w-lc-1');
      worker!.status = 'error';

      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-retry3' },
        { type: 'result', subtype: 'success', session_id: 'sess-retry3' },
      ];

      await manager.retry('w-lc-1');
      await new Promise(r => setTimeout(r, 100));

      const retryMilestones = worker?.milestones.filter(m => m.label === 'Retry requested');
      expect(retryMilestones!.length).toBeGreaterThanOrEqual(1);
    });

    test('does nothing for non-existent worker', async () => {
      manager = new WorkerManager(makeConfig());
      // Should not throw
      await manager.retry('nonexistent');
    });
  });

  describe('markDone()', () => {
    test('sets done status and reports to server', async () => {
      manager = new WorkerManager(makeConfig());
      await createWorkerSession(manager);

      mockUpdateWorker.mockClear();
      await manager.markDone('w-lc-1');

      const worker = manager.getWorker('w-lc-1');
      expect(worker?.status).toBe('done');
      expect(worker?.currentAction).toBe('Marked done');

      // Should have reported completed to server
      const completedCalls = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'completed'
      );
      expect(completedCalls.length).toBeGreaterThanOrEqual(1);
    });

    test('emits worker_update event', async () => {
      manager = new WorkerManager(makeConfig());
      const events: any[] = [];
      manager.onEvent((e: any) => events.push(e));

      await createWorkerSession(manager);
      await manager.markDone('w-lc-1');

      const doneEvents = events.filter(
        (e: any) => e.type === 'worker_update' && e.worker?.currentAction === 'Marked done'
      );
      expect(doneEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Stale detection', () => {
    test('transitions worker to stale after 120s inactivity', () => {
      manager = new WorkerManager(makeConfig());

      // Manually create a worker to test stale detection
      const workers = (manager as any).workers as Map<string, LocalWorker>;
      const worker: LocalWorker = {
        id: 'w-stale-test',
        taskId: 'task-1',
        taskTitle: 'Test',
        workspaceId: 'ws-1',
        workspaceName: 'test',
        branch: 'buildd/test',
        status: 'working',
        hasNewActivity: false,
        lastActivity: Date.now() - 310_000, // 310s ago — beyond 300s threshold
        milestones: [],
        currentAction: 'Thinking...',
        commits: [],
        output: [],
        toolCalls: [],
        messages: [],
        phaseText: null,
        phaseStart: null,
        phaseToolCount: 0,
        phaseTools: [],
      };
      workers.set(worker.id, worker);

      // Trigger stale check manually
      (manager as any).checkStale();

      expect(worker.status).toBe('stale');
    });

    test('does not mark active workers as stale', () => {
      manager = new WorkerManager(makeConfig());

      const workers = (manager as any).workers as Map<string, LocalWorker>;
      const worker: LocalWorker = {
        id: 'w-active-test',
        taskId: 'task-1',
        taskTitle: 'Test',
        workspaceId: 'ws-1',
        workspaceName: 'test',
        branch: 'buildd/test',
        status: 'working',
        hasNewActivity: false,
        lastActivity: Date.now() - 10_000, // 10s ago — within threshold
        milestones: [],
        currentAction: 'Editing file',
        commits: [],
        output: [],
        toolCalls: [],
        messages: [],
        phaseText: null,
        phaseStart: null,
        phaseToolCount: 0,
        phaseTools: [],
      };
      workers.set(worker.id, worker);

      (manager as any).checkStale();

      expect(worker.status).toBe('working');
    });

    test('only affects working status workers', () => {
      manager = new WorkerManager(makeConfig());

      const workers = (manager as any).workers as Map<string, LocalWorker>;
      const worker: LocalWorker = {
        id: 'w-done-stale',
        taskId: 'task-1',
        taskTitle: 'Test',
        workspaceId: 'ws-1',
        workspaceName: 'test',
        branch: 'buildd/test',
        status: 'done', // Not 'working'
        hasNewActivity: false,
        lastActivity: Date.now() - 200_000,
        milestones: [],
        currentAction: 'Completed',
        commits: [],
        output: [],
        toolCalls: [],
        messages: [],
        phaseText: null,
        phaseStart: null,
        phaseToolCount: 0,
        phaseTools: [],
      };
      workers.set(worker.id, worker);

      (manager as any).checkStale();

      expect(worker.status).toBe('done'); // Unchanged
    });
  });

  describe('Eviction', () => {
    test('removes completed workers older than 10 minutes', () => {
      manager = new WorkerManager(makeConfig());

      const workers = (manager as any).workers as Map<string, LocalWorker>;
      const worker: LocalWorker = {
        id: 'w-evict-1',
        taskId: 'task-1',
        taskTitle: 'Test',
        workspaceId: 'ws-1',
        workspaceName: 'test',
        branch: 'buildd/test',
        status: 'done',
        hasNewActivity: false,
        lastActivity: Date.now() - (11 * 60 * 1000), // 11 minutes ago
        milestones: [],
        currentAction: 'Completed',
        commits: [],
        output: [],
        toolCalls: [],
        messages: [],
        phaseText: null,
        phaseStart: null,
        phaseToolCount: 0,
        phaseTools: [],
      };
      workers.set(worker.id, worker);

      (manager as any).evictCompletedWorkers();

      expect(workers.has('w-evict-1')).toBe(false);
    });

    test('keeps recently completed workers', () => {
      manager = new WorkerManager(makeConfig());

      const workers = (manager as any).workers as Map<string, LocalWorker>;
      const worker: LocalWorker = {
        id: 'w-keep-1',
        taskId: 'task-1',
        taskTitle: 'Test',
        workspaceId: 'ws-1',
        workspaceName: 'test',
        branch: 'buildd/test',
        status: 'done',
        hasNewActivity: false,
        lastActivity: Date.now() - (5 * 60 * 1000), // 5 minutes ago
        milestones: [],
        currentAction: 'Completed',
        commits: [],
        output: [],
        toolCalls: [],
        messages: [],
        phaseText: null,
        phaseStart: null,
        phaseToolCount: 0,
        phaseTools: [],
      };
      workers.set(worker.id, worker);

      (manager as any).evictCompletedWorkers();

      expect(workers.has('w-keep-1')).toBe(true);
    });

    test('does not evict working workers regardless of age', () => {
      manager = new WorkerManager(makeConfig());

      const workers = (manager as any).workers as Map<string, LocalWorker>;
      const worker: LocalWorker = {
        id: 'w-working-old',
        taskId: 'task-1',
        taskTitle: 'Test',
        workspaceId: 'ws-1',
        workspaceName: 'test',
        branch: 'buildd/test',
        status: 'working',
        hasNewActivity: false,
        lastActivity: Date.now() - (60 * 60 * 1000), // 1 hour ago
        milestones: [],
        currentAction: 'Still going',
        commits: [],
        output: [],
        toolCalls: [],
        messages: [],
        phaseText: null,
        phaseStart: null,
        phaseToolCount: 0,
        phaseTools: [],
      };
      workers.set(worker.id, worker);

      (manager as any).evictCompletedWorkers();

      expect(workers.has('w-working-old')).toBe(true);
    });

    test('evicts error workers older than 10 minutes', () => {
      manager = new WorkerManager(makeConfig());

      const workers = (manager as any).workers as Map<string, LocalWorker>;
      const worker: LocalWorker = {
        id: 'w-err-old',
        taskId: 'task-1',
        taskTitle: 'Test',
        workspaceId: 'ws-1',
        workspaceName: 'test',
        branch: 'buildd/test',
        status: 'error',
        hasNewActivity: false,
        lastActivity: Date.now() - (15 * 60 * 1000), // 15 minutes ago
        error: 'Something failed',
        milestones: [],
        currentAction: 'Failed',
        commits: [],
        output: [],
        toolCalls: [],
        messages: [],
        phaseText: null,
        phaseStart: null,
        phaseToolCount: 0,
        phaseTools: [],
      };
      workers.set(worker.id, worker);

      (manager as any).evictCompletedWorkers();

      expect(workers.has('w-err-old')).toBe(false);
    });
  });

  describe('Task assignment capacity', () => {
    test('checks capacity before accepting assignment', async () => {
      manager = new WorkerManager(makeConfig({ maxConcurrent: 1 }));

      // Fill capacity with one worker
      const workers = (manager as any).workers as Map<string, LocalWorker>;
      workers.set('w-busy', {
        id: 'w-busy',
        taskId: 'task-1',
        taskTitle: 'Busy task',
        workspaceId: 'ws-1',
        workspaceName: 'test',
        branch: 'buildd/test',
        status: 'working',
        hasNewActivity: false,
        lastActivity: Date.now(),
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
      } as LocalWorker);

      // Try to handle assignment — should be rejected due to capacity
      const claimCountBefore = mockClaimTask.mock.calls.length;
      await (manager as any).handleTaskAssignment({
        task: makeTask({ id: 'task-overflow' }),
        targetLocalUiUrl: null,
      });

      // claimTask should not have been called (at capacity)
      expect(mockClaimTask.mock.calls.length).toBe(claimCountBefore);
    });
  });

  describe('getWorkers / getWorker', () => {
    test('getWorkers returns all workers', async () => {
      manager = new WorkerManager(makeConfig());
      await createWorkerSession(manager);

      const workers = manager.getWorkers();
      expect(workers.length).toBe(1);
      expect(workers[0].id).toBe('w-lc-1');
    });

    test('getWorker returns undefined for missing worker', () => {
      manager = new WorkerManager(makeConfig());
      expect(manager.getWorker('nope')).toBeUndefined();
    });
  });

  describe('markRead', () => {
    test('clears hasNewActivity flag', async () => {
      manager = new WorkerManager(makeConfig());
      await createWorkerSession(manager);

      const worker = manager.getWorker('w-lc-1');
      worker!.hasNewActivity = true;

      manager.markRead('w-lc-1');

      expect(worker?.hasNewActivity).toBe(false);
    });
  });

  describe('destroy()', () => {
    test('clears all intervals and sessions', async () => {
      manager = new WorkerManager(makeConfig());
      await createWorkerSession(manager);

      // destroy should not throw
      manager.destroy();

      // Sessions should be cleared
      const sessions = (manager as any).sessions as Map<string, any>;
      expect(sessions.size).toBe(0);
    });
  });
});
