/**
 * A completion summary must be distinguishable by provenance.
 *
 * When the SDK query loop ends naturally without the agent ever calling the
 * buildd MCP `complete_task` tool, the runner's own end-of-session PATCH
 * fills `summary` from `worker.lastAssistantMessage` (the SDK's Stop-hook /
 * last text block) so the task isn't left with nothing. That text is
 * whatever the agent happened to say last — frequently a conversational
 * aside ("waiting for CI to finish") rather than an outcome — and was
 * previously indistinguishable from an agent-authored summary once it landed
 * in `tasks.result.summary`. This tags it `summarySource: 'fallback'` so
 * downstream consumers (KB ingestion, UI) never present it as authored.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/completion-summary-provenance.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { LocalUIConfig } from '../../src/types';

// ─── Mocks (same shape as session-model-cost.test.ts / terminal-metrics-patch.test.ts) ──

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

async function runSession(
  manager: InstanceType<typeof WorkerManager>,
  workerId: string,
) {
  const task = makeTask();
  mockClaimTask.mockImplementation(async () => ({ workers: [{ id: workerId, branch: 'buildd/test', task }] }));
  await manager.claimAndStart(task);
  await new Promise(r => setTimeout(r, 300));
}

/** An assistant turn with a single text block — no tool use, nothing that reads as complete_task. */
function assistantText(text: string) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  };
}

function successResult() {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 'sess-1',
    num_turns: 2,
    total_cost_usd: 0.1,
    usage: { byModel: { 'claude-sonnet-4-6': { inputTokens: 100, outputTokens: 50 } } },
  };
}

function completionCall() {
  return updateCalls.find(c => c.payload?.status === 'completed');
}

function resetAll() {
  updateCalls.length = 0;
  mockMessages = [];
  mockUpdateWorker.mockClear();
  mockClaimTask.mockReset();
  mockClaimTask.mockImplementation(async () => ({ workers: [] }));
}

describe('completion summary provenance', () => {
  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(resetAll);
  afterEach(() => { manager?.destroy(); });

  // The bug: the SDK loop ends with no complete_task call, and the agent's last
  // words were an aside about its own tooling, not a report of what it did.
  // That text still becomes `summary` (better than nothing), but must be tagged
  // so nothing downstream mistakes it for an authored outcome.
  test('tags a session-end summary derived from the last assistant message as fallback', async () => {
    mockMessages = [
      { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-4-6' },
      assistantText('That call wasn\'t needed — the Monitor task is already running and will notify me when CI finishes. Nothing more to do right now; waiting for that notification.'),
      successResult(),
    ];
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-fallback-1');

    const call = completionCall();
    expect(call).toBeDefined();
    expect(call!.payload.summary).toContain('Nothing more to do right now');
    expect(call!.payload.summarySource).toBe('fallback');
  });

  test('omits summary and summarySource when the agent never produced any assistant text', async () => {
    mockMessages = [
      { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-4-6' },
      successResult(),
    ];
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-fallback-2');

    const call = completionCall();
    expect(call).toBeDefined();
    expect(call!.payload.summary).toBeUndefined();
    expect(call!.payload.summarySource).toBeUndefined();
  });
});
