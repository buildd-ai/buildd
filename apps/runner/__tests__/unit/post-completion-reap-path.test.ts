/**
 * The post-completion watchdog must not turn a finished worker into a failure.
 *
 * checkStale() reaps an SDK session that is still alive well past its worker's
 * own completion (the agent called complete_task, then hung on a stuck
 * tool/MCP call). Aborting that session makes the SDK throw, which lands in
 * startSession's outer catch — and that catch's abort arm used to report the
 * worker `failed`, flip its local status from `done` to `error`, and overwrite
 * completedAt, whenever the server did not answer "completed" to the
 * reconciliation probe (probe failed, or the worker was an `error` worker in
 * the first place). The reap is cleanup of a process, not an outcome.
 *
 * It must also leave the session map entry in place until the session's own
 * finally block runs: that block is conditioned on the entry and is where the
 * per-worker credential/config/CBM dirs are removed.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/post-completion-reap-path.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
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
  // A session that emits init + one tool call, then HANGS (a stuck tool/MCP
  // call) until its abortController fires — at which point the SDK throws,
  // exactly as the real one does when the CLI subprocess is killed.
  query: (opts: any) => {
    const msgs = [...mockMessages];
    const signal: AbortSignal | undefined = opts?.options?.abortController?.signal;
    let idx = 0;
    return {
      streamInput: () => {},
      supportedModels: async () => [],
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (idx < msgs.length) return { value: msgs[idx++], done: false };
            await new Promise<void>((resolve) => {
              if (!signal || signal.aborted) return resolve();
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
            throw new Error('Claude Code process aborted by user');
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
const mockGetWorkerRemote = mock(async (_id: string): Promise<any> => null);
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
    getWorkerRemote = mockGetWorkerRemote;
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
  loadTerminalWorkersCached: () => [],
  __resetDiskWorkersCache: () => {},
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

async function startHungSession(manager: InstanceType<typeof WorkerManager>, workerId: string) {
  const task = makeTask();
  mockClaimTask.mockImplementation(async () => ({ workers: [{ id: workerId, branch: 'buildd/test', task }] }));
  await manager.claimAndStart(task);
  await new Promise(r => setTimeout(r, 200));
}

const hungSession = () => [
  { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-4-6' },
  {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'sleep 99999' } }] },
  },
];

function resetAll() {
  updateCalls.length = 0;
  sessionLogCalls.length = 0;
  mockMessages = [];
  mockUpdateWorker.mockClear();
  mockUpdateWorker.mockImplementation(async (id: string, payload: any) => {
    updateCalls.push({ id, payload });
    return {};
  });
  mockGetWorkerRemote.mockReset();
  mockGetWorkerRemote.mockImplementation(async () => null);
  mockClaimTask.mockReset();
  mockClaimTask.mockImplementation(async () => ({ workers: [] }));
}

const failedPatch = () => updateCalls.find(c => c.payload?.status === 'failed');

describe('post-completion reap does not report a failure', () => {
  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(resetAll);
  afterEach(() => { manager?.destroy(); });

  for (const status of ['done', 'error'] as const) {
    test(`a ${status} worker whose hung session is reaped keeps its outcome`, async () => {
      mockMessages = hungSession();
      manager = new WorkerManager(makeConfig());
      const id = `w-reap-${status}`;
      await startHungSession(manager, id);

      const worker = manager.getWorker(id)!;
      expect(worker).toBeDefined();
      expect((manager as any).sessions.has(id)).toBe(true);

      // The agent already finished (worker:completed / markDone / its own
      // failure report) well over the grace period ago; the session never ended.
      const completedAt = Date.now() - 10 * 60 * 1000;
      worker.status = status;
      worker.completedAt = completedAt;
      worker.lastActivity = completedAt;
      if (status === 'error') worker.error = 'agent reported failure';
      updateCalls.length = 0;

      (manager as any).workerSync.checkStale();
      await new Promise(r => setTimeout(r, 200));

      expect(failedPatch()).toBeUndefined();
      expect(worker.status).toBe(status);
      expect(worker.completedAt).toBe(completedAt);
      expect(sessionLogCalls.some(c => c.event === 'post_completion_session_reaped')).toBe(true);
      expect(sessionLogCalls.some(c => c.event === 'session_abort')).toBe(false);
      // The session's own finally block ran its cleanup and dropped the entry.
      expect((manager as any).sessions.has(id)).toBe(false);
    });
  }
});
