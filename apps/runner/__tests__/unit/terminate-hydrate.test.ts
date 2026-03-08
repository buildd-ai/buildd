/**
 * Terminate-and-hydrate tests — verifies the 3-layer resume flow when
 * sendMessage() is called on a completed (done/error) worker:
 *
 *   Layer 1: Resume SDK session (resume=sessionId)
 *   Layer 2: restartWithReconstructedContext (fallback — only if startSession rejects)
 *   Layer 3: Text reconstruction (no sessionId available)
 *
 * Note: startSession has its own try/catch, so errors during iteration are
 * caught internally. The .catch() fallback to Layer 2 in sendMessage only
 * triggers for errors that escape startSession's catch block.
 *
 * Run: bun test apps/runner/__tests__/unit/terminate-hydrate.test.ts
 */

import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';
import type { LocalWorker, LocalUIConfig } from '../../src/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

let queryCallCount = 0;
let lastQueryOpts: any = null;
let allQueryOpts: any[] = [];

// Configurable query behavior: resolve or reject per call
type QueryBehavior = { type: 'success'; messages: any[] } | { type: 'error'; error: Error };
let queryBehaviors: QueryBehavior[] = [];
let defaultQueryBehavior: QueryBehavior = { type: 'success', messages: [] };

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: any) => {
    queryCallCount++;
    lastQueryOpts = opts;
    allQueryOpts.push(opts);

    const behavior = queryBehaviors.shift() || defaultQueryBehavior;

    if (behavior.type === 'error') {
      // Return an iterator that throws on first next()
      return {
        streamInput: mock(() => {}),
        supportedModels: async () => [],
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw behavior.error;
            },
          };
        },
      };
    }

    const msgs = [...behavior.messages];
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

mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ platform: 'linux', arch: 'x64', tools: [], envKeys: [] }),
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
    id: 'w-th-1',
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

