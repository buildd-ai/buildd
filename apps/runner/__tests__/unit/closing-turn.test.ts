/**
 * Closing turn: a session that ends without calling `complete_task` gets one
 * resumed turn to author it before the runner falls back to
 * `summarySource: 'fallback'`.
 *
 * Drives the backend at the `createBackend` seam (mocking
 * `../../src/backends/index.js`) rather than the raw Claude SDK, so the same
 * script shape works for both the Claude and Codex resume-id paths without
 * spawning a real CLI. Each `createBackend` call consumes one entry off
 * `scriptQueue` — the original invocation gets the first entry, a closing
 * turn (a second, resumed `createBackend` call) gets the next.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/closing-turn.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { LocalUIConfig } from '../../src/types';

// ─── Mocks ─────────────────────────────────────────────────────────────────

type Script = any[];
let scriptQueue: Script[] = [];
let createBackendCalls: Array<{ backend: string; config: any }> = [];
let runStreamedCalls: any[] = [];

mock.module('pusher-js', () => ({
  default: class {
    connection = { bind: () => {} };
    subscribe() { return { bind: () => {}, unbind_all: () => {}, unbind: () => {} }; }
    unsubscribe() {}
    disconnect() {}
  },
}));

mock.module('../../src/backends/index.js', () => ({
  createBackend: (backend: string, config: any) => {
    createBackendCalls.push({ backend, config });
    const script = scriptQueue.shift() ?? [];
    return {
      async *runStreamed(opts: any) {
        runStreamedCalls.push(opts);
        for (const msg of script) {
          // A `{ __throw: '<message>' }` entry makes the backend itself throw
          // mid-stream (a crashed CLI / transport error), as opposed to the
          // SDK reporting an error result.
          if (msg.__throw) throw new Error(msg.__throw);
          await opts.onProgress?.(msg);
          if (msg.type === 'assistant') {
            const text = msg.message?.content?.find((b: any) => b.type === 'text')?.text;
            if (text) yield { type: 'progress', message: text };
          } else if (msg.type === 'result') {
            if (msg.is_error) {
              yield { type: 'error', error: msg.result || 'Claude Agent SDK returned an error result' };
              return;
            }
            yield { type: 'turn_complete' };
          }
        }
        yield { type: 'complete', summary: '' };
      },
    };
  },
  inferSandboxMode: () => 'workspace-write',
  ClaudeBackend: class {},
}));

mock.module('../../src/session-logger', () => ({
  sessionLog: () => {},
  readSessionLogs: () => [],
  claimLog: () => {},
  cleanupOldLogs: () => {},
}));

/** Every (workerId, payload) pair the runner PATCHed. */
const updateCalls: Array<{ id: string; payload: any }> = [];
const mockUpdateWorker = mock(async (id: string, payload: any) => {
  updateCalls.push({ id, payload });
  return {};
});
const mockClaimTask = mock(async () => ({ workers: [] as any[] }));

/**
 * Simulates the server's authoritative view of the worker. `null`/`working`
 * until told otherwise — flip to `{status:'completed'}` mid-test to simulate
 * the agent's own complete_task call winning the race (the 'authored' case),
 * since that call happens over a wholly separate HTTP path this mock never
 * sees directly.
 */
let remoteStatus: string | null = null;
const mockGetWorkerRemote = mock(async () => (remoteStatus ? { status: remoteStatus } : null));

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
    getWorkerRemote = mockGetWorkerRemote;
    writeBackCodexAuth = async () => ({});
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
  loadTerminalWorkersCached: () => [],
  __resetDiskWorkersCache: () => {},
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

