/**
 * WorkerManager messaging tests — verifies sendMessage() behavior for
 * plan approval, question answers, follow-ups, and edge cases.
 *
 * Strategy: We set up workers by directly populating the internal Maps
 * (workers + sessions) rather than going through the full SDK session flow.
 * This isolates sendMessage() behavior from session startup complexity.
 *
 * Run: bun test apps/local-ui/__tests__/unit/worker-manager-messaging.test.ts
 */

import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';
import type { LocalWorker, LocalUIConfig, WaitingFor } from '../../src/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

let queryCallCount = 0;
let lastQueryOpts: any = null;
let mockMessages: any[] = [];
let mockStreamInputFn = mock(() => {});

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: any) => {
    queryCallCount++;
    lastQueryOpts = opts;
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
  renameSync: () => {},
  readdirSync: () => [],
  unlinkSync: () => {},
}));

mock.module('../../src/skills.js', () => ({
  syncSkillToLocal: async () => {},
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
    id: 'w-msg-1',
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

// Inject a worker and optional session directly into manager internals
function injectWorker(
  manager: InstanceType<typeof WorkerManager>,
  worker: LocalWorker,
  opts?: { withSession?: boolean },
) {
  const workers = (manager as any).workers as Map<string, LocalWorker>;
  workers.set(worker.id, worker);

  if (opts?.withSession) {
    // Create a minimal session with an input stream
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
    };

    sessions.set(worker.id, {
      inputStream,
      abortController: new AbortController(),
      cwd: '/tmp/test-workspace',
    });
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WorkerManager — sendMessage', () => {
  let manager: InstanceType<typeof WorkerManager>;

  afterEach(() => {
    manager?.destroy();
  });

  beforeEach(() => {
    queryCallCount = 0;
    lastQueryOpts = null;
    mockMessages = [];
    mockUpdateWorker.mockClear();
    mockClaimTask.mockClear();
    mockStreamInputFn.mockClear();
  });

  test('returns false for non-existent worker', async () => {
    manager = new WorkerManager(makeConfig());
    const result = await manager.sendMessage('nonexistent-worker', 'hello');
    expect(result).toBe(false);
  });

  describe('Plan approval — "Approve & implement"', () => {
    test('kills session and starts fresh with plan as prompt', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'waiting',
        sessionId: 'sess-plan',
        planContent: '# My Plan\n\n1. Step A\n2. Step B',
        waitingFor: {
          type: 'plan_approval',
          prompt: 'Review plan',
          options: [{ label: 'Approve & implement' }, { label: 'Request changes' }],
          toolUseId: 'toolu_plan_1',
        },
      });
      injectWorker(manager, worker, { withSession: true });

      const queryCountBefore = queryCallCount;

      // Set up messages for the new execution session
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-exec' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Executing plan.' }] } },
        { type: 'result', subtype: 'success', session_id: 'sess-exec' },
      ];

      const result = await manager.sendMessage('w-msg-1', 'Approve & implement');
      expect(result).toBe(true);

      await new Promise(r => setTimeout(r, 200));

      // A new session should have been started
      expect(queryCallCount).toBeGreaterThan(queryCountBefore);

      // Worker state should be cleared
      expect(worker.waitingFor).toBeUndefined();
      expect(worker.planContent).toBeUndefined();
    });

    test('emits worker_update with working status', async () => {
      manager = new WorkerManager(makeConfig());
      const events: any[] = [];
      manager.onEvent((e: any) => {
        if (e.type === 'worker_update') {
          events.push({ currentAction: e.worker.currentAction, status: e.worker.status });
        }
      });

      const worker = makeWorker({
        status: 'waiting',
        sessionId: 'sess-plan',
        planContent: '# Plan',
        waitingFor: {
          type: 'plan_approval',
          prompt: 'Review plan',
          toolUseId: 'toolu_p1',
        },
      });
      injectWorker(manager, worker, { withSession: true });

      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-exec2' },
        { type: 'result', subtype: 'success', session_id: 'sess-exec2' },
      ];

      await manager.sendMessage('w-msg-1', 'Approve & implement');
      await new Promise(r => setTimeout(r, 100));

      const executingEvents = events.filter(e => e.currentAction === 'Executing plan...');
      expect(executingEvents.length).toBeGreaterThanOrEqual(1);
    });

    test('syncs running status to server after approval', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'waiting',
        sessionId: 'sess-plan',
        planContent: '# Plan',
        waitingFor: {
          type: 'plan_approval',
          prompt: 'Review plan',
          toolUseId: 'toolu_p1',
        },
      });
      injectWorker(manager, worker, { withSession: true });

      mockUpdateWorker.mockClear();
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-exec3' },
        { type: 'result', subtype: 'success', session_id: 'sess-exec3' },
      ];

      await manager.sendMessage('w-msg-1', 'Approve & implement');
      await new Promise(r => setTimeout(r, 100));

      const runningCalls = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'running' && call[1]?.waitingFor === null
      );
      expect(runningCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Plan revision — custom text', () => {
    test('enqueues message and clears waiting state', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'waiting',
        sessionId: 'sess-plan',
        planContent: '# Plan',
        waitingFor: {
          type: 'plan_approval',
          prompt: 'Review plan',
          toolUseId: 'toolu_plan_rev',
        },
      });
      injectWorker(manager, worker, { withSession: true });

      const result = await manager.sendMessage('w-msg-1', 'Please add error handling');
      expect(result).toBe(true);

      expect(worker.status).toBe('working');
      expect(worker.waitingFor).toBeUndefined();
      expect(worker.currentAction).toBe('Processing response...');
    });
  });

  describe('Question answer', () => {
    test('enqueues response and transitions to working', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'waiting',
        sessionId: 'sess-q',
        waitingFor: {
          type: 'question',
          prompt: 'Which format?',
          options: [{ label: 'JSON' }, { label: 'YAML' }],
          toolUseId: 'toolu_ask_1',
        },
      });
      injectWorker(manager, worker, { withSession: true });

      const result = await manager.sendMessage('w-msg-1', 'JSON');
      expect(result).toBe(true);

      expect(worker.status).toBe('working');
      expect(worker.waitingFor).toBeUndefined();
      expect(worker.currentAction).toBe('Processing response...');
    });

    test('syncs cleared waiting state to server', async () => {
      manager = new WorkerManager(makeConfig());
      mockUpdateWorker.mockClear();

      const worker = makeWorker({
        status: 'waiting',
        sessionId: 'sess-q2',
        waitingFor: {
          type: 'question',
          prompt: 'Pick one?',
          toolUseId: 'toolu_ask_2',
        },
      });
      injectWorker(manager, worker, { withSession: true });

      await manager.sendMessage('w-msg-1', 'Option A');
      await new Promise(r => setTimeout(r, 50));

      const clearCalls = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'running' && call[1]?.waitingFor === null
      );
      expect(clearCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Message to done/error worker (no session)', () => {
    test('starts follow-up session for done worker', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        sessionId: 'sess-done',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker); // no active session

      const queryCountBefore = queryCallCount;

      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-followup' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Following up.' }] } },
        { type: 'result', subtype: 'success', session_id: 'sess-followup' },
      ];

      const result = await manager.sendMessage('w-msg-1', 'Can you also fix the tests?');
      expect(result).toBe(true);

      await new Promise(r => setTimeout(r, 200));

      expect(queryCallCount).toBeGreaterThan(queryCountBefore);
      expect(worker.error).toBeUndefined();
    });

    test('starts follow-up session for error worker', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'error',
        error: 'Something failed',
        sessionId: 'sess-err',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-err-followup' },
        { type: 'result', subtype: 'success', session_id: 'sess-err-followup' },
      ];

      const result = await manager.sendMessage('w-msg-1', 'Try again');
      expect(result).toBe(true);

      expect(worker.status).toBe('working');
      expect(worker.error).toBeUndefined();
    });

    test('handles done worker with no sessionId (text reconstruction)', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        sessionId: undefined, // No sessionId to resume
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-reconstruct' },
        { type: 'result', subtype: 'success', session_id: 'sess-reconstruct' },
      ];

      const result = await manager.sendMessage('w-msg-1', 'Continue from here');
      expect(result).toBe(true);
      expect(worker.status).toBe('working');
    });
  });

  describe('Message to stale worker', () => {
    test('enqueues message and transitions to working', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({ status: 'stale' });
      injectWorker(manager, worker, { withSession: true });

      const result = await manager.sendMessage('w-msg-1', 'Are you still there?');
      expect(result).toBe(true);

      expect(worker.status).toBe('working');
      expect(worker.currentAction).toBe('Processing message...');
    });
  });

  describe('Message adds to chat timeline', () => {
    test('user message appears in worker.messages', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'waiting',
        sessionId: 'sess-chat',
        waitingFor: {
          type: 'question',
          prompt: 'What next?',
          toolUseId: 'toolu_chat',
        },
      });
      injectWorker(manager, worker, { withSession: true });

      await manager.sendMessage('w-msg-1', 'My answer is B');

      const userMsgs = worker.messages.filter(m => m.type === 'user');
      expect(userMsgs.length).toBeGreaterThanOrEqual(1);
      expect(userMsgs.at(-1)?.content).toBe('My answer is B');
    });
  });

  describe('Message adds milestone', () => {
    test('user message creates milestone', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'waiting',
        sessionId: 'sess-ms',
        waitingFor: {
          type: 'question',
          prompt: 'Choose?',
          toolUseId: 'toolu_ms',
        },
      });
      injectWorker(manager, worker, { withSession: true });

      await manager.sendMessage('w-msg-1', 'I choose option A for this');

      const userMilestones = worker.milestones.filter(
        m => m.type === 'status' && m.label.startsWith('User:')
      );
      expect(userMilestones.length).toBeGreaterThanOrEqual(1);
    });
  });
});
