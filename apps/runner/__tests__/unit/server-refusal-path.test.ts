/**
 * A refused completion must be reported as a refusal, not as a crash.
 *
 * The completion PATCH (`status: 'completed'`) is the one runner call with no
 * `.catch` — both failure-path PATCHes have one. So when the server's outcome
 * gate refused it with a 400, the throw unwound into the session's outer catch
 * and took the "Unexpected error" arm: `workers.error` became the stringified
 * refusal body, the follow-up `failed` PATCH carried no signal the server could
 * classify on, and the task was charged a retry for a decision the server made.
 *
 * Two properties are asserted here, and both were broken:
 *
 *  1. The terminal report carries `serverRefused` + the refusal's gate slug,
 *     and `error` is the server's own prose (which is what clusters with the
 *     gate_events row) rather than `API error: 400 - {json}`.
 *  2. The refusal check runs BEFORE the abort heuristic. That heuristic is a
 *     substring match on the error message, and a refusal's message is now the
 *     server's prose — so a refusal body containing the word "aborted" would
 *     otherwise be handled as a clean session abort.
 *
 * The session's measurement half is NOT asserted here, because the runner no
 * longer re-sends it: the route salvages the refused completion's cost/token/
 * turn payload at the refusal site (`persistRejectedCompletionPayload` →
 * `applyMetricsOnlyPatch`), so the assertion that belongs to that fix lives in
 * the route's own test file.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/server-refusal-path.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ServerRefusalError } from '../../src/server-refusal';
import type { LocalUIConfig } from '../../src/types';

// ─── Mocks (same shape as terminal-metrics-patch.test.ts) ────────────────────

let mockMessages: any[] = [];

mock.module('pusher-js', () => ({
  default: class {
    connection = { bind: () => {} };
    subscribe() { return { bind: () => {}, unbind_all: () => {}, unbind: () => {} }; }
    unsubscribe() {}
    disconnect() {}
  },
}));

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (_opts: any) => {
    const msgs = [...mockMessages];
    let idx = 0;
    return {
      streamInput: () => {},
      supportedModels: async () => [],
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (idx < msgs.length) return { value: msgs[idx++], done: false };
            return { value: undefined, done: true };
          },
        };
      },
    };
  },
}));

/** Every (level, event, message) triple the session logged. */
const sessionLogCalls: Array<{ level: string; event: string; message: string }> = [];
mock.module('../../src/session-logger', () => ({
  sessionLog: (_id: string, level: string, event: string, message: string) => {
    sessionLogCalls.push({ level, event, message });
  },
  readSessionLogs: () => [],
  claimLog: () => {},
  cleanupOldLogs: () => {},
}));

const updateCalls: Array<{ id: string; payload: any }> = [];
const mockUpdateWorker = mock(async (id: string, payload: any) => {
  updateCalls.push({ id, payload });
  return {};
});
const mockClaimTask = mock(async () => ({ workers: [] as any[] }));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mockUpdateWorker;
    requestSessionUploadUrl = async () => null;
    claimTask = mockClaimTask;
    getWorkspaceConfig = async () => ({ configStatus: 'unconfigured' });
    getCompactObservations = async () => ({ markdown: '', count: 0 });
    searchObservations = async () => [];
    getBatchObservations = async () => [];
    createObservation = async () => ({});
    listWorkspaces = async () => [];
    sendHeartbeat = async () => ({});
    runCleanup = async () => ({});
    searchFeedbackMemories = async () => [];
    getWorkerRemote = async () => null;
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

mock.module('../../src/skills.js', () => ({ syncSkillToLocal: async () => {} }));

mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ tools: [], envKeys: [], mcp: [] }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  parseMcpJson: () => [],
  scanMcpServersRich: () => [],
  checkBwrapSupport: () => true,
  checkBwrapMountIsolationSupport: () => true,
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
  } as LocalUIConfig;
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

async function runSession(manager: InstanceType<typeof WorkerManager>, workerId: string) {
  const task = makeTask();
  mockClaimTask.mockImplementation(async () => ({ workers: [{ id: workerId, branch: 'buildd/test', task }] }));
  await manager.claimAndStart(task);
  await new Promise(r => setTimeout(r, 300));
}

/** An assistant turn plus a result, so there is real measurement to lose. */
function busySession() {
  return [
    { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-4-6' },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'echo hi' } }] },
    },
    {
      type: 'result',
      subtype: 'success',
      session_id: 'sess-1',
      num_turns: 7,
      total_cost_usd: 0.42,
      usage: { byModel: { 'claude-sonnet-4-6': { inputTokens: 900, outputTokens: 120 } } },
    },
  ];
}

/** The gate's real 400, including the slug the route now echoes. */
function gateRefusal(message = 'This task requires a pull request before completing. Use create_pr to open one.') {
  return ServerRefusalError.from({
    status: 400,
    raw: JSON.stringify({ error: message, hint: 'create_pr', gate: 'output_requirement' }),
    method: 'PATCH',
    endpoint: '/api/workers/w-1',
  });
}

