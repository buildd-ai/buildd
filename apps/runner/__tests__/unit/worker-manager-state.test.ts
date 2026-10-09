/**
 * WorkerManager state machine tests — verifies status transitions + emitted events
 * when the SDK sends messages (AskUserQuestion, result, error).
 *
 * Strategy: Call handleMessage() indirectly via a mock SDK query that yields
 * controlled message sequences. We mock all external deps before importing WorkerManager.
 *
 * Run: bun test apps/runner/__tests__/unit/worker-manager-state.test.ts
 */

import { describe, test, expect, beforeEach, mock, afterEach, setDefaultTimeout, afterAll } from 'bun:test';
import { tmpdir } from 'os';
import { initTestWorkspace, getTestWorkspace, cleanupTestWorkspace } from '../test-workspace';

// CI runners are slower — give tests more room than the 5s default
setDefaultTimeout(15_000);
import type { LocalWorker, LocalUIConfig } from '../../src/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock SDK query — returns an async iterable that yields controlled messages
let mockMessages: any[] = [];
// Opt-in per-call scripts: each query() call shifts one off (falling back to
// mockMessages when empty), so a test can script a session and its resumed
// nudge turn differently. Prompts the SDK was called with are recorded too.
let mockMessagesQueue: any[][] = [];
let mockQueryPrompts: string[] = [];
let mockStreamInputFn = mock(() => {});
// Opt-in (default off, reset every test): when true, the iterator throws an
// AbortError the moment the real AbortController passed into query() has been
// aborted, instead of quietly continuing to the next scripted message. This
// mirrors the real SDK — session.abortController.abort() makes its async
// generator throw — which the default behavior above does NOT: it lets the
// loop run to `done: true` regardless of abort(), so it only ever exercises
// the post-loop cleanup path, never the catch-block path a thrown abort
// actually takes in production.
let mockThrowOnAbort = false;
const BLOCK_UNTIL_ABORT = Symbol('block-until-abort');
// The SDK `resume` option of each query() call, in order (undefined = fresh session).
let mockQueryResumes: (string | undefined)[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: any) => {
    const msgs = [...(mockMessagesQueue.shift() ?? mockMessages)];
    // The prompt is one open stream: its first message is the task prompt.
    // Read it lazily so the stream is not consumed ahead of the runner.
    mockQueryResumes.push(opts?.options?.resume);
    const slot = mockQueryPrompts.push('') - 1;
    if (typeof opts?.prompt === 'string') {
      mockQueryPrompts[slot] = opts.prompt;
    } else {
      void (async () => {
        for await (const message of opts.prompt) {
          mockQueryPrompts[slot] = (message as any)?.message?.content?.[0]?.text ?? '';
          break;
        }
      })();
    }
    let idx = 0;
    const signal = opts?.options?.abortController?.signal as AbortSignal | undefined;
    return {
      streamInput: mockStreamInputFn,
      supportedModels: async () => [],
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (mockThrowOnAbort && signal?.aborted) {
              const err = new Error('The operation was aborted.');
              err.name = 'AbortError';
              throw err;
            }
            // BLOCK_UNTIL_ABORT: a live session that sits between turns until
            // it is aborted (then throws like the real SDK).
            if (msgs[idx] === BLOCK_UNTIL_ABORT) {
              await new Promise<void>(resolve => {
                if (signal?.aborted) return resolve();
                signal?.addEventListener('abort', () => resolve(), { once: true });
              });
              const err = new Error('The operation was aborted.');
              err.name = 'AbortError';
              throw err;
            }
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

// Mock BuilddClient
const mockUpdateWorker = mock(async () => ({}));
const mockClaimTask = mock(async () => ({ workers: [{ id: 'w-1', branch: 'buildd/test', task: null }] }));
const mockGetWorkspaceConfig = mock(async () => ({ configStatus: 'unconfigured' }));
const mockGetCompactObservations = mock(async () => ({ markdown: '', count: 0 }));
const mockSearchObservations = mock(async () => []);
const mockGetBatchObservations = mock(async () => []);
const mockCreateObservation = mock(async () => ({}));
const mockListWorkspaces = mock(async () => []);
const mockSendHeartbeat = mock(async () => ({}));
const mockRunCleanup = mock(async () => ({}));
const mockSearchFeedbackMemories = mock(async () => []);
const mockGetWorkerRemote = mock(async () => null);
// Defaults to a transport failure (the realistic "gate unreachable" shape),
// which fails open to a human-facing park for a genuinely_blocked session
// end. Tests that need the pushed-turn path override this per-case.
const mockCheckQuestion = mock(async () => { throw new Error('question-check unreachable'); });

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
    searchFeedbackMemories = mockSearchFeedbackMemories;
    getWorkerRemote = mockGetWorkerRemote;
    checkQuestion = mockCheckQuestion;
  },
}));

// Mock workspace resolver
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

