/**
 * Resume layer logging tests — verifies sessionLog is called with correct
 * events during the resumeSession() 2-layer cascade and eviction.
 *
 * Resume layers:
 *   Layer 1: SDK resume via sessionId (full context from disk)
 *   Layer 2: Reconstructed context (text summary fallback)
 *
 * Run: bun test apps/local-ui/__tests__/unit/resume-logging.test.ts
 */

import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';
import type { LocalWorker, LocalUIConfig } from '../../src/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

let queryCallCount = 0;
let mockMessages: any[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: any) => {
    queryCallCount++;
    const msgs = [...mockMessages];
    let idx = 0;
    return {
      streamInput: mock(() => {}),
      supportedModels: async () => [],
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
const mockClaimTask = mock(async () => ({ workers: [] }));
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
  unlinkSync: () => {},
  renameSync: () => {},
  readdirSync: () => [],
  appendFileSync: () => {},
  statSync: () => ({ size: 0, mtimeMs: 0 }),
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

const mockSessionLog = mock(() => {});
mock.module('../../src/session-logger', () => ({
  sessionLog: mockSessionLog,
  readSessionLogs: () => [],
  cleanupOldLogs: () => {},
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

function makeWorker(overrides?: Partial<LocalWorker>): LocalWorker {
  return {
    id: 'w-log-1',
    taskId: 'task-1',
    taskTitle: 'Test task',
    taskDescription: 'Do something',
    workspaceId: 'ws-1',
    workspaceName: 'test-workspace',
    branch: 'buildd/test',
    status: 'working',
    hasNewActivity: false,
    lastActivity: Date.now(),
    milestones: [],
    currentAction: 'Working...',
    commits: [],
    output: [],
    toolCalls: [],
    messages: [],
    phaseText: null,
    phaseStart: null,
    phaseToolCount: 0,
    phaseTools: [],
    ...overrides,
  };
}

function injectWorker(
  manager: InstanceType<typeof WorkerManager>,
  worker: LocalWorker,
) {
  const workers = (manager as any).workers as Map<string, LocalWorker>;
  workers.set(worker.id, worker);
}

function getSessionLogCalls(): Array<{ workerId: string; level: string; event: string; detail?: string; taskId?: string }> {
  return mockSessionLog.mock.calls.map((call: any[]) => ({
    workerId: call[0],
    level: call[1],
    event: call[2],
    detail: call[3],
    taskId: call[4],
  }));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Resume layer logging', () => {
  let manager: InstanceType<typeof WorkerManager>;

  afterEach(() => {
    manager?.destroy();
  });

  beforeEach(() => {
    queryCallCount = 0;
    mockMessages = [];
    mockUpdateWorker.mockClear();
    mockSessionLog.mockClear();
  });

  describe('Layer 1 path (with sessionId)', () => {
    test('logs resume_requested and resume_layer1_attempt', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        sessionId: 'sess-resume-1',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-resume-1' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
        { type: 'result', subtype: 'success', session_id: 'sess-resume-1' },
      ];

      await manager.sendMessage('w-log-1', 'Follow up please');
      await new Promise(r => setTimeout(r, 200));

      const logs = getSessionLogCalls();
      const events = logs.map(l => l.event);

      expect(events).toContain('resume_requested');
      expect(events).toContain('resume_layer1_attempt');

      // Verify resume_requested detail includes worker status
      // (sendMessage sets status to 'working' before calling resumeSession)
      const reqLog = logs.find(l => l.event === 'resume_requested');
      expect(reqLog?.detail).toContain('working');
      expect(reqLog?.taskId).toBe('task-1');

      // Verify layer1 detail includes sessionId
      const l1Log = logs.find(l => l.event === 'resume_layer1_attempt');
      expect(l1Log?.detail).toContain('sess-resume-1');

      // Should NOT have layer1_skipped (sessionId was present)
      expect(events).not.toContain('resume_layer1_skipped');
    });
  });

  describe('Layer 2 path (no sessionId)', () => {
    test('logs resume_requested, resume_layer1_skipped, and resume_layer2_attempt', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        sessionId: undefined,
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-reconstruct' },
        { type: 'result', subtype: 'success', session_id: 'sess-reconstruct' },
      ];

      await manager.sendMessage('w-log-1', 'Continue from here');
      await new Promise(r => setTimeout(r, 200));

      const logs = getSessionLogCalls();
      const events = logs.map(l => l.event);

      expect(events).toContain('resume_requested');
      expect(events).toContain('resume_layer1_skipped');
      expect(events).toContain('resume_layer2_attempt');

      // Should NOT have layer1 attempt (no sessionId)
      expect(events).not.toContain('resume_layer1_attempt');

      // Verify layer1_skipped detail
      const skipLog = logs.find(l => l.event === 'resume_layer1_skipped');
      expect(skipLog?.detail).toContain('No sessionId');
    });
  });

  describe('Eviction logging', () => {
    test('logs worker_evicted when evicting completed worker', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        id: 'w-evict-1',
        status: 'done',
        lastActivity: Date.now() - 11 * 60 * 1000, // 11 minutes ago (past 10min retention)
        completedAt: Date.now() - 11 * 60 * 1000,
      });
      injectWorker(manager, worker);

      // Trigger eviction by calling the private method
      (manager as any).evictCompletedWorkers();

      const logs = getSessionLogCalls();
      const evictLog = logs.find(l => l.event === 'worker_evicted');

      expect(evictLog).toBeDefined();
      expect(evictLog?.workerId).toBe('w-evict-1');
      expect(evictLog?.detail).toContain('done');

      // Worker should be removed from memory
      const workers = (manager as any).workers as Map<string, LocalWorker>;
      expect(workers.has('w-evict-1')).toBe(false);
    });

    test('does not log eviction for workers within retention period', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        id: 'w-evict-2',
        status: 'done',
        lastActivity: Date.now(), // just now
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      (manager as any).evictCompletedWorkers();

      const logs = getSessionLogCalls();
      const evictLog = logs.find(l => l.event === 'worker_evicted');
      expect(evictLog).toBeUndefined();

      // Worker should still be in memory
      const workers = (manager as any).workers as Map<string, LocalWorker>;
      expect(workers.has('w-evict-2')).toBe(true);
    });
  });
});
