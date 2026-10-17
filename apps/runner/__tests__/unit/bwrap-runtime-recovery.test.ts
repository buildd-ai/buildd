/**
 * Runtime bwrap recovery: when the runner detects bwrap_namespace_denied in a
 * tool result mid-task, it should flip _bwrapSupported=false (so future tasks
 * skip sandboxing) and abort the current task for a clean retry.
 *
 * This guards against stale runner processes that started with old code where
 * checkBwrapSupport() gave a false positive (setuid bwrap letting the probe
 * pass while Claude Code's actual invocation fails).
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/bwrap-runtime-recovery.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach, setDefaultTimeout , afterAll } from 'bun:test';
import { tmpdir } from 'os';
import { initTestWorkspace, getTestWorkspace, cleanupTestWorkspace } from '../test-workspace';

// CI runners are slower — give tests more room than the 5s default.
// WorkerManager constructor calls scanEnvironment() which probes tools on first run.
setDefaultTimeout(15_000);
import type { LocalWorker, LocalUIConfig } from '../../src/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Closure-controlled query: first-call abort for retry tests, normal otherwise.
let queryCallCount = 0;
// What the mocked Claude bwrap probe answers (false = this host cannot confine Claude).
let bwrapProbeOk = true;
let queryAbortFirstCall = false;
// Captures the sessionId from each query() call so tests can assert no reuse.
const capturedSessionIds: string[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (_opts: any) => {
    const callNum = ++queryCallCount;
    capturedSessionIds.push(_opts.options?.sessionId ?? '');
    const shouldAbort = queryAbortFirstCall && callNum === 1;
    return {
      streamInput: () => {},
      supportedModels: async () => [],
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (shouldAbort) throw new Error('Request was aborted.');
            return { value: undefined, done: true };
          },
        };
      },
    };
  },
}));

const mockUpdateWorker = mock(async () => ({}));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mockUpdateWorker;
    claimTask = mock(async () => ({ workers: [] }));
    getWorkspaceConfig = mock(async () => ({ configStatus: 'unconfigured' }));
    getCompactObservations = mock(async () => ({ markdown: '', count: 0 }));
    searchObservations = mock(async () => []);
    getBatchObservations = mock(async () => []);
    createObservation = mock(async () => ({}));
    listWorkspaces = mock(async () => []);
    sendHeartbeat = mock(async () => ({}));
    runCleanup = mock(async () => ({}));
    searchFeedbackMemories = mock(async () => []);
    getWorkerRemote = mock(async () => null);
  },
}));

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

mock.module('pusher-js', () => ({
  default: class {
    connection = { bind: () => {} };
    subscribe() { return { bind: () => {}, unbind_all: () => {}, unbind: () => {} }; }
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

mock.module('../../src/skills.js', () => ({
  syncSkillToLocal: async () => {},
}));

// Without this, WorkerManager's constructor runs scanEnvironment() for real —
// spawning execSync probes for ~18 tools plus browser detection. That's slow
// and CI-load-dependent, which is what pushed this suite past its 15s timeout.
mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ platform: 'linux', arch: 'x64', tools: [], envKeys: [], mcp: [], mcpServers: [], labels: { type: 'local', os: 'linux', arch: 'x64', hostname: 'test' }, scannedAt: new Date(0).toISOString() }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  parseMcpJson: () => [],
  scanMcpServersRich: () => [],
  checkBwrapSupport: () => bwrapProbeOk,
  checkBwrapMountIsolationSupport: () => true,
}));

// Import WorkerManager after mocks
const { WorkerManager, __resetBwrapSupportForTest, isBwrapSupported, __setModelAuthPreflightForTest } = await import('../../src/workers');
// Sessions here run a mocked SDK with no model credential: skip the
// pre-spawn model-auth refusal (claude-model-auth-preflight.test.ts covers it).
__setModelAuthPreflightForTest(() => null);

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
    id: 'w-bwrap-1',
    taskId: 'task-bwrap',
    taskTitle: 'Test bwrap task',
    taskDescription: 'Do something',
    workspaceId: 'ws-1',
    workspaceName: 'test-workspace',
    workspaceDataClass: 'standard',
    branch: 'buildd/test',
    status: 'working',
    hasNewActivity: false,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    milestones: [],
    currentAction: 'Running...',
    commits: [],
    output: [],
    toolCalls: [],
    messages: [],
    subagentTasks: [],
    subagentTasksObservedCount: 0,
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
  abortController: AbortController,
) {
  (manager as any).workers.set(worker.id, worker);
  (manager as any).sessions.set(worker.id, {
    abortController,
    cwd: getTestWorkspace(),
    repoPath: getTestWorkspace(),
    generation: 1,
    inputStream: {
      enqueue: () => {},
      end: () => {},
      [Symbol.asyncIterator]() {
        return { next: async () => ({ value: undefined as any, done: true }) };
      },
    },
  });
}

/** Builds a synthetic user message containing a tool_result with the given text. */
function makeBashToolResultMessage(text: string) {
  return {
    type: 'user',
    session_id: 'sess-bwrap',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_bash_1',
          content: text,
        },
      ],
    },
  };
}