/** Refuse the completion PATCH; answer everything else normally. */
function refuseCompletionWith(err: unknown) {
  mockUpdateWorker.mockImplementation(async (id: string, payload: any) => {
    updateCalls.push({ id, payload });
    if (payload?.status === 'completed') throw err;
    return {};
  });
}

const terminalCall = () => updateCalls.find(c => c.payload?.status === 'failed');

function resetAll() {
  updateCalls.length = 0;
  sessionLogCalls.length = 0;
  mockMessages = [];
  mockUpdateWorker.mockClear();
  mockUpdateWorker.mockImplementation(async (id: string, payload: any) => {
    updateCalls.push({ id, payload });
    return {};
  });
  mockClaimTask.mockReset();
  mockClaimTask.mockImplementation(async () => ({ workers: [] }));
}

// ─────────────────────────────────────────────────────────────────────────────

describe('a refused completion is reported as a refusal', () => {
  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(resetAll);
  afterEach(() => { manager?.destroy(); });

  test('the terminal PATCH carries serverRefused and the gate slug', async () => {
    mockMessages = busySession();
    refuseCompletionWith(gateRefusal());

    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-refusal-1');

    const terminal = terminalCall();
    expect(terminal).toBeDefined();
    expect(terminal!.payload.serverRefused).toBe(true);
    expect(terminal!.payload.refusal).toMatchObject({
      status: 400,
      method: 'PATCH',
      gate: 'output_requirement',
      hint: 'create_pr',
    });
  });

  test('the persisted error is the server\'s own message, not the stringified body', async () => {
    mockMessages = busySession();
    refuseCompletionWith(gateRefusal());

    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-refusal-2');

    const terminal = terminalCall()!;
    // The text the gate ledger already normalized as its `reason`. Sharing it
    // is what puts the worker row in the same signature cluster instead of
    // minting a `{"error":…,"hint":…}` blob that clusters with nothing.
    expect(terminal.payload.error).toBe('This task requires a pull request before completing. Use create_pr to open one.');
    expect(terminal.payload.error).not.toMatch(/^API error: \d/);
  });

  test('it logs server_refusal, not session_error', async () => {
    mockMessages = busySession();
    refuseCompletionWith(gateRefusal());

    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-refusal-3');

    // A distinct event name so a /tmp/buildd.log grep separates the two
    // families — a refusal and a crash are not the same thing to triage.
    expect(sessionLogCalls.some(c => c.event === 'server_refusal')).toBe(true);
    expect(sessionLogCalls.some(c => c.event === 'session_error')).toBe(false);
  });

  // Ordering guard. `isAbortError` is `message.includes('aborted')`, and the
  // refusal's message is now the server's prose — so without the refusal check
  // running first, this body would be handled as a clean abort and the report
  // would carry no refusal signal at all.
  test('a refusal whose wording contains "aborted" is still reported as a refusal', async () => {
    mockMessages = busySession();
    refuseCompletionWith(gateRefusal('Completion aborted: this task requires a pull request.'));

    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-refusal-4');

    const terminal = terminalCall();
    expect(terminal).toBeDefined();
    expect(terminal!.payload.serverRefused).toBe(true);
    expect(sessionLogCalls.some(c => c.event === 'session_abort')).toBe(false);
  });

  test('a non-gate refusal reports no gate slug, so the server can exempt it', async () => {
    mockMessages = busySession();
    refuseCompletionWith(ServerRefusalError.from({
      status: 401,
      raw: JSON.stringify({ error: 'Runner credential rejected' }),
      method: 'PATCH',
      endpoint: '/api/workers/w-1',
    }));

    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-refusal-5');

    const terminal = terminalCall()!;
    expect(terminal.payload.serverRefused).toBe(true);
    expect(terminal.payload.refusal.status).toBe(401);
    expect(terminal.payload.refusal.gate).toBeUndefined();
    expect(terminal.payload.error).toBe('Runner credential rejected');
  });

  // Unchanged-behaviour guard: an ordinary crash must keep taking the
  // "Unexpected error" arm exactly as before.
  test('an ordinary crash is still reported as a crash', async () => {
    mockMessages = busySession();
    refuseCompletionWith(new Error('Unhandled exception: segfault in main'));

    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-crash-1');

    const terminal = terminalCall()!;
    expect(terminal.payload.serverRefused).toBeUndefined();
    expect(terminal.payload.refusal).toBeUndefined();
    expect(terminal.payload.error).toBe('Unhandled exception: segfault in main');
    expect(sessionLogCalls.some(c => c.event === 'session_error')).toBe(true);
    expect(sessionLogCalls.some(c => c.event === 'server_refusal')).toBe(false);
  });
});
