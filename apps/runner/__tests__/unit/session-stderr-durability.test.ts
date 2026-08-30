/**
 * Integration-level tests for stderr durability through WorkerManager.
 *
 * Regression target: an SDK session that dies (or produces zero turns) used to
 * leave nothing on either side — `sessionId: null`, empty messages, and stderr
 * only in the runner's screen buffer. These tests assert that the stderr callback
 * now files into the per-worker session log and that the error-trace flush runs on
 * a zero-turn session end, not only on the unexpected-error branch.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/session-stderr-durability.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { LocalUIConfig } from '../../src/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

let mockMessages: any[] = [];
let mockQueryError: Error | null = null;
/** stderr chunks the fake SDK emits through the caller's stderr callback. */
let mockStderrChunks: string[] = [];

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
    for (const chunk of mockStderrChunks) opts?.options?.stderr?.(chunk);
    const msgs = [...mockMessages];
    const throwErr = mockQueryError;
    let idx = 0;
    return {
      streamInput: () => {},
      supportedModels: async () => [],
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (throwErr) throw throwErr;
            if (idx < msgs.length) return { value: msgs[idx++], done: false };
            return { value: undefined, done: true };
          },
        };
      },
    };
  },
}));

// Session logger — capture every entry so we can assert stderr was filed.
const loggedEntries: Array<{ workerId: string; level: string; event: string; detail?: string }> = [];
mock.module('../../src/session-logger', () => ({
  sessionLog: (workerId: string, level: string, event: string, detail?: string) => {
    loggedEntries.push({ workerId, level, event, detail });
  },
  readSessionLogs: () => [],
  claimLog: () => {},
  cleanupOldLogs: () => {},
}));

const mockUpdateWorker = mock(async (..._args: any[]) => ({}));
const mockRequestSessionUploadUrl = mock(async (..._args: any[]) => null as any);
const mockClaimTask = mock(async () => ({ workers: [] as any[] }));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mockUpdateWorker;
    requestSessionUploadUrl = mockRequestSessionUploadUrl;
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

function makeTask(id = 'task-1') {
  return {
    id,
    title: 'Test task',
    description: 'Do something',
    workspaceId: 'ws-1',
    workspace: { name: 'test-workspace' },
    status: 'waiting',
    priority: 1,
  };
}

async function startSessionFor(
  manager: InstanceType<typeof WorkerManager>,
  workerId: string,
  task: any,
  branch: string,
) {
  mockClaimTask.mockImplementation(async () => ({ workers: [{ id: workerId, branch, task }] }));
  await manager.claimAndStart(task);
}

function stderrEntries() {
  return loggedEntries.filter(e => e.event === 'session_stderr');
}

function tracePatches() {
  return mockUpdateWorker.mock.calls.filter((c: any[]) => Array.isArray(c[1]?.appendErrorTraces));
}

describe('SDK stderr durability', () => {
  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(() => {
    loggedEntries.length = 0;
    mockMessages = [];
    mockQueryError = null;
    mockStderrChunks = [];
    mockUpdateWorker.mockReset();
    mockUpdateWorker.mockImplementation(async () => ({}));
    mockRequestSessionUploadUrl.mockReset();
    mockRequestSessionUploadUrl.mockImplementation(async () => null);
    mockClaimTask.mockReset();
    mockClaimTask.mockImplementation(async () => ({ workers: [] }));
  });

  afterEach(() => {
    manager?.destroy();
  });

  test('stderr from a zero-turn session reaches the per-worker session log', async () => {
    mockStderrChunks = ['bwrap: No permitted namespaces'];
    // No init event, no result: the silent-start shape seen in prod.
    mockMessages = [];

    manager = new WorkerManager(makeConfig());
    await startSessionFor(manager, 'w-silent', makeTask('task-silent'), 'buildd/silent');
    await new Promise(r => setTimeout(r, 250));

    const entries = stderrEntries();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].detail).toContain('bwrap: No permitted namespaces');
    expect(entries[0].workerId).toBe('w-silent');
  });

  test('the error-trace flush runs on a zero-turn session end', async () => {
    mockStderrChunks = ['claude: error while loading shared libraries: libsomething.so'];
    mockMessages = [];

    manager = new WorkerManager(makeConfig());
    await startSessionFor(manager, 'w-zero-turn', makeTask('task-zero'), 'buildd/zero');
    await new Promise(r => setTimeout(r, 250));

    const patches = tracePatches();
    expect(patches.length).toBeGreaterThan(0);
    const traces = patches.flatMap((c: any[]) => c[1].appendErrorTraces);
    expect(traces.some((t: any) => t.source === 'stderr' && t.excerpt.includes('shared libraries'))).toBe(true);
  });

  test('a normally-completing session still flushes its stderr trace', async () => {
    mockStderrChunks = ['warning: node deprecation notice'];
    mockMessages = [
      { type: 'system', subtype: 'init', session_id: 'sess-ok' },
      { type: 'result', subtype: 'success', session_id: 'sess-ok', num_turns: 1 },
    ];

    manager = new WorkerManager(makeConfig());
    await startSessionFor(manager, 'w-ok', makeTask('task-ok'), 'buildd/ok');
    await new Promise(r => setTimeout(r, 300));

    expect(stderrEntries().length).toBeGreaterThan(0);
    const traces = tracePatches().flatMap((c: any[]) => c[1].appendErrorTraces);
    expect(traces.some((t: any) => t.excerpt.includes('deprecation notice'))).toBe(true);
  });

  test('stderr is filed exactly once per chunk (no duplicate traces)', async () => {
    mockStderrChunks = ['single failure line'];
    mockMessages = [];

    manager = new WorkerManager(makeConfig());
    await startSessionFor(manager, 'w-once', makeTask('task-once'), 'buildd/once');
    await new Promise(r => setTimeout(r, 250));

    const traces = tracePatches().flatMap((c: any[]) => c[1].appendErrorTraces);
    const matching = traces.filter((t: any) => t.excerpt.includes('single failure line'));
    expect(matching.length).toBe(1);
  });

  test('a failed session diagnostics upload does not change worker status', async () => {
    mockRequestSessionUploadUrl.mockImplementation(async () => { throw new Error('503 storage down'); });
    mockStderrChunks = [];
    mockMessages = [
      { type: 'system', subtype: 'init', session_id: 'sess-up' },
      { type: 'result', subtype: 'success', session_id: 'sess-up', num_turns: 1 },
    ];

    manager = new WorkerManager(makeConfig());
    await startSessionFor(manager, 'w-upload-fail', makeTask('task-up'), 'buildd/up');
    await new Promise(r => setTimeout(r, 300));

    const worker = manager.getWorker('w-upload-fail');
    expect(worker?.status).not.toBe('error');
  });
});
