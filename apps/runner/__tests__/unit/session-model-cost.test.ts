/**
 * Per-task model selection + terminal cost/model reporting.
 *
 * Two dead mechanisms this guards:
 *   1. The claim route resolves a tier → model and writes it to
 *      `task.context.model`. The runner used to ignore it entirely and always
 *      ran `config.model`, so smart routing never changed which model ran.
 *   2. The terminal worker update carried no cost and no model attribution, so
 *      `workers.cost_usd` stayed '0' and `task_outcomes.actual_model` NULL.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/session-model-cost.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { LocalUIConfig } from '../../src/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

let mockMessages: any[] = [];
/** Every `options.model` the fake SDK was asked to run with. */
const capturedModels: Array<string | undefined> = [];

mock.module('pusher-js', () => ({
  default: class {
    connection = { bind: () => {} };
    subscribe() { return { bind: () => {}, unbind_all: () => {}, unbind: () => {} }; }
    unsubscribe() {}
    disconnect() {}
  },
}));

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: any) => {
    capturedModels.push(opts?.options?.model);
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

const mockUpdateWorker = mock(async (..._args: any[]) => ({}));
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
const { resolveSessionModel, resolveActualModel, honorTaskModelEnabled } = await import('../../src/prompt-builder');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RUNNER_MODEL = 'claude-sonnet-4-5-20250929';

function makeConfig(): LocalUIConfig {
  return {
    projectsRoot: '/tmp',
    builddServer: 'http://localhost:3000',
    apiKey: 'test-key',
    maxConcurrent: 2,
    model: RUNNER_MODEL,
    serverless: true,
  } as LocalUIConfig;
}

function makeTask(context?: Record<string, unknown>) {
  return {
    id: 'task-1',
    title: 'Test task',
    description: 'Do something',
    workspaceId: 'ws-1',
    workspace: { name: 'test-workspace' },
    status: 'waiting',
    priority: 1,
    ...(context ? { context } : {}),
  };
}

async function runSession(
  manager: InstanceType<typeof WorkerManager>,
  workerId: string,
  task: any,
) {
  mockClaimTask.mockImplementation(async () => ({ workers: [{ id: workerId, branch: 'buildd/test', task }] }));
  await manager.claimAndStart(task);
  await new Promise(r => setTimeout(r, 300));
}

/** Claude-API (API-key) shape: per-model attribution present. */
function apiResult() {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 'sess-1',
    num_turns: 3,
    total_cost_usd: 0.4242,
    usage: {
      byModel: {
        'claude-opus-4-8': {
          inputTokens: 1000, outputTokens: 500,
          cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
        },
      },
    },
  };
}

/** Seat/OAuth shape: no byModel map, top-level totals only, $0 cost. */
function oauthResult() {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 'sess-2',
    num_turns: 3,
    total_cost_usd: 0,
    usage: {
      input_tokens: 2000,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 1000,
      output_tokens: 3000,
    },
  };
}

