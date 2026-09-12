/**
 * CBM steering block — CALL SITES.
 *
 * `cbm-prompt-block.test.ts` pins the wording of `buildCbmSystemPromptBlock`.
 * This file pins how `workers.ts` calls it, which is a separate failure class:
 * the block was appended twice, and the second call passed no options, so a
 * worker on a shared base index received both "trust it for structure, Read the
 * file for current content" AND "this worktree is already indexed" — two
 * contradictory claims about whether `get_code_snippet` reflects the agent's own
 * edits. Believing the wrong one means reading a stale snippet of a file you
 * just edited and then distrusting the graph for the rest of the session.
 *
 * The heading is counted rather than matched so a future re-duplication fails
 * here instead of shipping.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { join } from 'path';
import type { LocalUIConfig } from '../../src/types';

// The real module, captured before mock.module swaps the registry entry: the
// prompt text under test must be the production text, not a stub.
import * as realCbm from '../../src/cbm-enforcement';
import * as realBootstrap from '../../src/cbm-bootstrap';

const HEADING = '## Codebase graph (codebase-memory)';

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

// ─── Source-shape guard ─────────────────────────────────────────────────────
// Cheap, and it catches the two defects at their root: a second call site, and
// a call that drops the options.

// Read via Bun.file, not fs: this file replaces the whole 'fs' module below and
// a mocked readFileSync would hand every assertion the stub's '{}' — a source
// guard that passes while reading nothing.
const workersSrc = await Bun.file(join(import.meta.dir, '../../src/workers.ts')).text();

describe('workers.ts CBM steering call site (source shape)', () => {
  const src = workersSrc;

  test('calls buildCbmSystemPromptBlock exactly once', () => {
    // The import line names it too, so count call parens only.
    expect(countOccurrences(src, 'buildCbmSystemPromptBlock(')).toBe(1);
  });

  test('never calls it with no arguments', () => {
    // A no-args call emits the non-shared opening ("this worktree is already
    // indexed"), which is false whenever the graph is a shared base index, and
    // silently drops the base-vs-branch warning.
    expect(src).not.toContain('buildCbmSystemPromptBlock()');
  });

  test('passes the real project and shared-base flags', () => {
    const call = src.slice(
      src.indexOf('buildCbmSystemPromptBlock('),
      src.indexOf('buildCbmSystemPromptBlock(') + 300,
    );
    expect(call).toContain('project:');
    expect(call).toContain('sharedBaseIndex:');
  });

  test('resolves the mount-blocked state before the guard reads it', () => {
    // The original order set `cbmMountBlocked = true` AFTER the append, so a
    // mount-blocked worker was still told to use a graph that was not mounted —
    // exactly what the guard's own comment claims to prevent.
    const assignment = src.indexOf('cbmMountBlocked = true');
    const callSite = src.indexOf('buildCbmSystemPromptBlock(');
    expect(assignment).toBeGreaterThan(-1);
    expect(assignment).toBeLessThan(callSite);
  });
});

// ─── Behavioural: the assembled prompt ──────────────────────────────────────

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
let cbmActivation: any = { enforced: false };
mock.module('../../src/cbm-enforcement', () => ({
  ...realCbm,
  buildCbmActivation: () => cbmActivation,
  // Would fork a real seeder process.
  spawnCbmSeedRefresh: () => 'spawned',
  ensureCbmRuntimeDir: (_cache: string, explicit?: string) => explicit ?? '/tmp/cbm-runtime',
}));

// Spread the real module and override only the one function that would spawn an
// indexer. A stub that enumerates exports instead fails the WHOLE file at parse
// time the moment the module gains one ("Export named 'x' not found in module"),
// which is a CI break in a file that has nothing to do with the new export.
mock.module('../../src/cbm-bootstrap.js', () => ({
  ...realBootstrap,
  runCbmBootstrap: async () => ({ ok: true, durationMs: 1 }),
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

async function runTask(manager: InstanceType<typeof WorkerManager>, workerId = 'w-cbm-1') {
  mockMessages = [
    { type: 'system', subtype: 'init', session_id: `sess-${workerId}` },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
    { type: 'result', subtype: 'success', session_id: `sess-${workerId}` },
  ];
  const task = {
    id: 'task-cbm-1',
    title: 'CBM steering task',
    description: 'assemble a prompt',
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
  }] }));
  await manager.claimAndStart(task as any);
  await new Promise(r => setTimeout(r, 250));
  return (lastQueryOpts?.options?.systemPrompt?.append ?? '') as string;
}

describe('assembled system prompt: CBM steering block', () => {
  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(() => {
    lastQueryOpts = null;
    mockMessages = [];
    mockClaimTask.mockReset();
    mockClaimTask.mockResolvedValue({ workers: [] });
    cbmActivation = { enforced: false };
    bwrapWrap = false;
    bwrapThrows = false;
  });

  afterEach(() => {
    manager?.destroy();
  });

  test('appears exactly once on a shared base index, with the base-vs-branch warning', async () => {
    cbmActivation = {
      enforced: true,
      cbmBinaryPath: '/usr/local/bin/cbm',
      cbmCacheDir: '/tmp/cbm-cache',
      cbmRuntimeDir: '/tmp/cbm-runtime',
      sharedCache: true,
      skipBootstrapIndex: true,
      cbmProject: 'seeded-project',
    };
    manager = new WorkerManager(makeConfig());
    const append = await runTask(manager);

    expect(countOccurrences(append, HEADING)).toBe(1);
    expect(append).toContain('seeded-project');
    expect(append).toContain('It maps the base checkout, not your branch');
    // The no-args opening. It contradicts the line above and must not appear.
    expect(append).not.toContain('This worktree is already indexed');
  });

  test('appears exactly once with the worktree wording when the index is per-worker', async () => {
    cbmActivation = {
      enforced: true,
      cbmBinaryPath: '/usr/local/bin/cbm',
      cbmCacheDir: '/tmp/cbm-cache',
      cbmRuntimeDir: '/tmp/cbm-runtime',
      sharedCache: false,
    };
    manager = new WorkerManager(makeConfig());
    const append = await runTask(manager, 'w-cbm-2');

    expect(countOccurrences(append, HEADING)).toBe(1);
    expect(append).toContain('This worktree is already indexed');
    expect(append).not.toContain('It maps the base checkout, not your branch');
  });

  test('is absent when a required CBM mount was unavailable', async () => {
    cbmActivation = {
      enforced: true,
      cbmBinaryPath: '/usr/local/bin/cbm',
      cbmCacheDir: '/tmp/cbm-cache',
      cbmRuntimeDir: '/tmp/cbm-runtime',
      sharedCache: true,
      skipBootstrapIndex: true,
      cbmProject: 'seeded-project',
    };
    bwrapWrap = true;
    bwrapThrows = true;
    manager = new WorkerManager(makeConfig());
    const append = await runTask(manager, 'w-cbm-3');

    expect(countOccurrences(append, HEADING)).toBe(0);
  });

  test('is absent when CBM is not enforced', async () => {
    manager = new WorkerManager(makeConfig());
    const append = await runTask(manager, 'w-cbm-4');
    expect(countOccurrences(append, HEADING)).toBe(0);
  });
});
