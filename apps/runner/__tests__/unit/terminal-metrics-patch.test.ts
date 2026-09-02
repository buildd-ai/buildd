/**
 * Terminal metrics must survive the completion path.
 *
 * Two independent defects, both silently dropping everything the terminal
 * PATCH carries (resultMeta with the CBM metrics + tool histogram, token
 * counts, cost/model attribution, git stats, subagent spans):
 *
 *  1. When the agent completes the task itself through the buildd MCP
 *     (`complete_task`, the documented worker workflow), the server marks the
 *     worker terminal and pushes worker:completed. The runner's own completion
 *     PATCH then hits an already-terminal row and gets 409 {abort:true} — so
 *     the only carrier of the session metrics is thrown away. Locally the
 *     worker still looks completed, which is why this never surfaced as an
 *     error: the DB row simply has result_meta NULL, cost 0 and 0 tokens.
 *     Fix: re-send the measurement half of the payload as a metrics-only
 *     PATCH, which the server accepts on a terminal worker.
 *
 *  2. `const resultMeta = worker.resultMeta || undefined` was captured BEFORE
 *     the CBM / tool-histogram blocks that create `worker.resultMeta` when the
 *     SDK never emitted a result message. The PATCH spread the stale const, so
 *     on exactly the path whose comment says the metrics "travel with the
 *     completion payload" they were built and then never sent.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/terminal-metrics-patch.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { LocalUIConfig } from '../../src/types';

// ─── Mocks (same shape as session-model-cost.test.ts) ────────────────────────

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

mock.module('../../src/session-logger', () => ({
  sessionLog: () => {},
  readSessionLogs: () => [],
  claimLog: () => {},
  cleanupOldLogs: () => {},
}));

/** Every (workerId, payload) pair the runner PATCHed. */
const updateCalls: Array<{ id: string; payload: any }> = [];
/** Response the fake server returns for a given call, by index. */
let updateResponses: any[] = [];
const mockUpdateWorker = mock(async (id: string, payload: any) => {
  updateCalls.push({ id, payload });
  const canned = updateResponses[updateCalls.length - 1];
  return canned ?? {};
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

const { WorkerManager, metricsOnlyPayload } = await import('../../src/workers');

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

async function runSession(
  manager: InstanceType<typeof WorkerManager>,
  workerId: string,
) {
  const task = makeTask();
  mockClaimTask.mockImplementation(async () => ({ workers: [{ id: workerId, branch: 'buildd/test', task }] }));
  await manager.claimAndStart(task);
  await new Promise(r => setTimeout(r, 300));
}

/** An assistant turn that calls one CBM tool and one ordinary tool. */
function toolTurn() {
  return {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'tu-1', name: 'mcp__codebase-memory__search_graph', input: { q: 'x' } },
        { type: 'tool_use', id: 'tu-2', name: 'Bash', input: { command: 'echo hi' } },
      ],
    },
  };
}

function successResult() {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 'sess-1',
    num_turns: 4,
    total_cost_usd: 0.5,
    usage: { byModel: { 'claude-sonnet-4-6': { inputTokens: 100, outputTokens: 50 } } },
  };
}

function completionCall() {
  return updateCalls.find(c => c.payload?.status === 'completed');
}

function metricsCall() {
  return updateCalls.find(c => c.payload?.metricsOnly === true);
}

function resetAll() {
  updateCalls.length = 0;
  updateResponses = [];
  mockMessages = [];
  mockUpdateWorker.mockClear();
  mockClaimTask.mockReset();
  mockClaimTask.mockImplementation(async () => ({ workers: [] }));
}

// ─── Defect 2: the stale const ───────────────────────────────────────────────