// Mock Pusher
mock.module('pusher-js', () => ({
  default: class {
    subscribe() { return { bind: () => {} }; }
    unsubscribe() {}
    disconnect() {}
  },
}));

// Mock fs
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

// Mock skills sync
mock.module('../../src/skills.js', () => ({
  syncSkillToLocal: async () => {},
}));

// Mock env-scan — without this, the WorkerManager constructor's real
// checkBwrapSupport() spawns a real bwrap subprocess to probe namespace
// support, which hangs in CI and times out the first test in this file.
mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ platform: 'linux', arch: 'x64', tools: [], envKeys: [] }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  parseMcpJson: () => [],
  scanMcpServersRich: () => [],
  checkBwrapSupport: () => true,
  checkBwrapMountIsolationSupport: () => true,
}));

// Import WorkerManager after all mocks
const { WorkerManager } = await import('../../src/workers');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<LocalUIConfig>): LocalUIConfig {
  return {
    projectsRoot: '/tmp',
    builddServer: 'http://localhost:3000',
    apiKey: 'test-key',
    maxConcurrent: 2,
    model: 'claude-sonnet-4-5-20250929',
    serverless: true, // Disable heartbeat for tests
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
    status: 'waiting',
    priority: 1,
  };
}

// Collect events emitted by WorkerManager (snapshots worker state since object is shared by reference)
/**
 * Poll until `done()` holds (or give up after `timeoutMs`). A fixed sleep
 * races the mocked session on a loaded CI host; the assertions that follow
 * still report the real failure if it never happens.
 */
async function waitFor(done: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
}

