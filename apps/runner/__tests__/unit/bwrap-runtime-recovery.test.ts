/**
 * Runtime bwrap recovery: when the runner detects bwrap_namespace_denied in a
 * tool result mid-task, it should flip _bwrapSupported=false (so future tasks
 * skip sandboxing) and abort the current task for a clean retry.
 *
 * This guards against stale runner processes that started with old code where
 * checkBwrapSupport() gave a false positive (setuid bwrap letting the probe
 * pass while Claude Code's actual invocation fails).
 *
 * Run: bun test apps/runner/__tests__/unit/bwrap-runtime-recovery.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { LocalWorker, LocalUIConfig } from '../../src/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (_opts: any) => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() {
      return { async next() { return { value: undefined, done: true }; } };
    },
  }),
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
  loadWorker: () => null,
  deleteWorker: () => {},
}));

mock.module('../../src/skills.js', () => ({
  syncSkillToLocal: async () => {},
}));

// Import WorkerManager after mocks
const { WorkerManager, __resetBwrapSupportForTest } = await import('../../src/workers');

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
    branch: 'buildd/test',
    status: 'working',
    hasNewActivity: false,
    lastActivity: Date.now(),
    milestones: [],
    currentAction: 'Running...',
    commits: [],
    output: [],
    toolCalls: [],
    messages: [],
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
    cwd: '/tmp/test-workspace',
    repoPath: '/tmp/test-workspace',
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('bwrap runtime recovery', () => {
  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(() => {
    // Reset module-level bwrap cache so recovery fires from a clean state,
    // even when other test files have already set _bwrapSupported=false.
    __resetBwrapSupportForTest();
  });

  afterEach(() => {
    manager?.destroy();
  });

  test('sets worker.error and aborts session when bwrap_namespace_denied is detected mid-task', async () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker();
    const abortController = new AbortController();
    injectWorker(manager, worker, abortController);

    const bwrapError =
      'bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.';

    await (manager as any).handleMessage(worker, makeBashToolResultMessage(bwrapError));

    expect(worker.error).toContain('bwrap sandbox unavailable');
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
});
