/**
 * A task cancelled server-side while its session is still running must end as
 * a cancellation, not a terminal error.
 *
 * The observed sequence: the platform cancelled the task, the abort push never
 * reached the session, the agent's own complete_task was refused by the MCP
 * write fence ("TASK CANCELLED"), and the SDK session still ended cleanly. The
 * runner then (1) spent a closing turn asking the agent to call complete_task
 * again — which the fence refuses again — and (2) sent its fallback completion
 * PATCH, which the output_requirement gate refused. The refusal was reported
 * as `server_refusal` and the worker ended locally as `error`.
 *
 * Asserted here:
 *  - no closing turn is spent on a task that is already cancelled;
 *  - when the server records the completion as `task_cancelled`, the worker
 *    ends `done` (not `error`) and says it was cancelled;
 *  - a refusal against a cancelled task is reported as a cancellation, not as
 *    a server refusal (covers a server that still gates it).
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/task-cancelled-under-session.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ServerRefusalError } from '../../src/server-refusal';
import type { LocalUIConfig } from '../../src/types';

// ─── Mocks (same seam as closing-turn.test.ts) ──────────────────────────────

type Script = any[];
let scriptQueue: Script[] = [];
let createBackendCalls: Array<{ backend: string; config: any }> = [];

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
        for (const msg of script) {
          await opts.onProgress?.(msg);
          if (msg.type === 'assistant') {
            const text = msg.message?.content?.find((b: any) => b.type === 'text')?.text;
            if (text) yield { type: 'progress', message: text };
          } else if (msg.type === 'result') {
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

/** The server's view: the worker row is still live, its task is cancelled. */
let remote: { status: string; task?: { status: string } } | null = null;
const mockGetWorkerRemote = mock(async () => remote);

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

function makeTask() {
  return {
    id: 'task-1',
    title: 'Fix CI on the PR',
    description: 'Make CI green',
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

/** The agent found the fix already landed, discarded its edits, and stopped. */
function discardedEditsSession() {
  return [
    { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-4-6' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'The fix already landed upstream; discarding local edits.' }] } },
    { type: 'result', subtype: 'success', session_id: 'sess-1', num_turns: 4, total_cost_usd: 0.1 },
  ];
}

const completionCall = () => updateCalls.find(c => c.payload?.status === 'completed');
const failedCall = () => updateCalls.find(c => c.payload?.status === 'failed');

function resetAll() {
  updateCalls.length = 0;
  sessionLogCalls.length = 0;
  scriptQueue = [];
  createBackendCalls = [];
  remote = { status: 'running', task: { status: 'cancelled' } };
  mockUpdateWorker.mockClear();
  mockUpdateWorker.mockImplementation(async (id: string, payload: any) => {
    updateCalls.push({ id, payload });
    return {};
  });
  mockClaimTask.mockReset();
  mockClaimTask.mockImplementation(async () => ({ workers: [] }));
  mockGetWorkerRemote.mockClear();
  mockGetWorkerRemote.mockImplementation(async () => remote);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('task cancelled while the session was running', () => {
  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(resetAll);
  afterEach(() => { manager?.destroy(); });

  test('no closing turn is spent on a cancelled task', async () => {
    scriptQueue = [discardedEditsSession(), discardedEditsSession()];
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-cancel-closing');

    // A closing turn would only ask the agent to call complete_task, which the
    // write fence refuses for a cancelled task.
    expect(createBackendCalls.length).toBe(1);
    expect(completionCall()?.payload.resultMeta?.closingTurnOutcome).toBe('skipped:task_cancelled');
  });

  test('a completion the server records as task_cancelled ends the worker done, marked cancelled', async () => {
    scriptQueue = [discardedEditsSession()];
    mockUpdateWorker.mockImplementation(async (id: string, payload: any) => {
      updateCalls.push({ id, payload });
      if (payload?.status === 'completed') return { id, status: 'failed', exitCause: 'task_cancelled' };
      return {};
    });
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-cancel-recorded');

    const worker = manager.getWorker('w-cancel-recorded');
    expect(worker?.status).toBe('done');
    expect(worker?.currentAction).toMatch(/cancelled/i);
    expect(worker?.milestones.some((m: any) => /cancelled/i.test(m.label ?? ''))).toBe(true);
    expect(sessionLogCalls.some(c => c.event === 'task_cancelled')).toBe(true);
  });

  test('an output_requirement refusal against a cancelled task is reported as a cancellation', async () => {
    scriptQueue = [discardedEditsSession()];
    mockUpdateWorker.mockImplementation(async (id: string, payload: any) => {
      updateCalls.push({ id, payload });
      if (payload?.status === 'completed') {
        throw ServerRefusalError.from({
          status: 400,
          raw: JSON.stringify({ error: 'Task has no confirmed outcome.', hint: 'create_pr', gate: 'output_requirement' }),
          method: 'PATCH',
          endpoint: `/api/workers/${id}`,
        });
      }
      return {};
    });
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-cancel-refused');

    const worker = manager.getWorker('w-cancel-refused');
    expect(worker?.status).toBe('done');
    expect(worker?.status).not.toBe('error');
    expect(sessionLogCalls.some(c => c.event === 'server_refusal')).toBe(false);
    expect(sessionLogCalls.some(c => c.event === 'task_cancelled')).toBe(true);

    // The terminal report is a plain cancellation the server classifies by the
    // task's own status — no refusal flags that would book it as output_unmet.
    const terminal = failedCall();
    expect(terminal).toBeDefined();
    expect(terminal!.payload.serverRefused).toBeUndefined();
    expect(terminal!.payload.refusal).toBeUndefined();
    expect(terminal!.payload.error).toMatch(/cancelled/i);
  });

  test('a refusal against a live task is still a server refusal', async () => {
    remote = { status: 'running', task: { status: 'in_progress' } };
    scriptQueue = [discardedEditsSession(), discardedEditsSession()];
    mockUpdateWorker.mockImplementation(async (id: string, payload: any) => {
      updateCalls.push({ id, payload });
      if (payload?.status === 'completed') {
        throw ServerRefusalError.from({
          status: 400,
          raw: JSON.stringify({ error: 'Task has no confirmed outcome.', hint: 'create_pr', gate: 'output_requirement' }),
          method: 'PATCH',
          endpoint: `/api/workers/${id}`,
        });
      }
      return {};
    });
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-live-refused');

    expect(sessionLogCalls.some(c => c.event === 'server_refusal')).toBe(true);
    expect(failedCall()?.payload.serverRefused).toBe(true);
  });
});