function terminalPayload() {
  const call = mockUpdateWorker.mock.calls
    .filter((c: any[]) => c[1]?.status === 'completed')
    .pop();
  return call ? (call[1] as Record<string, unknown>) : undefined;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('resolveSessionModel (per-task model resolution)', () => {
  // The third argument is the gate. It defaults to BUILDD_HONOR_TASK_MODEL=1 and
  // is passed explicitly here so these cases describe the resolver, not the env.
  test('prefers the claim-route resolved model when honouring is enabled', () => {
    expect(resolveSessionModel({ model: 'claude-opus-4-8' }, RUNNER_MODEL, true)).toBe('claude-opus-4-8');
  });

  test('falls back to the runner-global model when the task carries none', () => {
    expect(resolveSessionModel({}, RUNNER_MODEL, true)).toBe(RUNNER_MODEL);
    expect(resolveSessionModel(null, RUNNER_MODEL, true)).toBe(RUNNER_MODEL);
    expect(resolveSessionModel(undefined, RUNNER_MODEL, true)).toBe(RUNNER_MODEL);
  });

  test('ignores a blank or non-string task model', () => {
    expect(resolveSessionModel({ model: '   ' }, RUNNER_MODEL, true)).toBe(RUNNER_MODEL);
    expect(resolveSessionModel({ model: 42 }, RUNNER_MODEL, true)).toBe(RUNNER_MODEL);
  });

  // The gate is what keeps this PR inert: with it off the runner behaves exactly
  // as it did before, so `requestedModel`, the SDK call and the backend model all
  // still describe what actually ran.
  test('ignores the per-task model entirely while the gate is off', () => {
    expect(resolveSessionModel({ model: 'claude-opus-4-8' }, RUNNER_MODEL, false)).toBe(RUNNER_MODEL);
  });

  // Kill switch: unset means on, and only an explicit '0' turns it off, so a
  // runner with no config for this behaves as designed rather than as before.
  test('honours the per-task model unless explicitly switched off', () => {
    expect(honorTaskModelEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(honorTaskModelEnabled({ BUILDD_HONOR_TASK_MODEL: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(honorTaskModelEnabled({ BUILDD_HONOR_TASK_MODEL: '0' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('resolveActualModel (what the session really ran on)', () => {
  test('prefers SDK per-model attribution', () => {
    expect(resolveActualModel({
      modelUsage: { 'claude-haiku-4-5': { outputTokens: 10 } },
      reportedModel: 'claude-sonnet-4-6',
      requestedModel: 'claude-opus-4-8',
    })).toBe('claude-haiku-4-5');
  });

  test('picks the highest-output model when several were used (fallback mid-session)', () => {
    expect(resolveActualModel({
      modelUsage: {
        'claude-opus-4-8': { outputTokens: 10 },
        'claude-sonnet-4-6': { outputTokens: 900 },
      },
    })).toBe('claude-sonnet-4-6');
  });

  test('falls back to the init-reported model, then the requested model', () => {
    expect(resolveActualModel({ modelUsage: {}, reportedModel: 'claude-sonnet-4-6' })).toBe('claude-sonnet-4-6');
    expect(resolveActualModel({ modelUsage: {}, requestedModel: 'claude-opus-4-8' })).toBe('claude-opus-4-8');
    expect(resolveActualModel({})).toBeNull();
  });
});

describe('per-task model reaches the SDK', () => {
  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(() => {
    capturedModels.length = 0;
    mockMessages = [];
    mockUpdateWorker.mockReset();
    mockUpdateWorker.mockImplementation(async () => ({}));
    mockClaimTask.mockReset();
    mockClaimTask.mockImplementation(async () => ({ workers: [] }));
  });

  afterEach(() => {
    manager?.destroy();
  });

  // The mechanism this whole chain exists for: the model the claim route resolved
  // is the model the SDK is actually asked for.
  test('startSession runs the model the claim route resolved onto task.context', async () => {
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-model-1', makeTask({ model: 'claude-opus-4-8' }));

    expect(capturedModels.length).toBeGreaterThan(0);
    expect(capturedModels[0]).toBe('claude-opus-4-8');
  });

  test('startSession still uses the runner-global model when the task has none', async () => {
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-model-2', makeTask());

    expect(capturedModels.length).toBeGreaterThan(0);
    expect(capturedModels[0]).toBe(RUNNER_MODEL);
  });
});

describe('terminal cost + model reporting', () => {
  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(() => {
    capturedModels.length = 0;
    mockMessages = [];
    mockUpdateWorker.mockReset();
    mockUpdateWorker.mockImplementation(async () => ({}));
    mockClaimTask.mockReset();
    mockClaimTask.mockImplementation(async () => ({ workers: [] }));
  });

  afterEach(() => {
    manager?.destroy();
  });

  test('reports the SDK cost and the actual model on completion', async () => {
    mockMessages = [
      { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-4-8' },
      apiResult(),
    ];
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-cost-1', makeTask({ model: 'claude-opus-4-8' }));

    const payload = terminalPayload();
    expect(payload).toBeDefined();
    expect(payload!.costUsd).toBeCloseTo(0.4242, 6);
    expect(payload!.actualModel).toBe('claude-opus-4-8');
  });

  test('omits costUsd on a $0 (OAuth) session but still reports the model', async () => {
    mockMessages = [
      { type: 'system', subtype: 'init', session_id: 'sess-2', model: 'claude-sonnet-4-6' },
      oauthResult(),
    ];
    manager = new WorkerManager(makeConfig());
    await runSession(manager, 'w-cost-2', makeTask({ model: 'claude-sonnet-4-6' }));

    const payload = terminalPayload();
    expect(payload).toBeDefined();
    // No self-reported spend: the server must fall back to its own estimate
    // rather than being told the session was free.
    expect(payload!.costUsd).toBeUndefined();
    expect(payload!.actualModel).toBe('claude-sonnet-4-6');
    // The token breakdown the server needs to price a seat session.
    const meta = payload!.resultMeta as any;
    expect(meta.totalUsage.cacheReadInputTokens).toBe(50_000);
    expect(meta.totalUsage.cacheCreationInputTokens).toBe(1000);
    expect(meta.totalUsage.outputTokens).toBe(3000);
  });
});