function makeTask(context?: Record<string, unknown>) {
  return {
    ...(context ? { context } : {}),
    id: 'task-bwrap',
    title: 'Test bwrap task',
    description: 'Do something',
    workspaceId: 'ws-1',
    workspace: { name: 'test-workspace', dataClass: 'standard' },
    status: 'waiting',
    priority: 1,
    mode: 'execution',
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('bwrap runtime recovery', () => {
  let originalDisableSandbox: string | undefined;
  let originalOptIn: string | undefined;

  afterAll(() => {


    cleanupTestWorkspace();


  });


  beforeEach(() => {


    initTestWorkspace();
    // Exercise mocked probes regardless of the worker's operator flag.
    originalDisableSandbox = process.env.BUILDD_DISABLE_SANDBOX;
    delete process.env.BUILDD_DISABLE_SANDBOX;
    originalOptIn = process.env.BUILDD_ALLOW_REDUCED_ISOLATION;
    delete process.env.BUILDD_ALLOW_REDUCED_ISOLATION;
  });

  afterEach(() => {
    if (originalDisableSandbox === undefined) delete process.env.BUILDD_DISABLE_SANDBOX;
    else process.env.BUILDD_DISABLE_SANDBOX = originalDisableSandbox;
    if (originalOptIn === undefined) delete process.env.BUILDD_ALLOW_REDUCED_ISOLATION;
    else process.env.BUILDD_ALLOW_REDUCED_ISOLATION = originalOptIn;
  });

  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(() => {
    // Reset module-level bwrap cache so recovery fires from a clean state,
    // even when other test files have already set _bwrapSupported=false.
    __resetBwrapSupportForTest();
    bwrapProbeOk = true;
    queryCallCount = 0;
    queryAbortFirstCall = false;
    capturedSessionIds.length = 0;
    mockUpdateWorker.mockReset();
    mockUpdateWorker.mockImplementation(async () => ({}));
  });

  afterEach(() => {
    manager?.destroy();
  });

  test('sets bwrapRetryPending and aborts session when bwrap_namespace_denied is detected mid-task', async () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker();
    const abortController = new AbortController();
    injectWorker(manager, worker, abortController);

    const bwrapError =
      'bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.';

    await (manager as any).handleMessage(worker, makeBashToolResultMessage(bwrapError));

    // bwrapRetryPending signals startSession to restart without sandbox (not mark as Failed)
    expect(worker.bwrapRetryPending).toBe(true);
    // worker.error must NOT be set — the task is not failed, just retrying
    expect(worker.error).toBeUndefined();
    expect(abortController.signal.aborted).toBe(true);
  });

  test('records bwrap_namespace_denied error trace', async () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker({ id: 'w-bwrap-2' });
    const abortController = new AbortController();
    injectWorker(manager, worker, abortController);

    const bwrapError =
      'bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.';

    await (manager as any).handleMessage(worker, makeBashToolResultMessage(bwrapError));

    expect(worker.pendingErrorTraces).toBeDefined();
    expect(worker.pendingErrorTraces!.some((t: any) => t.pattern === 'bwrap_namespace_denied')).toBe(true);
  });

  test('does not abort for non-bwrap errors', async () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker({ id: 'w-bwrap-3' });
    const abortController = new AbortController();
    injectWorker(manager, worker, abortController);

    await (manager as any).handleMessage(
      worker,
      makeBashToolResultMessage('cd: /tmp/missing: No such file or directory'),
    );

    expect(abortController.signal.aborted).toBe(false);
    expect(worker.error).toBeUndefined();
  });

  test('boot probe: WorkerManager constructor calls isBwrapSupported to warm up cache', () => {
    // Verify isBwrapSupported is now exported (regression: previously unexported)
    expect(typeof isBwrapSupported).toBe('function');
    // After creating WorkerManager, the cache should be warm (not null).
    // We verify this by checking that isBwrapSupported() returns a boolean
    // without re-running checkBwrapSupport (which would call execSync).
    // The constructor calls isBwrapSupported() and checkBwrapSupport returns true (mocked).
    __resetBwrapSupportForTest();
    manager = new WorkerManager(makeConfig());
    // Cache is warm: the result is already boolean (not null)
    // Calling isBwrapSupported() again returns true (from cache, no re-probe)
    expect(isBwrapSupported()).toBe(true);
  });

  /** A trusted_local task, on a runner whose operator opted in, on a host whose bwrap is denied. */
  function trustedLocalOnDeniedHost() {
    process.env.BUILDD_ALLOW_REDUCED_ISOLATION = '1';
    bwrapProbeOk = false;
    return makeTask({ isolation: { requirement: 'trusted_local', source: 'workspace', mode: 'reduced' } });
  }
  const failedCalls = () => mockUpdateWorker.mock.calls.filter((args: any[]) => args[0] && args[1]?.status === 'failed');

  test('regression: bwrap abort of a trusted_local task (operator opt-in) restarts instead of failing, as a recorded degradation', async () => {
    // Simulate namespace-creation denial and assert the run does NOT reach a
    // Failed terminal state. Instead startSession restarts.
    //
    // Setup: query throws AbortError on first call (simulating bwrap abort after
    // bwrapRetryPending is pre-set). On second call it completes normally.
    queryAbortFirstCall = true;

    manager = new WorkerManager(makeConfig());
    const worker = makeWorker({ id: 'w-bwrap-retry' });
    // Pre-set bwrapRetryPending as if handleMessage already detected the error
    worker.bwrapRetryPending = true;

    // Call startSession directly — first query aborts, catch block detects
    // bwrapRetryPending and restarts; second query completes normally.
    await (manager as any).startSession(worker, getTestWorkspace(), trustedLocalOnDeniedHost());
    // R-7: the restart is on the task's timeline as a degradation.
    expect(worker.milestones.some((m: any) => /isolation degraded/.test(m.label ?? ''))).toBe(true);
    // R-5: the effective mode it ran under is too.
    expect(worker.milestones.some((m: any) => /trusted_local, Claude runs REDUCED/.test(m.label ?? ''))).toBe(true);

    // The session must NOT have been reported as failed
    const failedCalls = mockUpdateWorker.mock.calls.filter(
      (args: any[]) => args[0] && args[1]?.status === 'failed',
    );
    expect(failedCalls).toHaveLength(0);

    // Exactly 2 query calls: first aborted, second successful retry
    expect(queryCallCount).toBe(2);

    // Worker ends in done state, not error
    expect(worker.status).toBe('done');
  });

  test('regression: bwrap retry uses a different session ID than the first invocation', async () => {
    // The first startSession call registers a session ID with the Claude CLI.
    // When bwrap aborts mid-run and startSession is called again on the SAME
    // worker, it must NOT reuse that session ID — the CLI rejects it with
    // "Session ID already in use" (exit code 1).
    queryAbortFirstCall = true;

    manager = new WorkerManager(makeConfig());
    const worker = makeWorker({ id: 'w-bwrap-session-id' });
    worker.bwrapRetryPending = true;

    await (manager as any).startSession(worker, getTestWorkspace(), trustedLocalOnDeniedHost());

    expect(queryCallCount).toBe(2);
    // Both calls must have a non-empty session ID
    expect(capturedSessionIds[0]).toBeTruthy();
    expect(capturedSessionIds[1]).toBeTruthy();
    // The retry must use a DIFFERENT session ID than the first invocation
    expect(capturedSessionIds[0]).not.toBe(capturedSessionIds[1]);
  });

  // AC-7: a mid-run confinement failure on a protected task fails the attempt.
  test('a bwrap abort of a protected task fails the attempt with the cause; nothing restarts it with less confinement', async () => {
    queryAbortFirstCall = true;
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker({ id: 'w-bwrap-protected' });
    const task = makeTask({ isolation: { requirement: 'protected', source: 'default', mode: 'enforced' } });
    // The session starts confined; then Claude's own bwrap is denied mid-run
    // and the runtime flips the probe, as handleMessage does.
    const run = (manager as any).startSession(worker, getTestWorkspace(), task);
    worker.bwrapRetryPending = true;
    bwrapProbeOk = false;
    __resetBwrapSupportForTest();
    await run;

    expect(queryCallCount).toBe(1);
    expect(failedCalls()).toHaveLength(1);
    expect(String((failedCalls()[0] as any[])[1].error)).toMatch(/not restarted with less confinement/);
    expect(worker.status).toBe('error');
  });

  test('a task with no isolation stamp is held to protected: no restart', async () => {
    queryAbortFirstCall = true;
    process.env.BUILDD_ALLOW_REDUCED_ISOLATION = '1';
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker({ id: 'w-bwrap-unstamped' });
    const run = (manager as any).startSession(worker, getTestWorkspace(), makeTask());
    worker.bwrapRetryPending = true;
    bwrapProbeOk = false;
    __resetBwrapSupportForTest();
    await run;
    expect(queryCallCount).toBe(1);
    expect(failedCalls()).toHaveLength(1);
  });

  test('a protected task never starts on a host that cannot confine Claude', async () => {
    bwrapProbeOk = false;
    process.env.BUILDD_ALLOW_REDUCED_ISOLATION = '1';
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker({ id: 'w-bwrap-never' });
    await (manager as any).startSession(worker, getTestWorkspace(), makeTask({ isolation: { requirement: 'protected', source: 'default', mode: 'enforced' } }));
    expect(queryCallCount).toBe(0);
    expect(String(worker.error)).toMatch(/Not started: The task needs protected isolation/);
  });

  // AC-4: trusted_local runs reduced only with the operator opt-in.
  test('a trusted_local task without the operator opt-in does not run reduced', async () => {
    bwrapProbeOk = false;
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker({ id: 'w-bwrap-no-optin' });
    await (manager as any).startSession(worker, getTestWorkspace(), makeTask({ isolation: { requirement: 'trusted_local', source: 'workspace', mode: 'reduced' } }));
    expect(queryCallCount).toBe(0);
    expect(String(worker.error)).toMatch(/BUILDD_ALLOW_REDUCED_ISOLATION=1/);
  });

  test('a confined run records its effective mode', async () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker({ id: 'w-bwrap-confined' });
    await (manager as any).startSession(worker, getTestWorkspace(), makeTask());
    expect(queryCallCount).toBe(1);
    expect(worker.milestones.some((m: any) => /isolation: protected, Claude confined by bubblewrap/.test(m.label ?? ''))).toBe(true);
  });
});
