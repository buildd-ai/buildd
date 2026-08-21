/**
 * Tests for the tool_result_meta SDK 0.3.216 surface in WorkerManager.handleMessage().
 *
 * When a tool call is denied/cancelled/interrupted the SDK attaches a
 * tool_result_meta sidecar with non_execution_kind (+ optional user_feedback).
 * The runner should:
 *   - emit a milestone labelled with the kind (and feedback excerpt if present)
 *   - skip the error-trace scanner so no false permission_denied traces are emitted
 *
 * Run: bun test apps/runner/__tests__/unit/tool-result-meta.test.ts
 */

import { describe, test, expect, mock, afterEach, setDefaultTimeout } from 'bun:test';
import type { LocalWorker, LocalUIConfig } from '../../src/types';

setDefaultTimeout(15_000);

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

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mock(async () => ({}));
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

mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({
    platform: 'linux',
    arch: 'x64',
    tools: [],
    envKeys: [],
    mcp: [],
    mcpServers: [],
    labels: { type: 'local', os: 'linux', arch: 'x64', hostname: 'test' },
    scannedAt: new Date(0).toISOString(),
  }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  parseMcpJson: () => [],
  scanMcpServersRich: () => [],
  checkBwrapSupport: () => false,
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
  };
}

function makeWorker(id = 'w-meta-1'): LocalWorker {
  return {
    id,
    taskId: 'task-meta',
    taskTitle: 'Test tool_result_meta',
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
  };
}

function injectWorker(manager: InstanceType<typeof WorkerManager>, worker: LocalWorker) {
  (manager as any).workers.set(worker.id, worker);
  (manager as any).sessions.set(worker.id, {
    abortController: new AbortController(),
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

/** Build a user message with a tool_result block that carries tool_result_meta. */
function makeNonExecMessage(kind: string, feedback?: string) {
  const block: any = {
    type: 'tool_result',
    tool_use_id: 'toolu_bash_1',
    content: '',
    tool_result_meta: { non_execution_kind: kind },
  };
  if (feedback !== undefined) block.tool_result_meta.user_feedback = feedback;
  return {
    type: 'user',
    session_id: 'sess-meta',
    parent_tool_use_id: null,
    message: { role: 'user', content: [block] },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('tool_result_meta non-execution guard', () => {
  let manager: InstanceType<typeof WorkerManager>;

  afterEach(() => {
    manager?.destroy();
  });

  test('adds milestone with kind label when non_execution_kind is set (no feedback)', async () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker();
    injectWorker(manager, worker);

    await (manager as any).handleMessage(worker, makeNonExecMessage('permission_denied'));

    expect(worker.milestones.length).toBe(1);
    expect(worker.milestones[0].label).toBe('Tool not run: permission_denied');
  });

  test('adds milestone with feedback excerpt when user_feedback is present', async () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker('w-meta-2');
    injectWorker(manager, worker);

    await (manager as any).handleMessage(
      worker,
      makeNonExecMessage('user_cancelled', 'User clicked deny on the bash tool'),
    );

    expect(worker.milestones.length).toBe(1);
    expect(worker.milestones[0].label).toContain('user_cancelled');
    expect(worker.milestones[0].label).toContain('User clicked deny on the bash tool');
  });

  test('truncates feedback at 80 characters in milestone label', async () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker('w-meta-3');
    injectWorker(manager, worker);

    const longFeedback = 'x'.repeat(100);
    await (manager as any).handleMessage(
      worker,
      makeNonExecMessage('permission_denied', longFeedback),
    );

    const label: string = worker.milestones[0].label as string;
    expect(label).toContain('x'.repeat(80));
    expect(label).not.toContain('x'.repeat(81));
  });

  test('does NOT set pendingErrorTraces for non-execution blocks (skips scanner)', async () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker('w-meta-4');
    injectWorker(manager, worker);

    // Even though content says "Permission denied", the non_execution_kind guard fires first
    const msg = makeNonExecMessage('permission_denied');
    msg.message.content[0].content = 'Permission denied';

    await (manager as any).handleMessage(worker, msg);

    expect(worker.pendingErrorTraces).toBeUndefined();
  });

  test('normal tool_result without tool_result_meta still runs through scanner', async () => {
    manager = new WorkerManager(makeConfig());
    const worker = makeWorker('w-meta-5');
    injectWorker(manager, worker);

    const msg = {
      type: 'user',
      session_id: 'sess-meta',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_bash_2',
          content: 'bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.',
        }],
      },
    };

    await (manager as any).handleMessage(worker, msg);

    expect(worker.pendingErrorTraces).toBeDefined();
    expect(worker.pendingErrorTraces!.some((t: any) => t.pattern === 'bwrap_namespace_denied')).toBe(true);
  });
});
