/**
 * Session wiring for the PostToolUse tool activity hook, plus a guard that the
 * removed Agent Teams hooks stay unregistered. The hook's own behaviour
 * (lastActivity / toolInFlight) is covered in worker-manager-lifecycle.test.ts.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/tool-activity-hook.test.ts
 */

import { describe, test, expect, beforeEach, mock, afterEach , afterAll } from 'bun:test';
import { tmpdir } from 'os';
import { initTestWorkspace, getTestWorkspace, cleanupTestWorkspace } from '../test-workspace';
import type { LocalUIConfig } from '../../src/types';

// ─── Capture query options ──────────────────────────────────────────────────

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
            if (idx < msgs.length) {
              return { value: msgs[idx++], done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    };
  },
}));

const mockUpdateWorker = mock(async () => ({}));
const mockClaimTask = mock(async () => ({ workers: [] }));
const mockGetWorkspaceConfig = mock(async () => ({ configStatus: 'unconfigured' }));
const mockGetCompactObservations = mock(async () => ({ markdown: '', count: 0 }));
const mockSearchObservations = mock(async () => []);
const mockGetBatchObservations = mock(async () => []);
const mockCreateObservation = mock(async () => ({}));
const mockListWorkspaces = mock(async () => []);
const mockSendHeartbeat = mock(async () => ({}));
const mockRunCleanup = mock(async () => ({}));
const mockSearchFeedbackMemories = mock(async () => []);
const mockGetWorkerRemote = mock(async () => null);

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mockUpdateWorker;
    claimTask = mockClaimTask;
    getWorkspaceConfig = mockGetWorkspaceConfig;
    getCompactObservations = mockGetCompactObservations;
    searchObservations = mockSearchObservations;
    getBatchObservations = mockGetBatchObservations;
    createObservation = mockCreateObservation;
    listWorkspaces = mockListWorkspaces;
    sendHeartbeat = mockSendHeartbeat;
    runCleanup = mockRunCleanup;
    searchFeedbackMemories = mockSearchFeedbackMemories;
    getWorkerRemote = mockGetWorkerRemote;
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
  syncSkillToLocal: mock(async () => {}),
}));

// Without this, WorkerManager's constructor runs scanEnvironment() for real —
// spawning execSync probes for ~18 tools plus browser detection. That's slow
// and CI-load-dependent, which is what pushed this suite past its timeout.
mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ platform: 'linux', arch: 'x64', tools: [], envKeys: [], mcp: [], mcpServers: [], labels: { type: 'local', os: 'linux', arch: 'x64', hostname: 'test' }, scannedAt: new Date(0).toISOString() }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  parseMcpJson: () => [],
  scanMcpServersRich: () => [],
  checkBwrapSupport: () => true,
  checkBwrapMountIsolationSupport: () => true,
}));

const { WorkerManager } = await import('../../src/workers');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<LocalUIConfig>): LocalUIConfig {
  return {
    projectsRoot: '/tmp',
    builddServer: 'http://localhost:3000',
    apiKey: 'test-key',
    maxConcurrent: 2,
    model: 'claude-sonnet-4-5-20250929',
    serverless: true,
    ...overrides,
  };
}

function makeTask(overrides?: Record<string, any>) {
  return {
    id: 'task-team-1',
    title: 'Team tracking test',
    description: 'Test team event tracking',
    workspaceId: 'ws-1',
    workspace: { name: 'test-workspace' },
    status: 'waiting',
    priority: 1,
    ...overrides,
  };
}

// Helper to build a tool_use block (mimics SDK assistant message format)
function toolUse(name: string, input: Record<string, unknown>, id?: string) {
  return {
    type: 'tool_use',
    id: id || `toolu_${name}_${Date.now()}`,
    name,
    input,
  };
}

// Helper to build an assistant message with tool_use blocks
function assistantMsg(...blocks: any[]) {
  return {
    type: 'assistant',
    message: { content: blocks },
  };
}

// Helper to build a text block
function textBlock(text: string) {
  return { type: 'text', text };
}

async function startWorkerWithMessages(
  manager: InstanceType<typeof WorkerManager>,
  messages: any[],
  taskOverrides?: Record<string, any>,
  workerId = 'w-team-1',
) {
  mockMessages = [
    { type: 'system', subtype: 'init', session_id: `sess-${workerId}` },
    ...messages,
    { type: 'result', subtype: 'success', session_id: `sess-${workerId}` },
  ];

  const task = makeTask(taskOverrides);

  mockClaimTask.mockImplementation(async () => ({ workers: [{
    id: workerId,
    branch: `buildd/${workerId}`,
    task,
  }] }));

  await manager.claimAndStart(task);
  // Wait for async session to process all messages
  const deadline = Date.now() + 5000;
  while (manager.getWorker(workerId)?.status === 'working' && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 20));
  }
  return manager.getWorker(workerId);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PostToolUse tool activity hook', () => {
  let manager: InstanceType<typeof WorkerManager>;

  afterEach(() => {
    manager?.destroy();
  });

  afterAll(() => {


    cleanupTestWorkspace();


  });


  beforeEach(() => {


    initTestWorkspace();
    lastQueryOpts = null;
    mockMessages = [];
    mockUpdateWorker.mockClear();
    mockClaimTask.mockReset();
    mockClaimTask.mockResolvedValue({ workers: [] });
    mockStreamInputFn.mockClear();
  });

  test('PostToolUse hook is registered alongside PreToolUse', async () => {
    manager = new WorkerManager(makeConfig());

    await startWorkerWithMessages(manager, [
      assistantMsg(textBlock('Done.')),
    ]);

    expect(lastQueryOpts.options.hooks).toBeDefined();
    expect(lastQueryOpts.options.hooks.PreToolUse).toBeDefined();
    expect(lastQueryOpts.options.hooks.PostToolUse).toBeDefined();
    expect(lastQueryOpts.options.hooks.PostToolUse[0].hooks).toHaveLength(1);
  });

  test('no Agent Teams hook or env is wired into the session', async () => {
    // The session env inherits the runner's; isolate from a host that sets it.
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    manager = new WorkerManager(makeConfig());

    await startWorkerWithMessages(manager, [
      assistantMsg(textBlock('Done.')),
    ]);

    expect(lastQueryOpts.options.hooks.TeammateIdle).toBeUndefined();
    expect(lastQueryOpts.options.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined();
    // TaskCompleted fires for any task-list item, so it stays.
    expect(lastQueryOpts.options.hooks.TaskCompleted).toBeDefined();
  });
});