describe('completion payload carries the metrics built at completion time', () => {
  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(resetAll);
  afterEach(() => { manager?.destroy(); });

  // The regression: no SDK `result` message means the result handler never set
  // worker.resultMeta, so the cbm/toolCounts blocks take their `else` branch
  // and BUILD worker.resultMeta at completion. A const captured before them is
  // still undefined, and the spread `...(resultMeta && { resultMeta })` sends
  // nothing at all.
  test('sends cbm + toolCounts when resultMeta started out undefined', async () => {
    mockMessages = [
      { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-4-6' },
      toolTurn(),
      // …and no result message.
    ];
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-meta-1');

    const call = completionCall();
    expect(call).toBeDefined();
    const meta = call!.payload.resultMeta as any;
    expect(meta).toBeDefined();
    expect(meta.toolCounts.Bash).toBe(1);
    expect(meta.cbm).toBeDefined();
    expect(meta.cbm.totalCbmCalls).toBe(1);
    expect(meta.cbm.toolCalls.search_graph).toBe(1);
  });

  // Guard the healthy path too: when the SDK did report a result, the same
  // metrics must ride along on the object it created.
  test('still sends cbm + toolCounts merged into the SDK resultMeta', async () => {
    mockMessages = [
      { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-4-6' },
      toolTurn(),
      successResult(),
    ];
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-meta-2');

    const call = completionCall();
    expect(call).toBeDefined();
    const meta = call!.payload.resultMeta as any;
    expect(meta.numTurns).toBe(4);
    expect(meta.toolCounts.Bash).toBe(1);
    expect(meta.cbm.totalCbmCalls).toBe(1);
  });
});

// ─── Defect 1: the server already terminalised the worker ────────────────────

describe('terminal metrics after a server-side completion', () => {
  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(resetAll);
  afterEach(() => { manager?.destroy(); });

  test('re-sends the metrics as a metrics-only PATCH when the status PATCH is aborted', async () => {
    mockMessages = [
      { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-4-6' },
      toolTurn(),
      successResult(),
    ];
    // The runner fires several PATCHes during startup; only the completion one
    // must be answered with the server's terminal 409 body. Answer every call
    // that carries status:'completed' via the implementation instead of an
    // index-keyed table.
    mockUpdateWorker.mockImplementation(async (id: string, payload: any) => {
      updateCalls.push({ id, payload });
      if (payload?.status === 'completed') {
        // Exactly what route.ts returns for a PATCH to an already-terminal
        // worker the agent completed itself.
        return {
          error: 'Worker already completed',
          abort: true,
          reason: 'completed',
          actualStatus: 'completed',
          hasDeliverables: true,
        };
      }
      return {};
    });

    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-abort-1');

    const metrics = metricsCall();
    expect(metrics).toBeDefined();
    const meta = metrics!.payload.resultMeta as any;
    expect(meta).toBeDefined();
    expect(meta.numTurns).toBe(4);
    expect(meta.cbm.totalCbmCalls).toBe(1);
    expect(meta.toolCounts.Bash).toBe(1);
    // Cost + model attribution rides along — these were 0/NULL for the whole
    // self-completing cohort.
    expect(metrics!.payload.costUsd).toBeCloseTo(0.5, 6);
    expect(metrics!.payload.actualModel).toBe('claude-sonnet-4-6');
    // …and it must not try to write state again.
    expect(metrics!.payload.status).toBeUndefined();
    expect(metrics!.payload.error).toBeUndefined();
    expect(metrics!.payload.summary).toBeUndefined();
  });

  test('does not send a metrics-only PATCH when the completion PATCH succeeded', async () => {
    mockMessages = [
      { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-4-6' },
      toolTurn(),
      successResult(),
    ];
    mockUpdateWorker.mockImplementation(async (id: string, payload: any) => {
      updateCalls.push({ id, payload });
      return {};
    });

    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-abort-2');

    expect(completionCall()).toBeDefined();
    expect(metricsCall()).toBeUndefined();
  });
});

// ─── The payload filter itself ───────────────────────────────────────────────

describe('metricsOnlyPayload', () => {
  test('keeps measurement, drops everything that is a state change', () => {
    const out = metricsOnlyPayload({
      status: 'completed',
      error: 'boom',
      summary: 'did the thing',
      milestones: [{ type: 'status', label: 'x', ts: 1 }],
      verificationEvidence: { outcome: 'ok' },
      structuredOutput: { ok: true },
      reactivate: true,
      resultMeta: { numTurns: 3 },
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 1.5,
      actualModel: 'claude-sonnet-4-6',
      lastCommitSha: 'deadbee',
      commitCount: 2,
      filesChanged: 1,
      linesAdded: 3,
      linesRemoved: 4,
      subagentSpans: [{ taskId: 't' }],
      subagentSpansObserved: 1,
      backgroundAgentMs: 500,
    });

    expect(out.metricsOnly).toBe(true);
    expect(out.resultMeta).toEqual({ numTurns: 3 });
    expect(out.inputTokens).toBe(10);
    expect(out.outputTokens).toBe(20);
    expect(out.costUsd).toBe(1.5);
    expect(out.actualModel).toBe('claude-sonnet-4-6');
    expect(out.lastCommitSha).toBe('deadbee');
    expect(out.commitCount).toBe(2);
    expect(out.filesChanged).toBe(1);
    expect(out.linesAdded).toBe(3);
    expect(out.linesRemoved).toBe(4);
    expect(out.subagentSpansObserved).toBe(1);
    expect(out.backgroundAgentMs).toBe(500);

    expect(out.status).toBeUndefined();
    expect(out.error).toBeUndefined();
    expect(out.summary).toBeUndefined();
    expect(out.milestones).toBeUndefined();
    expect(out.verificationEvidence).toBeUndefined();
    expect(out.structuredOutput).toBeUndefined();
    expect(out.reactivate).toBeUndefined();
  });

  test('omits absent fields rather than sending undefined/zero', () => {
    const out = metricsOnlyPayload({ status: 'completed', subagentSpansObserved: 0 });
    expect(Object.keys(out)).toEqual(['metricsOnly']);
  });
});
