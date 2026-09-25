/**
 * cbm_access experiment, withheld arm — what the RUNNER does with the claim
 * marker. A withheld task must get neither the codebase-memory tools nor the
 * steering block that tells the agent to use them; a control task in the same
 * harness must get both, or the comparison is not a comparison.
 *
 * Harness copied from cbm-prompt-call-site.test.ts (the SDK `query` is stubbed
 * and its options captured).
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { LocalUIConfig } from '../../src/types';
import * as realCbm from '../../src/cbm-enforcement';
import * as realBootstrap from '../../src/cbm-bootstrap';

const HEADING = '## Codebase graph (codebase-memory)';

let lastQueryOpts: any = null;
let mockMessages: any[] = [];
const mockStreamInputFn = mock(() => {});

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: any) => {
    lastQueryOpts = opts;
    const msgs = [...mockMessages];
    let idx = 0;
    return {
      streamInput: mockStreamInputFn,
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

const mockUpdateWorker = mock(async () => ({}));
const mockClaimTask = mock(async () => ({ workers: [] }));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mockUpdateWorker;
    claimTask = mockClaimTask;
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
  chmodSync: () => {},
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

mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ platform: 'linux', arch: 'x64', tools: [], envKeys: [], mcp: [], mcpServers: [], labels: { type: 'local', os: 'linux', arch: 'x64', hostname: 'test' }, scannedAt: new Date(0).toISOString() }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  parseMcpJson: () => [],
  scanMcpServersRich: () => [],
  checkBwrapSupport: () => true,
  checkBwrapMountIsolationSupport: () => true,
}));

// CBM activation is forced rather than probed: the gates depend on a CBM binary
// existing on the host, which is not a property of the call site under test.
// The REAL activation decides withheld tasks (that gate runs before any fs
// probe); every other task gets the forced "enforced" activation, so the
// control case below is a CBM-equipped session and the comparison means
// something.
let cbmActivation: any = { enforced: false };
const activationCtxs: any[] = [];
// Captured as a value BEFORE mock.module: the namespace object is live, so
// reading realCbm.buildCbmActivation inside the stub would call the stub.
const realBuildCbmActivation = realCbm.buildCbmActivation;
const realToolSurface = [...realCbm.CBM_TOOL_SURFACE];
mock.module('../../src/cbm-enforcement', () => ({
  ...realCbm,
  buildCbmActivation: (ctx: any) => {
    activationCtxs.push(ctx);
    // This harness sets up no git worktree; supply the path a real repo task
    // has, so the gate under test is the experiment's and not no_worktree's.
    return ctx.cbmExperimentWithheld
      ? realBuildCbmActivation({ ...ctx, worktreePath: ctx.worktreePath ?? '/tmp/test-workspace' })
      : cbmActivation;
  },
  // Would fork a real seeder process.
  spawnCbmSeedRefresh: () => 'spawned',
  ensureCbmRuntimeDir: (_cache: string, explicit?: string) => explicit ?? '/tmp/cbm-runtime',
}));

// Spread the real module and override only the one function that would spawn an
// indexer. A stub that enumerates exports instead fails the WHOLE file at parse
// time the moment the module gains one ("Export named 'x' not found in module"),
// which is a CI break in a file that has nothing to do with the new export.
let bootstrapOutcome: any = { ok: true, durationMs: 1 };
mock.module('../../src/cbm-bootstrap.js', () => ({
  ...realBootstrap,
  runCbmBootstrap: async () => bootstrapOutcome,
}));

// Drives the mount-unavailable branch, which is what sets cbmMountBlocked.
let bwrapWrap = false;
let bwrapThrows = false;
mock.module('../../src/bwrap-mount-allowlist', () => ({
  CBM_BINARY_PATH: '/usr/local/bin/cbm',
  isMountAllowlistEnabled: () => bwrapWrap,
  shouldWrapWorkerInBwrap: () => bwrapWrap,
  createBwrapSpawn: () => () => { throw new Error('not spawned in this test'); },
  buildWorkerBwrapArgv: (cfg: any) => {
    // The production function throws when a required CBM bind is missing; it
    // succeeds on the retry that omits the CBM paths.
    if (bwrapThrows && cfg.cbmCacheDir) throw new Error('cbm cache dir missing');
    return ['bwrap', '--'];
  },
}));

const { WorkerManager } = await import('../../src/workers');

function makeConfig(overrides?: Partial<LocalUIConfig>): LocalUIConfig {
  return {
    projectsRoot: '/tmp',
    builddServer: 'http://localhost:3000',
    apiKey: 'test-key',
    maxConcurrent: 2,
    model: 'claude-sonnet-4-5-20250929',
    serverless: true,
    ...overrides,
  } as LocalUIConfig;
}

async function runTask(
  manager: InstanceType<typeof WorkerManager>,
  workerId: string,
  extra: Record<string, unknown> = {},
) {
  mockMessages = [
    { type: 'system', subtype: 'init', session_id: `sess-${workerId}` },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
    { type: 'result', subtype: 'success', session_id: `sess-${workerId}` },
  ];
  const task = {
    id: `task-${workerId}`,
    title: 'CBM experiment task',
    description: 'change some code',
    workspaceId: 'ws-1',
    workspace: { name: 'test-workspace' },
    status: 'waiting',
    priority: 1,
  };
  mockClaimTask.mockImplementation(async () => ({ workers: [{
    id: workerId,
    branch: `buildd/${workerId}`,
    worktreePath: '/tmp/test-workspace',
    task,
    // A codebase-memory server arriving by another route (a connector here;
    // the project .mcp.json is the other) — the withheld arm must strip it.
    mcpConnectors: [{ name: 'codebase-memory', transport: 'stdio', command: '/usr/local/bin/cbm', args: [] }],
    ...extra,
  }] }));
  await manager.claimAndStart(task as any);
  await new Promise(r => setTimeout(r, 250));
  // The session must actually start: every assertion below would pass
  // vacuously against a worker that died before calling the SDK.
  expect(lastQueryOpts).not.toBeNull();
  const opts = lastQueryOpts.options ?? {};
  return {
    append: (opts.systemPrompt?.append ?? '') as string,
    mcpServers: (opts.mcpServers ?? {}) as Record<string, unknown>,
    disallowed: (opts.disallowedTools ?? []) as string[],
  };
}

const ENFORCED = {
  enforced: true,
  cbmBinaryPath: '/usr/local/bin/cbm',
  cbmCacheDir: '/tmp/cbm-cache',
  cbmRuntimeDir: '/tmp/cbm-runtime',
  sharedCache: false,
};

describe('cbm_access withheld arm at the runner', () => {
  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(() => {
    lastQueryOpts = null;
    mockMessages = [];
    activationCtxs.length = 0;
    mockClaimTask.mockReset();
    mockClaimTask.mockResolvedValue({ workers: [] });
    cbmActivation = ENFORCED;
    bwrapWrap = false;
    bwrapThrows = false;
    bootstrapOutcome = { ok: true, durationMs: 1 };
  });

  afterEach(() => {
    manager?.destroy();
  });

  test('control (no marker): CBM is mounted and the agent is steered to it', async () => {
    manager = new WorkerManager(makeConfig());
    const { append, mcpServers, disallowed } = await runTask(manager, 'w-cbm-ctl');
    expect(activationCtxs.at(-1).cbmExperimentWithheld).toBe(false);
    expect(append).toContain(HEADING);
    expect(mcpServers['codebase-memory']).toBeDefined();
    expect(disallowed).not.toContain('mcp__codebase-memory__search_graph');
  });

  test('control-arm marker (withheld: false) behaves exactly like no marker', async () => {
    manager = new WorkerManager(makeConfig());
    const { append, mcpServers } = await runTask(manager, 'w-cbm-ctl2', {
      cbmExperiment: { experimentId: 'exp-cbm', policyVersion: 1, arm: 'control', withheld: false },
    });
    expect(append).toContain(HEADING);
    expect(mcpServers['codebase-memory']).toBeDefined();
  });

  test('withheld: no CBM server, every CBM tool denied, and no steering block', async () => {
    manager = new WorkerManager(makeConfig());
    const { append, mcpServers, disallowed } = await runTask(manager, 'w-cbm-wh', {
      cbmExperiment: { experimentId: 'exp-cbm', policyVersion: 1, arm: 'treatment', withheld: true },
    });
    expect(activationCtxs.at(-1).cbmExperimentWithheld).toBe(true);
    expect(append).not.toContain(HEADING);
    expect(append).not.toContain('codebase-memory');
    expect(mcpServers['codebase-memory']).toBeUndefined();
    expect(disallowed).toContain('mcp__codebase-memory');
    for (const tool of realToolSurface) {
      expect(disallowed).toContain(`mcp__codebase-memory__${tool}`);
    }
    // The terminal report labels the skip, so CBM metrics can tell a withheld
    // task from a broken one (and cbm-health does not page on the draw).
    const cbmReports = mockUpdateWorker.mock.calls
      .map((c: any[]) => c[1]?.resultMeta?.cbm)
      .filter(Boolean);
    expect(cbmReports.at(-1)).toMatchObject({ outcome: 'disabled', disableReason: 'experiment_withheld' });
  });
});

describe('claim request declares the withhold feature', () => {
  test('BuilddClient.claimTask sends runnerFeatures: [cbm_withhold]', async () => {
    // The server enrols only runners that declare it (an older runner would
    // ignore the marker and mount CBM on a task recorded as withheld). The
    // client module is mocked above, so read the real one's source instead.
    const src = await Bun.file(new URL('../../src/buildd.ts', import.meta.url)).text();
    const claim = src.slice(src.indexOf('async claimTask('), src.indexOf("this.fetch('/api/workers/claim'"));
    expect(claim).toContain('runnerFeatures: [CBM_WITHHOLD_RUNNER_FEATURE]');
    const { CBM_WITHHOLD_RUNNER_FEATURE } = await import('@buildd/core/cbm-access-experiment');
    expect(CBM_WITHHOLD_RUNNER_FEATURE).toBe('cbm_withhold');
  });
});