function successMessages(sessionId = 'sess-resumed') {
  return [
    { type: 'system', subtype: 'init', session_id: sessionId },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Continuing work.' }] } },
    { type: 'result', subtype: 'success', session_id: sessionId },
  ];
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WorkerManager — terminate and hydrate (resume layers)', () => {
  let manager: InstanceType<typeof WorkerManager>;

  afterEach(() => {
    manager?.destroy();
  });

  beforeEach(() => {
    queryCallCount = 0;
    lastQueryOpts = null;
    allQueryOpts = [];
    queryBehaviors = [];
    defaultQueryBehavior = { type: 'success', messages: successMessages() };
    mockUpdateWorker.mockClear();
    mockClaimTask.mockClear();
  });

  describe('Layer 1 — SDK session resume (success)', () => {
    test('resumes with sessionId when worker is done and has sessionId', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        sessionId: 'sess-original',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      defaultQueryBehavior = { type: 'success', messages: successMessages('sess-resumed') };

      const result = await manager.sendMessage('w-th-1', 'Please also add tests');
      expect(result).toBe(true);

      // Wait for async session start
      await new Promise(r => setTimeout(r, 300));

      // Should have called query (Layer 1 resume)
      expect(queryCallCount).toBeGreaterThanOrEqual(1);

      // The query options should include resume with the original sessionId
      const resumeCall = allQueryOpts.find(o => o.options?.resume === 'sess-original');
      expect(resumeCall).toBeDefined();
    });

    test('transitions worker from done to working on resume', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        sessionId: 'sess-original',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      const result = await manager.sendMessage('w-th-1', 'Follow up');
      expect(result).toBe(true);

      // sendMessage sets status synchronously before async session
      expect(worker.status).toBe('working');
      expect(worker.error).toBeUndefined();
      expect(worker.completedAt).toBeUndefined();
      expect(worker.currentAction).toBe('Processing follow-up...');
    });

    test('clears error state when resuming an errored worker', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'error',
        error: 'Previous failure',
        sessionId: 'sess-err',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      await manager.sendMessage('w-th-1', 'Try again');

      expect(worker.status).toBe('working');
      expect(worker.error).toBeUndefined();
    });

    test('updates server with running status', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        sessionId: 'sess-sync',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      await manager.sendMessage('w-th-1', 'Continue');
      await new Promise(r => setTimeout(r, 100));

      const runningCalls = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'running'
      );
      expect(runningCalls.length).toBeGreaterThanOrEqual(1);
    });

    test('adds user message to chat timeline', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        sessionId: 'sess-chat',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      await manager.sendMessage('w-th-1', 'Add unit tests');

      const userMsgs = worker.messages.filter(m => m.type === 'user');
      expect(userMsgs.length).toBeGreaterThanOrEqual(1);
      expect(userMsgs.at(-1)?.content).toBe('Add unit tests');
    });

    test('adds milestone for user follow-up', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        sessionId: 'sess-ms',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      await manager.sendMessage('w-th-1', 'Fix the linting errors');

      const userMilestones = worker.milestones.filter(
        m => m.type === 'status' && m.label.startsWith('User:')
      );
      expect(userMilestones.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Layer 1 failure — resume error handling', () => {
    test('falls through to Layer 2 when resume session iterator throws', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        sessionId: 'sess-will-fail',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      // Layer 1 resume fails, Layer 2 (reconstruction) succeeds via default
      queryBehaviors = [
        { type: 'error', error: new Error('Session not found on disk') },
      ];
      defaultQueryBehavior = { type: 'success', messages: successMessages() };

      const result = await manager.sendMessage('w-th-1', 'Continue the work');
      expect(result).toBe(true);

      // Wait for both layers to attempt
      await new Promise(r => setTimeout(r, 500));

      // Layer 2 should have recovered — worker is not stuck in error
      expect(queryCallCount).toBeGreaterThanOrEqual(2);
      expect(worker.status).toBe('done');
    });

    test('resume attempt uses the original sessionId', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        sessionId: 'sess-original-123',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      queryBehaviors = [
        { type: 'error', error: new Error('Session expired') },
      ];

      await manager.sendMessage('w-th-1', 'Follow up');
      await new Promise(r => setTimeout(r, 500));

      // Verify the resume option was passed
      const resumeCall = allQueryOpts.find(o => o.options?.resume === 'sess-original-123');
      expect(resumeCall).toBeDefined();
    });
  });

  describe('Layer 1 → Layer 2 fallthrough', () => {
    test('falls through to Layer 2 when Layer 1 SDK resume fails', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        sessionId: 'sess-will-fail',
        completedAt: Date.now(),
        taskDescription: 'Original task description',
        messages: [
          { type: 'text', content: 'I finished the work.', timestamp: Date.now() },
        ],
      });
      injectWorker(manager, worker);

      // Layer 1 fails (exit code 1), Layer 2 succeeds
      queryBehaviors = [
        { type: 'error', error: new Error('Claude Code process exited with code 1') },
        { type: 'success', messages: successMessages('sess-layer2') },
      ];

      const result = await manager.sendMessage('w-th-1', 'Please also add tests');
      expect(result).toBe(true);

      // Wait for both layers to attempt
      await new Promise(r => setTimeout(r, 500));

      // Should have called query twice: Layer 1 (resume) + Layer 2 (reconstruction)
      expect(queryCallCount).toBeGreaterThanOrEqual(2);

      // First call should have resume option (Layer 1)
      const resumeCall = allQueryOpts.find(o => o.options?.resume === 'sess-will-fail');
      expect(resumeCall).toBeDefined();

      // Second call should NOT have resume option (Layer 2 reconstruction)
      const reconstructionCall = allQueryOpts.find(o => !o.options?.resume);
      expect(reconstructionCall).toBeDefined();

      // Worker should end in done state (Layer 2 succeeded), not error
      expect(worker.status).toBe('done');
    });

    test('waiting worker falls through to Layer 2 when SDK resume fails', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'waiting',
        sessionId: 'sess-waiting-fail',
        waitingFor: { type: 'question', prompt: 'What approach?', toolUseId: 'tu-123' },
        taskDescription: 'Fix the bug',
      });
      injectWorker(manager, worker);

      // Layer 1 fails, Layer 2 succeeds
      queryBehaviors = [
        { type: 'error', error: new Error('Claude Code process exited with code 1') },
        { type: 'success', messages: successMessages('sess-layer2') },
      ];

      const result = await manager.sendMessage('w-th-1', 'Use approach B');
      expect(result).toBe(true);

      await new Promise(r => setTimeout(r, 500));

      // Layer 2 should have been attempted after Layer 1 failed
      expect(queryCallCount).toBeGreaterThanOrEqual(2);

      // Worker should recover (not stuck in error)
      expect(worker.status).not.toBe('error');
    });

    test('sets error only when both Layer 1 and Layer 2 fail', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        sessionId: 'sess-both-fail',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      // Both layers fail
      queryBehaviors = [
        { type: 'error', error: new Error('Claude Code process exited with code 1') },
        { type: 'error', error: new Error('Reconstruction also failed') },
      ];

      const result = await manager.sendMessage('w-th-1', 'Follow up');
      expect(result).toBe(true);

      await new Promise(r => setTimeout(r, 500));

      // Both layers attempted
      expect(queryCallCount).toBeGreaterThanOrEqual(2);

      // Now worker should be in error state
      expect(worker.status).toBe('error');
    });
  });

  describe('Error propagation on failure (both layers fail)', () => {
    test('sets error state when both Layer 1 and Layer 2 fail', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        sessionId: 'sess-fail',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      // Both layers fail
      queryBehaviors = [
        { type: 'error', error: new Error('API rate limit exceeded') },
        { type: 'error', error: new Error('Reconstruction also failed') },
      ];

      const result = await manager.sendMessage('w-th-1', 'Follow up');
      expect(result).toBe(true);

      await new Promise(r => setTimeout(r, 500));

      expect(worker.status).toBe('error');
      expect(worker.error).toBe('Reconstruction also failed');
      expect(worker.completedAt).toBeDefined();
    });

    test('emits worker_update with error status when both layers fail', async () => {
      manager = new WorkerManager(makeConfig());
      const events: any[] = [];
      manager.onEvent((e: any) => {
        if (e.type === 'worker_update') events.push(e);
      });

      const worker = makeWorker({
        status: 'done',
        sessionId: 'sess-fail-events',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      queryBehaviors = [
        { type: 'error', error: new Error('Session crashed') },
        { type: 'error', error: new Error('Reconstruction crashed') },
      ];

      await manager.sendMessage('w-th-1', 'Follow up');
      await new Promise(r => setTimeout(r, 500));

      const errorEvents = events.filter(e => e.worker?.status === 'error');
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    });

    test('reports failed status to server when both layers fail', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        sessionId: 'sess-server-sync',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      mockUpdateWorker.mockClear();
      queryBehaviors = [
        { type: 'error', error: new Error('Query failed') },
        { type: 'error', error: new Error('Reconstruction failed') },
      ];

      await manager.sendMessage('w-th-1', 'Follow up');
      await new Promise(r => setTimeout(r, 500));

      const failedCalls = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'failed'
      );
      expect(failedCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Layer 3 — text reconstruction (no sessionId)', () => {
    test('uses text reconstruction when no sessionId exists', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        sessionId: undefined, // No sessionId — goes straight to Layer 3
        completedAt: Date.now(),
        taskDescription: 'Implement feature X',
        toolCalls: [
          { name: 'Read', input: { file_path: '/src/main.ts' }, timestamp: Date.now() } as any,
        ],
        messages: [
          { type: 'text', content: 'I completed the implementation.', timestamp: Date.now() },
        ],
      });
      injectWorker(manager, worker);

      defaultQueryBehavior = { type: 'success', messages: successMessages('sess-reconstructed') };

      const result = await manager.sendMessage('w-th-1', 'Also update the docs');
      expect(result).toBe(true);

      await new Promise(r => setTimeout(r, 300));

      // Should have called query once (no resume attempt)
      expect(queryCallCount).toBeGreaterThanOrEqual(1);

      // No query should have a resume option
      const resumeCalls = allQueryOpts.filter(o => o.options?.resume);
      expect(resumeCalls.length).toBe(0);
    });

    test('sets error when reconstruction query fails', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        sessionId: undefined,
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      defaultQueryBehavior = { type: 'error', error: new Error('Reconstruction query failed') };

      await manager.sendMessage('w-th-1', 'Continue');
      await new Promise(r => setTimeout(r, 500));

      // startSession catches the error internally
      expect(worker.status).toBe('error');
      expect(worker.error).toBe('Reconstruction query failed');
    });

    test('reconstruction prompt includes context from previous session', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'done',
        sessionId: undefined,
        completedAt: Date.now(),
        taskDescription: 'Build the login page',
        toolCalls: [
          { name: 'Read', input: { file_path: '/src/login.ts' }, timestamp: Date.now() } as any,
          { name: 'Edit', input: { file_path: '/src/auth.ts' }, timestamp: Date.now() } as any,
        ],
        messages: [
          { type: 'text', content: 'Login page built.', timestamp: Date.now() },
          { type: 'user', content: 'Looks good', timestamp: Date.now() },
        ],
        milestones: [
          { type: 'status', label: 'Setup complete', ts: Date.now() },
        ],
      });
      injectWorker(manager, worker);

      defaultQueryBehavior = { type: 'success', messages: successMessages() };

      await manager.sendMessage('w-th-1', 'Add password reset');
      await new Promise(r => setTimeout(r, 300));

      // The reconstructed prompt should include task context
      expect(queryCallCount).toBeGreaterThanOrEqual(1);

      // The prompt sent to the query should contain reconstruction markers
      const queryCall = allQueryOpts[0];
      expect(queryCall).toBeDefined();
      // The prompt includes the follow-up message (via task.description in reconstruction)
      const promptText = typeof queryCall.prompt === 'string' ? queryCall.prompt : '';
      expect(promptText).toContain('Add password reset');
    });
  });

  describe('Worker status transitions', () => {
    test('done → working → done (successful resume)', async () => {
      manager = new WorkerManager(makeConfig());
      const statuses: string[] = [];
      manager.onEvent((e: any) => {
        if (e.type === 'worker_update') statuses.push(e.worker.status);
      });

      const worker = makeWorker({
        status: 'done',
        sessionId: 'sess-transition',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      defaultQueryBehavior = { type: 'success', messages: successMessages() };

      await manager.sendMessage('w-th-1', 'One more thing');
      await new Promise(r => setTimeout(r, 300));

      // Should have transitioned through working
      expect(statuses).toContain('working');
      // Final state should be done (session completed successfully)
      expect(statuses[statuses.length - 1]).toBe('done');
    });

    test('done → working → error (both resume layers fail)', async () => {
      manager = new WorkerManager(makeConfig());
      const statuses: string[] = [];
      manager.onEvent((e: any) => {
        if (e.type === 'worker_update') statuses.push(e.worker.status);
      });

      const worker = makeWorker({
        status: 'done',
        sessionId: 'sess-fail-transition',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      // Both layers fail
      queryBehaviors = [
        { type: 'error', error: new Error('Resume failed') },
        { type: 'error', error: new Error('Reconstruction failed') },
      ];

      await manager.sendMessage('w-th-1', 'Follow up');
      await new Promise(r => setTimeout(r, 500));

      expect(statuses).toContain('working');
      expect(statuses[statuses.length - 1]).toBe('error');
    });

    test('error → working on follow-up message', async () => {
      manager = new WorkerManager(makeConfig());

      const worker = makeWorker({
        status: 'error',
        error: 'Loop detected',
        sessionId: 'sess-err-resume',
        completedAt: Date.now(),
      });
      injectWorker(manager, worker);

      defaultQueryBehavior = { type: 'success', messages: successMessages() };

      await manager.sendMessage('w-th-1', 'Try a different approach');

      // Immediately transitions to working
      expect(worker.status).toBe('working');
      expect(worker.error).toBeUndefined();
    });
  });
});