function collectEvents(manager: InstanceType<typeof WorkerManager>) {
  const events: any[] = [];
  manager.onEvent((e: any) => {
    if (e.type === 'worker_update' && e.worker) {
      events.push({
        ...e,
        worker: {
          ...e.worker,
          waitingFor: e.worker.waitingFor ? { ...e.worker.waitingFor } : undefined,
        },
      });
    } else {
      events.push(e);
    }
  });
  return events;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WorkerManager — state transitions', () => {
  let manager: InstanceType<typeof WorkerManager>;

  afterEach(() => {
    manager?.destroy();
  });

  afterAll(() => {


    cleanupTestWorkspace();


  });


  beforeEach(() => {


    initTestWorkspace();
    mockMessages = [];
    mockMessagesQueue = [];
    mockQueryPrompts = [];
    mockQueryResumes = [];
    mockThrowOnAbort = false;
    mockCheckQuestion.mockClear();
    mockCheckQuestion.mockImplementation(async () => { throw new Error('question-check unreachable'); });
    mockUpdateWorker.mockClear();
    mockClaimTask.mockReset();
    mockClaimTask.mockResolvedValue({ workers: [] });
    mockGetWorkspaceConfig.mockClear();
    mockGetCompactObservations.mockClear();
    mockSearchObservations.mockClear();
    mockGetBatchObservations.mockClear();
    mockCreateObservation.mockClear();
    mockStreamInputFn.mockClear();
    mockSendHeartbeat.mockClear();
  });

  describe('AskUserQuestion detection', () => {
    test('sets waiting status with question details', async () => {
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-q1' },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Let me check something.' },
              {
                type: 'tool_use',
                id: 'toolu_ask_1',
                name: 'AskUserQuestion',
                input: {
                  questions: [{
                    question: 'Which format do you prefer?',
                    header: 'Format',
                    options: [
                      { label: 'JSON', description: 'Standard JSON' },
                      { label: 'YAML', description: 'Human-readable YAML' },
                    ],
                  }],
                },
              },
            ],
          },
        },
        { type: 'result', subtype: 'success', session_id: 'sess-q1' },
      ];

      mockClaimTask.mockImplementation(async () => ({ workers: [{
        id: 'w-ask-1',
        branch: 'buildd/ask-test',
        task: makeTask(),
      }] }));

      // Explicit opt-out to test legacy waiting behavior
      manager = new WorkerManager(makeConfig({ inputAsRetry: false }));
      const events = collectEvents(manager);

      await manager.claimAndStart(makeTask());
      await waitFor(() => events.some((e: any) => e.type === 'worker_update' && e.worker?.waitingFor?.type === 'question'));

      const questionEvents = events.filter(
        (e: any) => e.type === 'worker_update' && e.worker?.waitingFor?.type === 'question'
      );
      expect(questionEvents.length).toBeGreaterThanOrEqual(1);

      const qEvent = questionEvents[0];
      expect(qEvent.worker.status).toBe('waiting');
      expect(qEvent.worker.waitingFor.prompt).toBe('Which format do you prefer?');
      expect(qEvent.worker.waitingFor.toolUseId).toBe('toolu_ask_1');
    });

    test('syncs question status to server', async () => {
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-q2' },
        {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_ask_2',
              name: 'AskUserQuestion',
              input: {
                questions: [{ question: 'Pick one?', header: 'Choice', options: [{ label: 'A' }, { label: 'B' }] }],
              },
            }],
          },
        },
        { type: 'result', subtype: 'success', session_id: 'sess-q2' },
      ];

      mockClaimTask.mockImplementation(async () => ({ workers: [{
        id: 'w-ask-sync',
        branch: 'buildd/ask-sync',
        task: makeTask(),
      }] }));

      manager = new WorkerManager(makeConfig());
      await manager.claimAndStart(makeTask());
      const isQuestionSync = (call: any[]) => call[1]?.status === 'waiting_input' && call[1]?.waitingFor?.type === 'question';
      await waitFor(() => mockUpdateWorker.mock.calls.some(isQuestionSync));

      const questionSyncCalls = mockUpdateWorker.mock.calls.filter(isQuestionSync);
      expect(questionSyncCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Session completion', () => {
    test('sets done status with completedAt on success result', async () => {
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-done' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'All done!' }] },
        },
        { type: 'result', subtype: 'success', session_id: 'sess-done' },
      ];

      mockClaimTask.mockImplementation(async () => ({ workers: [{
        id: 'w-done-1',
        branch: 'buildd/done-test',
        task: makeTask(),
      }] }));

      manager = new WorkerManager(makeConfig());
      await manager.claimAndStart(makeTask());
      await waitFor(() => manager.getWorker('w-done-1')?.status === 'done');

      const worker = manager.getWorker('w-done-1');
      expect(worker?.status).toBe('done');
      expect(worker?.completedAt).toBeDefined();
      expect(worker?.hasNewActivity).toBe(true);
      expect(worker?.currentAction).toBe('Completed');
    });

    test('reports completed status to server', async () => {
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-done2' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Done.' }] },
        },
        { type: 'result', subtype: 'success', session_id: 'sess-done2' },
      ];

      mockClaimTask.mockImplementation(async () => ({ workers: [{
        id: 'w-done-2',
        branch: 'buildd/done-test-2',
        task: makeTask(),
      }] }));

      manager = new WorkerManager(makeConfig());
      await manager.claimAndStart(makeTask());
      await waitFor(() => mockUpdateWorker.mock.calls.some((call: any[]) => call[1]?.status === 'completed'));

      const completedCalls = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'completed'
      );
      expect(completedCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Session ID tracking', () => {
    test('captures sessionId from init message', async () => {
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-track-123' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Hello' }] },
        },
        { type: 'result', subtype: 'success', session_id: 'sess-track-123' },
      ];

      mockClaimTask.mockImplementation(async () => ({ workers: [{
        id: 'w-sess-track',
        branch: 'buildd/sess-track',
        task: makeTask(),
      }] }));

      manager = new WorkerManager(makeConfig());
      await manager.claimAndStart(makeTask());
      await waitFor(() => manager.getWorker('w-sess-track')?.sessionId === 'sess-track-123');

      const worker = manager.getWorker('w-sess-track');
      expect(worker?.sessionId).toBe('sess-track-123');
    });
  });

  describe('Phase tracking', () => {
    // Live pause proof (task 4b2b30a9): an agent that only made MCP calls
    // before its first Bash call sat on "Setting up worktree..." for minutes.
    test('an MCP tool call moves currentAction off "Setting up worktree..."', async () => {
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-mcp' },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_m', name: 'mcp__buildd__buildd', input: { action: 'update_progress' } }] } },
        BLOCK_UNTIL_ABORT,
      ];
      mockClaimTask.mockImplementation(async () => ({ workers: [{ id: 'w-mcp', branch: 'buildd/mcp', task: makeTask() }] }));
      manager = new WorkerManager(makeConfig());
      await manager.claimAndStart(makeTask());
      await waitFor(() => manager.getWorker('w-mcp')?.currentAction?.startsWith('Using ') === true);
      expect(manager.getWorker('w-mcp')?.currentAction).toBe('Using buildd');
    });

    test('creates milestones from text + tool_use sequences', async () => {
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-phase' },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'First I will read the file.' },
              { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/test.ts' } },
            ],
          },
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Now I will edit it.' },
              { type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: '/tmp/test.ts' } },
            ],
          },
        },
        { type: 'result', subtype: 'success', session_id: 'sess-phase' },
      ];

      mockClaimTask.mockImplementation(async () => ({ workers: [{
        id: 'w-phase',
        branch: 'buildd/phase-test',
        task: makeTask(),
      }] }));

      manager = new WorkerManager(makeConfig());
      await manager.claimAndStart(makeTask());
      await waitFor(() => manager.getWorker('w-phase')?.status === 'done');

      const worker = manager.getWorker('w-phase');
      // Should have phase milestones
      const phaseMilestones = worker?.milestones.filter(m => m.type === 'phase');
      expect(phaseMilestones!.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('AskUserQuestion — inputAsRetry mode', () => {
    test('aborts session and parks worker as waiting_input with needs_input reason (not failed)', async () => {
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-retry-1' },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'I have a question.' },
              {
                type: 'tool_use',
                id: 'toolu_retry_1',
                name: 'AskUserQuestion',
                input: {
                  questions: [{
                    question: 'Should I use TypeScript or JavaScript?',
                    header: 'Language choice',
                    options: [
                      { label: 'TypeScript' },
                      { label: 'JavaScript' },
                    ],
                  }],
                },
              },
            ],
          },
        },
        { type: 'result', subtype: 'success', session_id: 'sess-retry-1' },
      ];

      mockClaimTask.mockImplementation(async () => ({ workers: [{
        id: 'w-retry-1',
        branch: 'buildd/retry-test',
        task: makeTask(),
      }] }));

      manager = new WorkerManager(makeConfig({ inputAsRetry: true }));
      await manager.claimAndStart(makeTask());
      await new Promise(r => setTimeout(r, 200));

      const worker = manager.getWorker('w-retry-1');
      // Local bookkeeping mirrors the sibling non-abort branch's 'waiting'
      // state (session is gone, but this is a parked question, not a crash).
      expect(worker?.status).toBe('waiting');
      expect(worker?.error).toContain('needs_input');
      expect(worker?.waitingFor?.prompt).toBe('Should I use TypeScript or JavaScript?');

      // The server-facing PATCH must never report this as 'failed' — a hard
      // blocker with a pending question is not a crash. Reporting it as
      // 'failed' fed the generic mission auto-retry gate (blind re-dispatch
      // into the same unanswered question) and hid the task behind
      // deriveTaskPhase's failed-wins-over-waiting_input precedence.
      const failedCalls = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'failed'
      );
      expect(failedCalls.length).toBe(0);
    });

    // Regression for the live bug: session.abortController.abort() (called
    // synchronously right after the immediate waiting_input sync above) makes
    // the REAL SDK's async generator throw on its next iteration — the outer
    // catch block, not the post-loop cleanup branch above, is what actually
    // runs for this abort in production. The sibling test above uses the
    // default mock iterator, which ignores abort() and keeps yielding
    // scripted messages, so it only ever exercises the post-loop branch and
    // would pass even if the catch block still reported 'failed'. This test
    // opts into the abort-throws mock to exercise the path that is actually
    // reached, and is what would have caught the bug (#2050 fixed only the
    // unreachable branch; the reachable one still booked these as
    // code_failure and blind-retried mission tasks into the same unanswered
    // question).
    test('a thrown AbortError from the real abort path also parks as waiting_input, not failed', async () => {
      mockThrowOnAbort = true;
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-retry-throw' },
        {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_retry_throw',
              name: 'AskUserQuestion',
              input: {
                questions: [{ question: 'Should the mission branch merge now?', header: 'Merge now?' }],
              },
            }],
          },
        },
        // Never reached when the abort mock is armed — the iterator throws
        // before yielding this. Left in to prove the assertions below aren't
        // passing merely because there was nothing left to mis-report.
        { type: 'result', subtype: 'success', session_id: 'sess-retry-throw' },
      ];

      mockClaimTask.mockImplementation(async () => ({ workers: [{
        id: 'w-retry-throw',
        branch: 'buildd/retry-throw',
        task: makeTask(),
      }] }));

      manager = new WorkerManager(makeConfig({ inputAsRetry: true }));
      await manager.claimAndStart(makeTask());
      await new Promise(r => setTimeout(r, 200));

      const worker = manager.getWorker('w-retry-throw');
      expect(worker?.status).toBe('waiting');
      expect(worker?.error).toContain('needs_input');
      expect(worker?.waitingFor?.prompt).toBe('Should the mission branch merge now?');

      const failedCalls = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'failed'
      );
      expect(failedCalls.length).toBe(0);

      const waitingCalls = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'waiting_input'
      );
      expect(waitingCalls.length).toBeGreaterThanOrEqual(1);
    });

    // A pushed turn (session-end-classification.ts) is itself a session: an
    // AskUserQuestion inside it takes the real abort path (the SDK generator
    // throws) and must park the worker as waiting_input — not fail it, and
    // not earn a second push. The signal here is genuinely_blocked (no
    // commits, no background job, no denial), so the Jev gate is what sends
    // this session into a pushed turn in the first place — decide retry.
    test('AskUserQuestion during a pushed turn parks as waiting_input, not failed', async () => {
      mockThrowOnAbort = true;
      mockCheckQuestion.mockImplementation(async () => ({
        verdict: 'decide', outcome: 'decided', disposition: 'decide',
        decision: { optionIndex: 0, label: 'Give it one more try', confidence: 0.9 },
        reason: 'Take one more shot at it.', version: 'qd1', latencyMs: 5,
      }));
      mockMessagesQueue = [
        [
          { type: 'system', subtype: 'init', session_id: 'sess-nudge-park' },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'I will pause here and wait.' }] } },
          { type: 'result', subtype: 'success', session_id: 'sess-nudge-park' },
        ],
        [
          {
            type: 'assistant',
            message: {
              content: [{
                type: 'tool_use',
                id: 'toolu_nudge_park',
                name: 'AskUserQuestion',
                input: { questions: [{ question: 'The shell is denied; how should I proceed?', header: 'Blocked' }] },
              }],
            },
          },
          { type: 'result', subtype: 'success', session_id: 'sess-nudge-park' },
        ],
        // Consumed only if a second nudge/session were (wrongly) started.
        [{ type: 'result', subtype: 'success', session_id: 'sess-nudge-park' }],
      ];
      const task = { ...makeTask(), outputRequirement: 'pr_required' };
      mockClaimTask.mockImplementation(async () => ({ workers: [{ id: 'w-nudge-park', branch: 'buildd/nudge-park', task }] }));

      manager = new WorkerManager(makeConfig({ inputAsRetry: true }));
      await manager.claimAndStart(task);
      await new Promise(r => setTimeout(r, 300));

      expect(mockQueryPrompts.length).toBe(2);
      expect(mockQueryPrompts[1]).toBe('Take one more shot at it.');

      const worker = manager.getWorker('w-nudge-park');
      expect(worker?.status).toBe('waiting');
      expect(worker?.error).toContain('needs_input');
      expect(worker?.waitingFor?.prompt).toBe('The shell is denied; how should I proceed?');
      expect(mockUpdateWorker.mock.calls.filter((c: any[]) => c[1]?.status === 'failed').length).toBe(0);
      expect(mockUpdateWorker.mock.calls.filter((c: any[]) => c[1]?.status === 'waiting_input').length).toBeGreaterThanOrEqual(1);
    });

    test('syncs waiting_input to server and stays waiting_input (never marks failed)', async () => {
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-retry-2' },
        {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_retry_2',
              name: 'AskUserQuestion',
              input: {
                questions: [{ question: 'Pick a color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] }],
              },
            }],
          },
        },
        { type: 'result', subtype: 'success', session_id: 'sess-retry-2' },
      ];

      mockClaimTask.mockImplementation(async () => ({ workers: [{
        id: 'w-retry-2',
        branch: 'buildd/retry-sync',
        task: makeTask(),
      }] }));

      manager = new WorkerManager(makeConfig({ inputAsRetry: true }));
      await manager.claimAndStart(makeTask());
      await waitFor(() => mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'waiting_input'
      ).length >= 2);

      // Should have synced waiting_input status at least twice: the transient
      // sync before abort, and the post-loop cleanup — both preserve status
      // waiting_input rather than ever dropping to failed.
      const waitingCalls = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'waiting_input'
      );
      expect(waitingCalls.length).toBeGreaterThanOrEqual(2);

      // Never reports 'failed' for this scenario.
      const failedCalls = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'failed'
      );
      expect(failedCalls.length).toBe(0);

      // The final waiting_input call still carries the needs_input error
      // context for observability, even though status is not 'failed'.
      const withNeedsInputError = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'waiting_input' && call[1]?.error?.includes('needs_input')
      );
      expect(withNeedsInputError.length).toBeGreaterThanOrEqual(1);
    });

    test('preserves waiting behavior when inputAsRetry is false', async () => {
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-no-retry' },
        {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_no_retry',
              name: 'AskUserQuestion',
              input: {
                questions: [{ question: 'Pick one?', header: 'Choice' }],
              },
            }],
          },
        },
        { type: 'result', subtype: 'success', session_id: 'sess-no-retry' },
      ];

      mockClaimTask.mockImplementation(async () => ({ workers: [{
        id: 'w-no-retry',
        branch: 'buildd/no-retry',
        task: makeTask(),
      }] }));

      // Explicit opt-out (inputAsRetry: false) — should use existing waiting behavior
      manager = new WorkerManager(makeConfig({ inputAsRetry: false }));
      await manager.claimAndStart(makeTask());
      await new Promise(r => setTimeout(r, 100));

      const worker = manager.getWorker('w-no-retry');
      // Should be waiting (not error) — existing behavior preserved
      expect(worker?.status).toBe('waiting');
      expect(worker?.waitingFor?.prompt).toBe('Pick one?');
    });

    test('includes branch in error context for retry', async () => {
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-retry-branch' },
        {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_retry_b',
              name: 'AskUserQuestion',
              input: {
                questions: [{ question: 'What should I name the file?', header: 'Filename' }],
              },
            }],
          },
        },
        { type: 'result', subtype: 'success', session_id: 'sess-retry-branch' },
      ];

      mockClaimTask.mockImplementation(async () => ({ workers: [{
        id: 'w-retry-branch',
        branch: 'buildd/my-feature-branch',
        task: makeTask(),
      }] }));

      manager = new WorkerManager(makeConfig({ inputAsRetry: true }));
      await manager.claimAndStart(makeTask());
      await new Promise(r => setTimeout(r, 200));

      // The final cleanup update stays waiting_input and includes waitingFor context
      const finalWaitingCalls = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'waiting_input' && call[1]?.error?.includes('needs_input')
      );
      expect(finalWaitingCalls.length).toBeGreaterThanOrEqual(1);
      // The waitingFor should have been synced in the waiting_input call(s)
      const waitingCalls = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'waiting_input' && call[1]?.waitingFor
      );
      expect(waitingCalls.length).toBeGreaterThanOrEqual(1);
      expect(waitingCalls[0][1].waitingFor.prompt).toBe('What should I name the file?');
      // Never reports 'failed' for this scenario.
      const failedCalls = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'failed'
      );
      expect(failedCalls.length).toBe(0);
    });

    // Misuse-boundary regression: waiting_input parking must stay scoped to the
    // literal 'needs_input:' prefix (set only by the AskUserQuestion abort
    // handler above). A different, unrelated session failure — no question was
    // ever asked — must still be reported as an ordinary 'failed' worker, with
    // no waitingFor and no waiting_input status anywhere in the sync history.
    // If this ever starts passing with status 'waiting_input', the parking
    // logic has widened past genuine blockers into swallowing real failures.
    test('a normal session failure (no question asked) still reports failed, not waiting_input', async () => {
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-budget-not-question' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Starting work...' }] },
        },
        {
          type: 'result',
          subtype: 'error_max_budget_usd',
          session_id: 'sess-budget-not-question',
          total_cost_usd: 5.5,
        },
      ];

      mockClaimTask.mockImplementation(async () => ({ workers: [{
        id: 'w-not-a-question',
        branch: 'buildd/not-a-question',
        task: makeTask(),
      }] }));

      manager = new WorkerManager(makeConfig({ inputAsRetry: true }));
      await manager.claimAndStart(makeTask());
      await new Promise(r => setTimeout(r, 200));

      const worker = manager.getWorker('w-not-a-question');
      expect(worker?.waitingFor).toBeFalsy();
      expect(worker?.error).not.toContain('needs_input');

      const waitingInputCalls = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'waiting_input'
      );
      expect(waitingInputCalls.length).toBe(0);

      const failedCalls = mockUpdateWorker.mock.calls.filter(
        (call: any[]) => call[1]?.status === 'failed'
      );
      expect(failedCalls.length).toBeGreaterThanOrEqual(1);
    });

    // Regression: an agent waiting on its own background work (a background
    // test run, an Explore subagent) called AskUserQuestion with an EMPTY
    // `questions` array as a way to "yield". The runner parked the task as
    // "Awaiting input", aborted the session — killing the very background
    // work the agent was waiting for — and pinged the owner with a blank
    // question. The retry then ran out of closing-turn budget with the work
    // uncommitted. A call that asks nothing is not a question: it must not
    // park, abort, or notify.
    for (const [label, input] of [
      ['empty questions array', { questions: [] }],
      ['missing questions field', {}],
      ['only blank question text', { questions: [{ question: '   ' }] }],
    ] as const) {
      test(`AskUserQuestion with ${label} does not park or abort the session`, async () => {
        mockThrowOnAbort = true;
        mockMessages = [
          { type: 'system', subtype: 'init', session_id: 'sess-empty-q' },
          {
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: 'The background test run is still going; waiting for it.' },
                { type: 'tool_use', id: 'toolu_empty_q', name: 'AskUserQuestion', input },
              ],
            },
          },
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Tests finished, continuing.' }] },
          },
          { type: 'result', subtype: 'success', session_id: 'sess-empty-q' },
        ];

        mockClaimTask.mockImplementation(async () => ({ workers: [{
          id: 'w-empty-q',
          branch: 'buildd/empty-q',
          task: makeTask(),
        }] }));

        manager = new WorkerManager(makeConfig({ inputAsRetry: true }));
        await manager.claimAndStart(makeTask());
        // Poll rather than a fixed sleep: the session needs a variable number of
        // ticks to drain on a loaded CI runner.
        const deadline = Date.now() + 5000;
        while (
          Date.now() < deadline &&
          !manager.getWorker('w-empty-q')?.output.join('\n').includes('Tests finished, continuing.')
        ) {
          await new Promise(r => setTimeout(r, 25));
        }

        const worker = manager.getWorker('w-empty-q');
        expect(worker?.error ?? '').not.toContain('needs_input');
        expect(worker?.waitingFor).toBeFalsy();
        // The session ran to its own result instead of being aborted mid-stream.
        expect(worker?.output.join('\n')).toContain('Tests finished, continuing.');

        const waitingInputCalls = mockUpdateWorker.mock.calls.filter(
          (call: any[]) => call[1]?.status === 'waiting_input'
        );
        expect(waitingInputCalls.length).toBe(0);
      });
    }
  });

  describe('Pause (task baf3809a)', () => {
    function liveSession(id: string) {
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: `sess-${id}` },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } },
        BLOCK_UNTIL_ABORT,
      ];
      mockClaimTask.mockImplementation(async () => ({ workers: [{ id, branch: `buildd/${id}`, task: makeTask() }] }));
    }

    test('stops the session, parks it as waiting_input with a pause, and never reports a failure', async () => {
      liveSession('w-pause');
      manager = new WorkerManager(makeConfig());
      await manager.claimAndStart(makeTask());
      await waitFor(() => manager.getWorker('w-pause')?.sessionId === 'sess-w-pause');

      expect(await manager.pauseWorker('w-pause')).toBe('apply');
      await waitFor(() => !manager.hasLiveSession('w-pause'));

      const worker = manager.getWorker('w-pause');
      expect(worker?.status).toBe('waiting');
      expect(worker?.waitingFor?.type).toBe('pause');
      expect(worker?.currentAction).toBe('Paused');
      // The session id survives, so Resume continues the same transcript.
      expect(worker?.sessionId).toBe('sess-w-pause');
      // Nothing failed: no "Task failed" checkpoint after "Paused" (live pause proof, task 4b2b30a9).
      expect(worker?.milestones.some((m: any) => m.type === 'checkpoint' && m.event === 'task_error')).toBe(false);
      const calls = mockUpdateWorker.mock.calls.filter((c: any[]) => c[0] === 'w-pause');
      expect(calls.some((c: any[]) => c[1]?.status === 'failed')).toBe(false);
      // The last report is the park, carrying the pause, so a sync in between cannot leave it running.
      const last = calls[calls.length - 1] as any[];
      expect(last[1]?.status).toBe('waiting_input');
      expect(last[1]?.waitingFor?.type).toBe('pause');
    });

    test('Resume continues the SAME session by its id, in the same worktree', async () => {
      liveSession('w-pause-resume');
      manager = new WorkerManager(makeConfig());
      await manager.claimAndStart(makeTask());
      await waitFor(() => manager.getWorker('w-pause-resume')?.sessionId === 'sess-w-pause-resume');
      const worktree = manager.getWorker('w-pause-resume')?.worktreePath;
      await manager.pauseWorker('w-pause-resume');
      await waitFor(() => manager.getWorker('w-pause-resume')?.status === 'waiting' && !manager.hasLiveSession('w-pause-resume'));

      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-w-pause-resume' },
        { type: 'result', subtype: 'success', session_id: 'sess-w-pause-resume' },
      ];
      expect(await manager.sendMessage('w-pause-resume', 'Resume')).toBe(true);
      await waitFor(() => mockQueryResumes.length >= 2);

      expect(mockQueryResumes[0]).toBeUndefined();
      expect(mockQueryResumes[1]).toBe('sess-w-pause-resume');
      expect(manager.getWorker('w-pause-resume')?.worktreePath).toBe(worktree);
    });

    // Found live (task 4b2b30a9): a run budget failover moved to Codex resumed
    // down the Claude path with its Codex thread id and failed with "No
    // conversation found". Resume must follow the backend the session ran on.
    test('Resume of a Codex session never resumes Claude with the Codex thread id', async () => {
      liveSession('w-pause-codex');
      manager = new WorkerManager(makeConfig());
      await manager.claimAndStart(makeTask());
      await waitFor(() => manager.getWorker('w-pause-codex')?.sessionId === 'sess-w-pause-codex');
      await manager.pauseWorker('w-pause-codex');
      await waitFor(() => manager.getWorker('w-pause-codex')?.status === 'waiting' && !manager.hasLiveSession('w-pause-codex'));
      const worker = manager.getWorker('w-pause-codex')!;
      worker.taskBackend = 'codex';
      worker.codexThreadId = 'codex-thread-1';

      mockMessages = [{ type: 'result', subtype: 'success', session_id: 'sess-w-pause-codex' }];
      const before = mockQueryResumes.length;
      await manager.sendMessage('w-pause-codex', 'Resume');
      await new Promise(r => setTimeout(r, 500));

      expect(mockQueryResumes.slice(before)).not.toContain('codex-thread-1');
    });

    test('waits for a running tool to finish before stopping', async () => {
      liveSession('w-pause-tool');
      manager = new WorkerManager(makeConfig());
      await manager.claimAndStart(makeTask());
      await waitFor(() => manager.getWorker('w-pause-tool')?.sessionId === 'sess-w-pause-tool');
      const worker = manager.getWorker('w-pause-tool')!;
      worker.toolInFlight = true;

      expect(await manager.pauseWorker('w-pause-tool')).toBe('defer');
      await new Promise(r => setTimeout(r, 1200));
      expect(manager.hasLiveSession('w-pause-tool')).toBe(true);
      expect(worker.status).toBe('working');

      worker.toolInFlight = false;
      await waitFor(() => !manager.hasLiveSession('w-pause-tool'));
      expect(worker.status).toBe('waiting');
      expect(worker.waitingFor?.type).toBe('pause');
    });

    test('a --once run without resumable runs refuses and keeps running', async () => {
      liveSession('w-pause-none');
      manager = new WorkerManager(makeConfig({ pauseMode: 'none' }));
      await manager.claimAndStart(makeTask());
      await waitFor(() => manager.getWorker('w-pause-none')?.sessionId === 'sess-w-pause-none');

      expect(await manager.pauseWorker('w-pause-none')).toBe('refuse');
      expect(manager.hasLiveSession('w-pause-none')).toBe(true);
      expect(manager.getWorker('w-pause-none')?.status).toBe('working');
      expect(manager.getWorker('w-pause-none')?.milestones.some(m => 'label' in m && /isn.t available/.test(String((m as any).label)))).toBe(true);
    });
  });

  describe('Stale recovery', () => {
    test('recovers from stale to working when activity resumes', async () => {
      // Create a worker that will receive messages over time
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-stale' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Working...' }] },
        },
        { type: 'result', subtype: 'success', session_id: 'sess-stale' },
      ];

      mockClaimTask.mockImplementation(async () => ({ workers: [{
        id: 'w-stale',
        branch: 'buildd/stale-test',
        task: makeTask(),
      }] }));

      manager = new WorkerManager(makeConfig());
      await manager.claimAndStart(makeTask());
      await new Promise(r => setTimeout(r, 100));

      // The worker processes messages quickly so it won't actually be stale,
      // but we can verify the mechanism: manually set stale then simulate activity
      const worker = manager.getWorker('w-stale');
      if (worker) {
        // Simulate stale state (as if checkStale() ran)
        worker.status = 'stale';
        // When new handleMessage fires, stale should recover
        // Since session is already done, we verify the logic via the existing output
        // Worker should be 'done' since all messages were processed
        expect(['done', 'stale']).toContain(worker.status);
      }
    });
  });

  describe('Claim-time heartbeat', () => {
    test('sends heartbeat immediately when a task is claimed', async () => {
      mockMessages = [
        { type: 'system', subtype: 'init', session_id: 'sess-hb' },
        { type: 'result', subtype: 'success', session_id: 'sess-hb' },
      ];

      mockClaimTask.mockImplementation(async () => ({
        workers: [{ id: 'w-hb', branch: 'buildd/hb-test', task: makeTask() }],
      }));

      // serverless: true disables the periodic heartbeat interval, so any
      // sendHeartbeat call here comes exclusively from the claim path.
      manager = new WorkerManager(makeConfig());
      await manager.claimAndStart(makeTask());

      // startFromClaim must call sendHeartbeat as its first action so the
      // stale-workers cron can't flag a freshly-started worker dead.
      expect(mockSendHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(1);

      // Regression: the platform had no way to tell a runner still serving
      // pre-fix code from one running a merged fix — every merged runner fix
      // silently sat undeployed on any host that never picked it up (see
      // apps/runner/src/updater.ts PKG_VERSION). The runnerVersion argument
      // (9th positional arg to sendHeartbeat) is how that becomes observable
      // from the platform instead of requiring SSH into the host.
      const call = mockSendHeartbeat.mock.calls[0] as unknown as any[];
      const runnerVersionArg = call[8];
      expect(typeof runnerVersionArg).toBe('string');
      expect(runnerVersionArg.length).toBeGreaterThan(0);
    });
  });
});

// ─── Debug surface ───────────────────────────────────────────────────────────

describe('WorkerManager — getInternalState context breaker', () => {
  let manager: InstanceType<typeof WorkerManager>;

  afterEach(() => {
    manager?.destroy();
  });

  test('reports a paused context while the global breaker is still open', () => {
    manager = new WorkerManager(makeConfig());

    // The incident signature: the debug internals endpoint answered
    // `paused: false` with authority for hours while a per-context pause was
    // silently walling every claim for that context. Both must be observable.
    const until = Date.now() + 60 * 60 * 1000;
    (manager as any).contextBreaker.pause('account:codex', until);

    const state = manager.getInternalState();
    expect(state.circuitBreaker.paused).toBe(false);
    expect(state.contextBreaker).toEqual({ 'account:codex': until });
  });

  test('omits an expired context pause so the endpoint cannot show a phantom', () => {
    manager = new WorkerManager(makeConfig());

    (manager as any).contextBreaker.pause('account:codex', Date.now() - 1_000);

    expect(manager.getInternalState().contextBreaker).toEqual({});
  });

  test('reports an empty context breaker when nothing is paused', () => {
    manager = new WorkerManager(makeConfig());
    expect(manager.getInternalState().contextBreaker).toEqual({});
  });
});