function makeTask(overrides: Record<string, unknown> = {}) {
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

async function runSession(
  manager: InstanceType<typeof WorkerManager>,
  workerId: string,
  overrides: Record<string, unknown> = {},
) {
  const task = makeTask(overrides);
  mockClaimTask.mockImplementation(async () => ({ workers: [{ id: workerId, branch: 'buildd/test', task }] }));
  await manager.claimAndStart(task);
  await new Promise(r => setTimeout(r, 300));
}

function assistantText(text: string) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

function initMsg(sessionId = 'sess-1') {
  return { type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-sonnet-4-6' };
}

function successResult(sessionId = 'sess-1') {
  return { type: 'result', subtype: 'success', session_id: sessionId, num_turns: 2, total_cost_usd: 0.1 };
}

function completionCall() {
  return updateCalls.find(c => c.payload?.status === 'completed');
}

function failedCall() {
  return updateCalls.find(c => c.payload?.status === 'failed');
}

function resetAll() {
  updateCalls.length = 0;
  scriptQueue = [];
  createBackendCalls = [];
  runStreamedCalls = [];
  remoteStatus = null;
  mockUpdateWorker.mockClear();
  // mockClear() only clears call history — a test-local .mockImplementation()
  // override (the 'authored' and 'complete_task already called' tests both
  // set one) otherwise leaks into every later test.
  mockUpdateWorker.mockImplementation(async (id: string, payload: any) => {
    updateCalls.push({ id, payload });
    return {};
  });
  mockClaimTask.mockReset();
  mockClaimTask.mockImplementation(async () => ({ workers: [] }));
  mockGetWorkerRemote.mockClear();
  mockGetWorkerRemote.mockImplementation(async () => (remoteStatus ? { status: remoteStatus } : null));
}

describe('closing turn', () => {
  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(resetAll);
  afterEach(() => { manager?.destroy(); });

  test('natural end without complete_task resumes the same session id for a closing turn', async () => {
    scriptQueue = [
      [initMsg('sess-1'), assistantText('Opened the PR.'), successResult('sess-1')],
      [assistantText('Calling complete_task now.'), successResult('sess-1')],
    ];
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-natural-end');

    expect(createBackendCalls.length).toBe(2);
    // The closing turn resumes the SAME session id the original captured —
    // no second resume path, no fresh session.
    expect(createBackendCalls[1].config.options?.resume).toBe('sess-1');

    // Exactly one closing turn: no third invocation.
    expect(createBackendCalls.length).toBe(2);
  });

  test('closing turn declined falls back with a bounded tail and outcome declined', async () => {
    scriptQueue = [
      [initMsg('sess-1'), assistantText('Work finished; nothing more to say.'), successResult('sess-1')],
      [assistantText('Still not calling complete_task.'), successResult('sess-1')],
    ];
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-declined');

    const call = completionCall();
    expect(call).toBeDefined();
    expect(call!.payload.summarySource).toBe('fallback');
    // The tail includes the closing turn's own text too (newest last).
    expect(call!.payload.summary).toContain('Still not calling complete_task.');
    expect(call!.payload.resultMeta?.closingTurnOutcome).toBe('declined');
  });

  test('agent-authored completion during the closing turn is recorded as authored, not fallback', async () => {
    scriptQueue = [
      [initMsg('sess-1'), assistantText('Opened the PR.'), successResult('sess-1')],
      [assistantText('Calling complete_task now.'), successResult('sess-1')],
    ];
    manager = new WorkerManager(makeConfig());

    // The first terminal check (before attempting a closing turn) must see
    // "not yet terminal" or no closing turn would be attempted at all; the
    // second (the closing turn's own post-loop) simulates its complete_task
    // call having already landed server-side.
    let terminalChecks = 0;
    mockGetWorkerRemote.mockImplementation(async () => {
      terminalChecks++;
      return terminalChecks > 1 ? { status: 'completed' } : null;
    });
    // Once the server considers the worker terminal (the simulated
    // complete_task call), any runner-side completion PATCH must be
    // refused — exactly the real first-writer-wins gate (abort: true),
    // which is what makes persistTerminalMetrics send the metrics-only
    // re-send instead.
    mockUpdateWorker.mockImplementation(async (id: string, payload: any) => {
      updateCalls.push({ id, payload });
      if (payload?.status === 'completed' && terminalChecks > 1) {
        return { abort: true, actualStatus: 'completed' };
      }
      return {};
    });

    await runSession(manager, 'w-authored');

    expect(createBackendCalls.length).toBe(2);
    // The refused payload still carries a fallback-shaped summary locally —
    // it never wins. What's authoritative is the metrics-only re-send,
    // whose resultMeta.closingTurnOutcome is what a human/analytics query
    // actually reads.
    const metricsOnlyCall = updateCalls.find(c => c.payload?.metricsOnly === true);
    expect(metricsOnlyCall).toBeDefined();
    expect(metricsOnlyCall!.payload.resultMeta?.closingTurnOutcome).toBe('authored');
  });

  test('an aborted session never attempts a closing turn', async () => {
    scriptQueue = [
      [initMsg('sess-1'), { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'sess-1', result: 'Aborted by user' }],
    ];
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-aborted');

    // Only the original invocation — no resumed closing turn.
    expect(createBackendCalls.length).toBe(1);
    const call = failedCall();
    expect(call).toBeDefined();
    expect(call!.payload.resultMeta?.closingTurnOutcome).toMatch(/^skipped:/);
  });

  test('a session that ends on the turn cap gets exactly one closing turn past it', async () => {
    scriptQueue = [
      [initMsg('sess-1'), { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 'sess-1', result: 'Reached max turns' }],
      [assistantText('Calling complete_task now.'), successResult('sess-1')],
    ];
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-max-turns');

    expect(createBackendCalls.length).toBe(2);
    expect(createBackendCalls[1].config.options?.resume).toBe('sess-1');
    // Bounded to one small fixed budget past the cap, regardless of the
    // original's configured maxTurns — see CLOSING_TURN_MAX_TURNS.
    expect(runStreamedCalls[1]?.maxTurns).toBe(3);

    const call = completionCall();
    expect(call).toBeDefined();
    expect(call!.payload.resultMeta?.closingTurnOutcome).toBe('declined');
  });

  test('complete_task already called leaves no closing-turn trace at all', async () => {
    scriptQueue = [
      [initMsg('sess-1'), assistantText('Done — opened the PR and called complete_task.'), successResult('sess-1')],
    ];
    remoteStatus = 'completed';
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-already-done');

    // No closing turn — the race check short-circuits before it's ever attempted.
    expect(createBackendCalls.length).toBe(1);
    const call = completionCall();
    expect(call).toBeDefined();
    expect(call!.payload.resultMeta?.closingTurnOutcome).toBeUndefined();
  });

  test('Codex tasks resume by thread id, not sessionId', async () => {
    scriptQueue = [
      [initMsg('thread-1'), assistantText('Opened the PR.'), successResult('thread-1')],
      [assistantText('Calling complete_task now.'), successResult('thread-1')],
    ];
    manager = new WorkerManager(makeConfig());
    // Codex tasks hard-fail before ever reaching createBackend without a
    // credential — a local OPENAI_API_KEY satisfies the same local-auth
    // fallback the claim route itself accepts.
    const priorKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    try {
      await runSession(manager, 'w-codex', { backend: 'codex' });
    } finally {
      if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorKey;
    }

    expect(createBackendCalls.length).toBe(2);
    expect(createBackendCalls[0].backend).toBe('codex');
    // Codex resume rides RunStreamedOpts.resumeThreadId (per-call), not the
    // Claude-only queryOptions.resume baked into createBackend's config.
    expect(runStreamedCalls[1]?.resumeThreadId).toBe('thread-1');
  });

  // ─── A closing turn's own failure is never the task's failure ────────────
  //
  // The main session already ended fine; the closing turn is a bonus attempt
  // at an authored summary. Whatever goes wrong inside it, the worker must
  // land exactly where it would have without the feature: a completed PATCH
  // carrying the fallback summary.

  function maxTurnsResult(sessionId = 'sess-1') {
    return { type: 'result', subtype: 'error_max_turns', is_error: true, stop_reason: 'tool_use', session_id: sessionId, num_turns: 2 };
  }

  function completeTaskToolUse() {
    return {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'mcp__buildd__buildd', input: { action: 'complete_task', params: { summary: 'Done.' } } }] },
    };
  }

  test('closing turn that runs out of turns falls back instead of failing the task', async () => {
    scriptQueue = [
      [initMsg('sess-1'), assistantText('Reviewed the PR; looks good.'), successResult('sess-1')],
      [assistantText('Let me check one thing first.'), maxTurnsResult('sess-1')],
    ];
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-closing-max-turns');

    expect(createBackendCalls.length).toBe(2);
    expect(failedCall()).toBeUndefined();
    const call = completionCall();
    expect(call).toBeDefined();
    expect(call!.payload.summarySource).toBe('fallback');
    expect(call!.payload.summary).toContain('Reviewed the PR; looks good.');
    expect(call!.payload.resultMeta?.closingTurnOutcome).toBe('declined:max_turns');
    expect(manager.getWorker('w-closing-max-turns')?.status).toBe('done');
  });

  test('closing turn that calls complete_task and then hits max turns counts as authored', async () => {
    scriptQueue = [
      [initMsg('sess-1'), assistantText('Reviewed the PR; looks good.'), successResult('sess-1')],
      [completeTaskToolUse(), maxTurnsResult('sess-1')],
    ];
    manager = new WorkerManager(makeConfig());
    // First terminal check (the closing-turn decision) sees "not terminal";
    // every later one sees the closing turn's complete_task having landed.
    let terminalChecks = 0;
    mockGetWorkerRemote.mockImplementation(async () => {
      terminalChecks++;
      return terminalChecks > 1 ? { status: 'completed' } : null;
    });
    mockUpdateWorker.mockImplementation(async (id: string, payload: any) => {
      updateCalls.push({ id, payload });
      if (payload?.status === 'completed' && terminalChecks > 1) {
        return { abort: true, actualStatus: 'completed' };
      }
      return {};
    });

    await runSession(manager, 'w-closing-authored-max-turns');

    expect(failedCall()).toBeUndefined();
    const metricsOnlyCall = updateCalls.find(c => c.payload?.metricsOnly === true);
    expect(metricsOnlyCall).toBeDefined();
    expect(metricsOnlyCall!.payload.resultMeta?.closingTurnOutcome).toBe('authored');
  });

  test('closing turn that throws falls back instead of failing the task', async () => {
    scriptQueue = [
      [initMsg('sess-1'), assistantText('Reviewed the PR; looks good.'), successResult('sess-1')],
      [{ __throw: 'Claude Code process exited with code 1' }],
    ];
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-closing-throws');

    expect(createBackendCalls.length).toBe(2);
    expect(failedCall()).toBeUndefined();
    const call = completionCall();
    expect(call).toBeDefined();
    expect(call!.payload.summarySource).toBe('fallback');
    expect(call!.payload.resultMeta?.closingTurnOutcome).toBe('declined:error');
    expect(manager.getWorker('w-closing-throws')?.status).toBe('done');
  });

  test('turn-cap closing turn that itself runs out of turns falls back too', async () => {
    scriptQueue = [
      [initMsg('sess-1'), assistantText('Most of the work is done.'), { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 'sess-1', result: 'Reached max turns' }],
      [assistantText('Checking one more file.'), maxTurnsResult('sess-1')],
    ];
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-cap-then-closing-cap');

    expect(createBackendCalls.length).toBe(2);
    expect(failedCall()).toBeUndefined();
    const call = completionCall();
    expect(call).toBeDefined();
    expect(call!.payload.summarySource).toBe('fallback');
    expect(call!.payload.resultMeta?.closingTurnOutcome).toBe('declined:max_turns');
  });
  // ── Structured-output tasks (outputSchema, e.g. reviewer verdicts) ───────
  // Such a task authors its outcome through the SDK's structured output and
  // never calls complete_task. Resuming it for a closing turn prompted the
  // agent to call complete_task, which carries no structuredOutput — the
  // worker went terminal without the verdict, the runner's payload (which
  // had it) was refused, and the task failed its verdict check.

  const reviewSchema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };

  test('a session that produced structured output completes with it and never gets a closing turn', async () => {
    const verdict = { verdict: 'approve', summary: 'LGTM' };
    scriptQueue = [
      [initMsg('sess-1'), assistantText('Review done.'), { ...successResult('sess-1'), structured_output: verdict }],
      // Consumed only if a closing turn were (wrongly) attempted.
      [completeTaskToolUse(), successResult('sess-1')],
    ];
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-structured', { outputSchema: reviewSchema });

    expect(createBackendCalls.length).toBe(1);
    expect(failedCall()).toBeUndefined();
    const call = completionCall();
    expect(call).toBeDefined();
    expect(call!.payload.structuredOutput).toEqual(verdict);
    expect(call!.payload.resultMeta?.closingTurnOutcome).toBe('skipped:structured_output');
  });

  test('a closing turn that does run still completes with the main session structured output', async () => {
    const verdict = { verdict: 'request_changes' };
    scriptQueue = [
      [initMsg('sess-1'), assistantText('Review done.'), { ...maxTurnsResult('sess-1'), structured_output: verdict }],
      [assistantText('Not calling complete_task.'), successResult('sess-1')],
    ];
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-structured-carried', { outputSchema: reviewSchema });

    expect(createBackendCalls.length).toBe(2);
    expect(failedCall()).toBeUndefined();
    const call = completionCall();
    expect(call).toBeDefined();
    expect(call!.payload.structuredOutput).toEqual(verdict);
  });

  test('the closing turn sends only the closing instruction, not a rebuilt task prompt', async () => {
    scriptQueue = [
      [initMsg('sess-1'), assistantText('Opened the PR.'), successResult('sess-1')],
      [assistantText('Calling complete_task now.'), successResult('sess-1')],
    ];
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-closing-prompt', { description: 'UNIQUE-ORIGINAL-DESCRIPTION' });

    expect(runStreamedCalls.length).toBe(2);
    expect(String(runStreamedCalls[0].prompt)).toContain('UNIQUE-ORIGINAL-DESCRIPTION');
    const closingPrompt = runStreamedCalls[1].prompt;
    expect(typeof closingPrompt).toBe('string');
    expect(closingPrompt.startsWith('Your last session ended without calling `complete_task`.')).toBe(true);
    expect(closingPrompt).not.toContain('UNIQUE-ORIGINAL-DESCRIPTION');
    expect(closingPrompt).not.toContain('## ');
  });
});
