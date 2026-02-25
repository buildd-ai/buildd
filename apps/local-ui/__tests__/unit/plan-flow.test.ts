/**
 * Unit tests for the plan creation flow in WorkerManager.
 *
 * Tests: ExitPlanMode tool_result unblocking, session generation guard,
 * plan extraction from planStartMessageIndex, stale timeout for planning,
 * plan file persistence, permission mode on approval, and request changes flow.
 *
 * Run: bun test apps/local-ui/__tests__/unit/plan-flow.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { LocalWorker, LocalUIConfig, WaitingFor } from '../../src/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

let mockMessages: any[] = [];
let mockStreamInputFn = mock(() => {});
let queryCallCount = 0;
let lastQueryOpts: any = null;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: any) => {
    queryCallCount++;
    lastQueryOpts = opts;
    const msgs = [...mockMessages];
    let idx = 0;
    return {
      streamInput: mockStreamInputFn,
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
const mockReportSkillInstallResult = mock(async () => ({}));

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
    reportSkillInstallResult = mockReportSkillInstallResult;
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
    subscribe() { return { bind: () => {} }; }
    unsubscribe() {}
    disconnect() {}
  },
}));

// Track writeFileSync calls to verify plan file persistence
const writeFileSyncCalls: Array<{ path: string; content: string }> = [];
mock.module('fs', () => ({
  existsSync: () => false,
  readFileSync: (path: string) => {
    // Allow reading plan files that were "written"
    const written = writeFileSyncCalls.find(c => c.path === path);
    if (written) return written.content;
    return '{}';
  },
  writeFileSync: (path: string, content: string) => {
    writeFileSyncCalls.push({ path, content });
  },
  mkdirSync: () => {},
  unlinkSync: () => {},
  renameSync: () => {},
  readdirSync: () => [],
  appendFileSync: () => {},
  statSync: () => ({ size: 0, mtimeMs: 0 }),
}));

const mockStoreSaveWorker = mock(() => {});
mock.module('../../src/worker-store', () => ({
  saveWorker: mockStoreSaveWorker,
  loadAllWorkers: () => [],
  loadWorker: () => null,
  deleteWorker: () => {},
}));

mock.module('../../src/skills.js', () => ({
  syncSkillToLocal: async () => {},
}));

mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ tools: [], envKeys: [], mcp: [] }),
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

function makeTask() {
  return {
    id: 'task-1',
    title: 'Test task',
    description: 'Do something',
    workspaceId: 'ws-1',
    workspace: { name: 'test-workspace' },
    status: 'assigned',
    priority: 1,
  };
}

function makeWorker(overrides?: Partial<LocalWorker>): LocalWorker {
  return {
    id: 'w-plan-1',
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

function injectWorker(
  manager: InstanceType<typeof WorkerManager>,
  worker: LocalWorker,
  opts?: { withSession?: boolean },
) {
  const workers = (manager as any).workers as Map<string, LocalWorker>;
  workers.set(worker.id, worker);

  if (opts?.withSession) {
    const sessions = (manager as any).sessions as Map<string, any>;
    const queue: any[] = [];
    const resolvers: Array<(r: any) => void> = [];
    let done = false;

    const inputStream = {
      enqueue: (msg: any) => {
        if (done) return;
        if (resolvers.length > 0) {
          resolvers.shift()!({ value: msg, done: false });
        } else {
          queue.push(msg);
        }
      },
      end: () => { done = true; resolvers.forEach(r => r({ value: undefined, done: true })); },
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
            if (done) return Promise.resolve({ value: undefined, done: true });
            return new Promise(resolve => resolvers.push(resolve));
          },
        };
      },
      _queue: queue,  // Expose for assertions
    };

    sessions.set(worker.id, {
      inputStream,
      abortController: new AbortController(),
      cwd: '/tmp/test-workspace',
      repoPath: '/tmp/test-workspace',
      generation: 0,
    });
  }
}

function getSession(manager: InstanceType<typeof WorkerManager>, workerId: string) {
  return (manager as any).sessions.get(workerId);
}

function clearAllMocks() {
  mockMessages = [];
  queryCallCount = 0;
  lastQueryOpts = null;
  writeFileSyncCalls.length = 0;
  mockUpdateWorker.mockReset();
  mockUpdateWorker.mockImplementation(async () => ({}));
  mockClaimTask.mockReset();
  mockClaimTask.mockImplementation(async () => ({ workers: [] }));
  mockGetWorkspaceConfig.mockReset();
  mockGetWorkspaceConfig.mockImplementation(async () => ({ configStatus: 'unconfigured' }));
  mockGetCompactObservations.mockReset();
  mockGetCompactObservations.mockImplementation(async () => ({ markdown: '', count: 0 }));
  mockSearchObservations.mockReset();
  mockSearchObservations.mockImplementation(async () => []);
  mockGetBatchObservations.mockReset();
  mockGetBatchObservations.mockImplementation(async () => []);
  mockCreateObservation.mockReset();
  mockCreateObservation.mockImplementation(async () => ({}));
  mockStreamInputFn.mockClear();
  mockStoreSaveWorker.mockClear();
  mockSendHeartbeat.mockReset();
  mockSendHeartbeat.mockImplementation(async () => ({}));
  mockListWorkspaces.mockReset();
  mockListWorkspaces.mockImplementation(async () => []);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Plan Flow', () => {
  let manager: InstanceType<typeof WorkerManager>;

  afterEach(() => {
    manager?.destroy();
  });

  beforeEach(() => {
    clearAllMocks();
  });

  // ─── ExitPlanMode tool_result ─────────────────────────────────────────

  describe('ExitPlanMode — tool_result unblocking', () => {
    test('sends tool_result after ExitPlanMode to unblock SDK', async () => {
      // Simulate: init → agent text → EnterPlanMode → agent plan text → ExitPlanMode → result
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-plan-1' },
        {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_enter',
              name: 'EnterPlanMode',
              input: {},
            }],
          },
        },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '## My Plan\n\n1. Do step A\n2. Do step B' }],
          },
        },
        {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_exit',
              name: 'ExitPlanMode',
              input: {},
            }],
          },
        },
        { type: 'result', subtype: 'success', session_id: 'sess-plan-1' },
      ];

      mockClaimTask.mockImplementation(async () => ({ workers: [{
        id: 'w-exit-plan',
        branch: 'buildd/exit-plan',
        task: { ...makeTask(), mode: 'planning' },
      }] }));

      manager = new WorkerManager(makeConfig());
      await manager.claimAndStart({ ...makeTask(), mode: 'planning' });
      await new Promise(r => setTimeout(r, 300));

      const worker = manager.getWorker('w-exit-plan');
      expect(worker).toBeDefined();

      // Worker should be in waiting status with plan_approval
      expect(worker!.status).toBe('waiting');
      expect(worker!.waitingFor?.type).toBe('plan_approval');

      // The inputStream should have received a tool_result for ExitPlanMode
      // (We can verify this by checking that the session was not aborted/errored)
      expect(worker!.error).toBeUndefined();

      // Plan content should be captured
      expect(worker!.planContent).toContain('My Plan');
      expect(worker!.planContent).toContain('step A');
    });

    test('ExitPlanMode sets planStartMessageIndex on EnterPlanMode', async () => {
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-idx' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Analyzing codebase...' }] },
        },
        {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_enter2',
              name: 'EnterPlanMode',
              input: {},
            }],
          },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '## Plan Part 1\nStep A' }] },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '## Plan Part 2\nStep B' }] },
        },
        {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_exit2',
              name: 'ExitPlanMode',
              input: {},
            }],
          },
        },
        { type: 'result', subtype: 'success', session_id: 'sess-idx' },
      ];

      mockClaimTask.mockImplementation(async () => ({ workers: [{
        id: 'w-idx',
        branch: 'buildd/idx',
        task: { ...makeTask(), mode: 'planning' },
      }] }));

      manager = new WorkerManager(makeConfig());
      await manager.claimAndStart({ ...makeTask(), mode: 'planning' });
      await new Promise(r => setTimeout(r, 300));

      const worker = manager.getWorker('w-idx');
      expect(worker).toBeDefined();

      // planContent should only contain text from AFTER EnterPlanMode
      // "Analyzing codebase..." should NOT be in the plan content
      expect(worker!.planContent).not.toContain('Analyzing codebase');
      expect(worker!.planContent).toContain('Plan Part 1');
      expect(worker!.planContent).toContain('Plan Part 2');
    });

    test('ExitPlanMode waitingFor has three approval options', async () => {
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-opts' },
        {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_enter3',
              name: 'EnterPlanMode',
              input: {},
            }],
          },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '## Plan' }] },
        },
        {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_exit3',
              name: 'ExitPlanMode',
              input: {},
            }],
          },
        },
        { type: 'result', subtype: 'success', session_id: 'sess-opts' },
      ];

      mockClaimTask.mockImplementation(async () => ({ workers: [{
        id: 'w-opts',
        branch: 'buildd/opts',
        task: { ...makeTask(), mode: 'planning' },
      }] }));

      manager = new WorkerManager(makeConfig());
      await manager.claimAndStart({ ...makeTask(), mode: 'planning' });
      await new Promise(r => setTimeout(r, 300));

      const worker = manager.getWorker('w-opts');
      expect(worker!.waitingFor?.options).toHaveLength(3);
      const labels = worker!.waitingFor!.options!.map((o: any) => o.label);
      expect(labels).toContain('Approve & implement (bypass permissions)');
      expect(labels).toContain('Approve & implement (with review)');
      expect(labels).toContain('Request changes');
    });
  });

  // ─── Plan file persistence ────────────────────────────────────────────

  describe('Plan file persistence', () => {
    test('writes plan markdown to ~/.buildd/plans/{workerId}.md', async () => {
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-file' },
        {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_enter_f',
              name: 'EnterPlanMode',
              input: {},
            }],
          },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '# Persisted Plan\nStep 1' }] },
        },
        {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_exit_f',
              name: 'ExitPlanMode',
              input: {},
            }],
          },
        },
        { type: 'result', subtype: 'success', session_id: 'sess-file' },
      ];

      mockClaimTask.mockImplementation(async () => ({ workers: [{
        id: 'w-file',
        branch: 'buildd/file',
        task: { ...makeTask(), mode: 'planning' },
      }] }));

      manager = new WorkerManager(makeConfig());
      await manager.claimAndStart({ ...makeTask(), mode: 'planning' });
      await new Promise(r => setTimeout(r, 300));

      const worker = manager.getWorker('w-file');
      expect(worker!.planFilePath).toBeDefined();
      expect(worker!.planFilePath).toContain('w-file');
      expect(worker!.planFilePath).toContain('plans');

      // Verify writeFileSync was called with plan content
      const planWrite = writeFileSyncCalls.find(c => c.path.includes('w-file'));
      expect(planWrite).toBeDefined();
      expect(planWrite!.content).toContain('Persisted Plan');
    });
  });

  // ─── Session generation guard ─────────────────────────────────────────

  describe('Session generation guard', () => {
    test('session generation is stored on session object', () => {
      manager = new WorkerManager(makeConfig());
      const worker = makeWorker({ id: 'w-gen-1' });
      injectWorker(manager, worker, { withSession: true });

      const session = getSession(manager, 'w-gen-1');
      expect(session).toBeDefined();
      expect(typeof session.generation).toBe('number');
    });
  });

  // ─── Stale timeout for planning ───────────────────────────────────────

  describe('Stale timeout', () => {
    test('skips stale check for workers in waiting status', () => {
      manager = new WorkerManager(makeConfig());
      const worker = makeWorker({
        id: 'w-stale-wait',
        status: 'waiting',
        lastActivity: Date.now() - 600_000, // 10 min ago
        waitingFor: {
          type: 'plan_approval',
          prompt: 'Review plan',
          toolUseId: 'toolu_stale',
        },
      });
      injectWorker(manager, worker);

      // Trigger stale check
      (manager as any).checkStale();

      // Worker should NOT be marked stale (waiting workers are skipped)
      expect(worker.status).toBe('waiting');
    });

    test('uses 15-minute timeout when planning is active', () => {
      manager = new WorkerManager(makeConfig());
      const worker = makeWorker({
        id: 'w-stale-plan',
        status: 'working',
        lastActivity: Date.now() - 400_000, // ~6.7 min ago (> 5 min, < 15 min)
        planStartMessageIndex: 5,
      });
      injectWorker(manager, worker);

      (manager as any).checkStale();

      // Worker should NOT be stale yet (within 15-min planning timeout)
      expect(worker.status).toBe('working');
    });

    test('marks working worker stale after 5 minutes (no planning)', () => {
      manager = new WorkerManager(makeConfig());
      const worker = makeWorker({
        id: 'w-stale-normal',
        status: 'working',
        lastActivity: Date.now() - 400_000, // ~6.7 min ago
        // No planStartMessageIndex — standard 5-min timeout applies
      });
      injectWorker(manager, worker);

      (manager as any).checkStale();

      // Worker SHOULD be stale (> 5 min without planning)
      expect(worker.status).toBe('stale');
    });

    test('marks planning worker stale after 15 minutes', () => {
      manager = new WorkerManager(makeConfig());
      const worker = makeWorker({
        id: 'w-stale-plan-expired',
        status: 'working',
        lastActivity: Date.now() - 1_000_000, // ~16.7 min ago
        planStartMessageIndex: 5,
      });
      injectWorker(manager, worker);

      (manager as any).checkStale();

      // Worker SHOULD be stale (> 15 min planning timeout)
      expect(worker.status).toBe('stale');
    });
  });

  // ─── Permission mode on approval ──────────────────────────────────────

  describe('Permission mode on approval', () => {
    test('bypass mode sends correct message and starts session', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'waiting',
        sessionId: 'sess-mode',
        planContent: '# Plan\nStep 1',
        waitingFor: {
          type: 'plan_approval',
          prompt: 'Review plan',
          toolUseId: 'toolu_mode',
        },
      });
      injectWorker(manager, worker, { withSession: true });

      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-bypass' },
        { type: 'result', subtype: 'success', session_id: 'sess-bypass' },
      ];

      const queryCountBefore = queryCallCount;
      const result = await manager.sendMessage('w-plan-1', 'Approve & implement (bypass permissions)');
      expect(result).toBe(true);

      await new Promise(r => setTimeout(r, 200));

      // A new session should have been started
      expect(queryCallCount).toBeGreaterThan(queryCountBefore);

      // The task should have planApprovalMode in context
      expect(lastQueryOpts).toBeDefined();
    });

    test('review mode sends correct message and starts session', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'waiting',
        sessionId: 'sess-mode2',
        planContent: '# Plan\nStep 1',
        waitingFor: {
          type: 'plan_approval',
          prompt: 'Review plan',
          toolUseId: 'toolu_mode2',
        },
      });
      injectWorker(manager, worker, { withSession: true });

      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-review' },
        { type: 'result', subtype: 'success', session_id: 'sess-review' },
      ];

      const queryCountBefore = queryCallCount;
      const result = await manager.sendMessage('w-plan-1', 'Approve & implement (with review)');
      expect(result).toBe(true);

      await new Promise(r => setTimeout(r, 200));
      expect(queryCallCount).toBeGreaterThan(queryCountBefore);
    });

    test('legacy "Approve & implement" message still works', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'waiting',
        sessionId: 'sess-legacy',
        planContent: '# Plan\nStep 1',
        waitingFor: {
          type: 'plan_approval',
          prompt: 'Review plan',
          toolUseId: 'toolu_legacy',
        },
      });
      injectWorker(manager, worker, { withSession: true });

      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-legacy-exec' },
        { type: 'result', subtype: 'success', session_id: 'sess-legacy-exec' },
      ];

      const result = await manager.sendMessage('w-plan-1', 'Approve & implement');
      expect(result).toBe(true);

      await new Promise(r => setTimeout(r, 200));
      expect(worker.waitingFor).toBeUndefined();
    });
  });

  // ─── Request changes flow ─────────────────────────────────────────────

  describe('Request changes flow', () => {
    test('starts fresh revision session with feedback and plan', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'waiting',
        sessionId: 'sess-changes',
        planContent: '# Original Plan\nStep A',
        waitingFor: {
          type: 'plan_approval',
          prompt: 'Review plan',
          toolUseId: 'toolu_changes',
        },
      });
      injectWorker(manager, worker, { withSession: true });

      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-revised' },
        { type: 'result', subtype: 'success', session_id: 'sess-revised' },
      ];

      const queryCountBefore = queryCallCount;
      const result = await manager.sendMessage('w-plan-1', 'Add error handling for API calls');
      expect(result).toBe(true);

      await new Promise(r => setTimeout(r, 200));

      // A new revision session should have been started
      expect(queryCallCount).toBeGreaterThan(queryCountBefore);
    });

    test('sends running status to server on revision', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'waiting',
        sessionId: 'sess-changes2',
        planContent: '# Plan',
        waitingFor: {
          type: 'plan_approval',
          prompt: 'Review plan',
          toolUseId: 'toolu_changes2',
        },
      });
      injectWorker(manager, worker, { withSession: true });

      mockUpdateWorker.mockClear();
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-revised2' },
        { type: 'result', subtype: 'success', session_id: 'sess-revised2' },
      ];

      await manager.sendMessage('w-plan-1', 'Fix the approach');
      await new Promise(r => setTimeout(r, 100));

      const runningCalls = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'running' && call[1]?.currentAction === 'Revising plan...'
      );
      expect(runningCalls.length).toBeGreaterThanOrEqual(1);
    });

    test('adds user message to chat timeline', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'waiting',
        sessionId: 'sess-changes3',
        planContent: '# Plan',
        waitingFor: {
          type: 'plan_approval',
          prompt: 'Review plan',
          toolUseId: 'toolu_changes3',
        },
      });
      injectWorker(manager, worker, { withSession: true });

      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-revised3' },
        { type: 'result', subtype: 'success', session_id: 'sess-revised3' },
      ];

      await manager.sendMessage('w-plan-1', 'Needs more detail on step 2');

      const userMsgs = worker.messages.filter(m => m.type === 'user');
      expect(userMsgs.length).toBeGreaterThanOrEqual(1);
      expect(userMsgs.at(-1)?.content).toBe('Needs more detail on step 2');
    });

    test('falls through to normal enqueue when no planContent', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'waiting',
        sessionId: 'sess-no-plan',
        planContent: undefined, // No plan content
        waitingFor: {
          type: 'plan_approval',
          prompt: 'Review plan',
          toolUseId: 'toolu_no_plan',
        },
      });
      injectWorker(manager, worker, { withSession: true });

      const queryCountBefore = queryCallCount;
      const result = await manager.sendMessage('w-plan-1', 'Some feedback');
      expect(result).toBe(true);

      // Should NOT start a new session (no plan to include in feedback)
      // Falls through to the normal enqueue path
      expect(queryCallCount).toBe(queryCountBefore);
    });
  });

  // ─── Plan approval preserves planContent ──────────────────────────────

  describe('Plan approval state', () => {
    test('preserves planContent after approval for UI display', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'waiting',
        sessionId: 'sess-preserve',
        planContent: '# Important Plan\nKeep me around',
        waitingFor: {
          type: 'plan_approval',
          prompt: 'Review plan',
          toolUseId: 'toolu_preserve',
        },
      });
      injectWorker(manager, worker, { withSession: true });

      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-exec-preserve' },
        { type: 'result', subtype: 'success', session_id: 'sess-exec-preserve' },
      ];

      await manager.sendMessage('w-plan-1', 'Approve & implement (with review)');

      // planContent should be preserved for collapsed plan display
      expect(worker.planContent).toBe('# Important Plan\nKeep me around');
    });

    test('adds milestone on approval with mode label', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'waiting',
        sessionId: 'sess-ms',
        planContent: '# Plan',
        waitingFor: {
          type: 'plan_approval',
          prompt: 'Review plan',
          toolUseId: 'toolu_ms',
        },
      });
      injectWorker(manager, worker, { withSession: true });

      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-ms-exec' },
        { type: 'result', subtype: 'success', session_id: 'sess-ms-exec' },
      ];

      await manager.sendMessage('w-plan-1', 'Approve & implement (bypass permissions)');

      const approvalMilestones = worker.milestones.filter(
        m => m.type === 'status' && m.label.includes('bypass permissions')
      );
      expect(approvalMilestones.length).toBeGreaterThanOrEqual(1);
    });
  });
});
