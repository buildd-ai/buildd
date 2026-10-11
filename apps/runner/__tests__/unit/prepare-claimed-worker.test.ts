/**
 * The two claim entry points — the Pusher nudge (claimAndStart) and the poll
 * (claimPendingTasks → startClaimedWorker) — used to prepare a claimed worker
 * with two hand-copied blocks that drifted: the Pusher path never announced the
 * per-worker credentials to the broker, and the poll path never marked an
 * unresolvable task, so a later Pusher nudge re-claimed it.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/prepare-claimed-worker.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach , afterAll } from 'bun:test';
import { tmpdir } from 'os';
import { initTestWorkspace, getTestWorkspace, cleanupTestWorkspace } from '../test-workspace';
import type { LocalUIConfig } from '../../src/types';
import { clearCloneThrottles, noteCloneThrottled } from '../../src/git-clone';

// ─── Mocks (must precede importing workers.ts) ──────────────────────────────

let mockResolve: () => string | null = () => getTestWorkspace();

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() {
      return { async next() { return { value: undefined, done: true }; } };
    },
  }),
}));

mock.module('pusher-js', () => ({
  default: class MockPusher {
    connection = { bind: () => {} };
    subscribe = () => ({ bind: () => {}, unbind_all: () => {}, unbind: () => {} });
    unsubscribe = () => {};
    disconnect = () => {};
  },
}));

/** The subject: what the runner tells its credential broker. */
const mockNotifyBrokerCredentials = mock((_entries: any[]) => {});

mock.module('../../src/broker', () => ({
  notifyBrokerCredentials: mockNotifyBrokerCredentials,
  fetchTokenFromBroker: mock(async () => null),
  getBrokerSocketPath: () => '/tmp/buildd-broker-test.sock',
  credentialBroker: {
    start: mock(() => {}),
    stop: mock(() => {}),
    notifyCredentials: mockNotifyBrokerCredentials,
    refreshExpiring: mock(async () => {}),
    managedSecretIds: () => [],
  },
}));

const mockUpdateWorker = mock(async () => ({}));
const mockClaimTask = mock(async () => ({ workers: [] as any[] }));
const mockSendHeartbeat = mock(async () => ({}));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mockUpdateWorker;
    claimTask = mockClaimTask;
    sendHeartbeat = mockSendHeartbeat;
    getWorkspaceConfig = mock(async () => ({ configStatus: 'unconfigured' }));
    getCompactObservations = mock(async () => ({ markdown: '', count: 0 }));
    searchObservations = mock(async () => []);
    getBatchObservations = mock(async () => []);
    createObservation = mock(async () => ({}));
    listWorkspaces = mock(async () => []);
    runCleanup = mock(async () => ({}));
    searchFeedbackMemories = mock(async () => []);
    getWorkerRemote = mock(async () => null);
  },
}));

mock.module('../../src/workspace', () => ({
  createWorkspaceResolver: () => ({
    resolve: () => mockResolve(),
    debugResolve: () => ({}),
    listLocalDirectories: () => [],
    getPathOverrides: () => ({}),
    setPathOverride: () => {},
    scanGitRepos: () => [],
    getProjectRoots: () => [tmpdir()],
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
  saveWorker: mock(() => {}),
  loadAllWorkers: () => [],
  loadTerminalWorkersCached: () => [],
  __resetDiskWorkersCache: () => {},
  loadWorker: () => null,
  deleteWorker: mock(() => {}),
}));

mock.module('../../src/skills.js', () => ({
  syncSkillToLocal: async () => {},
}));

mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ tools: [], envKeys: [], mcp: [] }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  parseMcpJson: () => [],
  scanMcpServersRich: () => [],
  checkBwrapSupport: () => true,
  checkBwrapMountIsolationSupport: () => true,
}));

const { WorkerManager } = await import('../../src/workers');

function makeConfig(overrides?: Partial<LocalUIConfig>): LocalUIConfig {
  return {
    projectsRoot: '/tmp',
    builddServer: 'http://localhost:3000',
    apiKey: 'test-key',
    maxConcurrent: 3,
    model: 'claude-sonnet-4-5-20250929',
    serverless: true,
    acceptRemoteTasks: true,
    ...overrides,
  } as LocalUIConfig;
}

const announcement = [
  { secretId: 'sec-1', purpose: 'claude_credential' as const, expiresAt: '2026-09-03T10:00:00.000Z' },
];

function claimed(id: string) {
  return {
    id,
    branch: `buildd/${id}`,
    task: { id: `task-${id}`, title: 'T', workspaceId: 'ws-1', workspace: { name: 'ws', repo: 'https://example.test/o/r' } },
    pendingCredentialRefreshes: announcement,
  };
}

describe('prepareClaimedWorker: Pusher and poll claims prepare a worker the same way', () => {
  let manager: InstanceType<typeof WorkerManager>;
  let startFromClaim: ReturnType<typeof mock>;

  afterAll(() => {


    cleanupTestWorkspace();


  });


  beforeEach(() => {


    initTestWorkspace();
    mockResolve = () => getTestWorkspace();
    mockNotifyBrokerCredentials.mockClear();
    mockClaimTask.mockReset();
    mockUpdateWorker.mockReset();
    mockUpdateWorker.mockImplementation(async () => ({}));
    mockSendHeartbeat.mockReset();
    mockSendHeartbeat.mockImplementation(async () => ({}));
    manager = new WorkerManager(makeConfig());
    startFromClaim = mock(async (cw: any) => ({ id: cw.id }));
    (manager as any).startFromClaim = startFromClaim;
  });

  afterEach(() => {
    manager?.destroy();
  });

  test('Pusher claim (claimAndStart) announces the per-worker credentials to the broker', async () => {
    mockClaimTask.mockImplementation(async () => ({ workers: [claimed('w-push')] }));
    const task = { id: 'task-w-push', title: 'T', workspaceId: 'ws-1' } as any;

    const worker = await manager.claimAndStart(task);

    expect(worker).not.toBeNull();
    expect(mockNotifyBrokerCredentials).toHaveBeenCalledWith(announcement);
    expect(startFromClaim).toHaveBeenCalledTimes(1);
  });

  test('poll claim with an unresolvable workspace marks the task so Pusher stops retrying it', async () => {
    mockResolve = () => null;
    mockClaimTask.mockImplementation(async () => ({ workers: [claimed('w-poll')] }));
    const markUnresolvable = mock((_id: string) => {});
    (manager as any).pusherManager.markUnresolvable = markUnresolvable;

    const started = await manager.claimPendingTasks();

    expect(started).toHaveLength(0);
    expect(markUnresolvable).toHaveBeenCalledWith('task-w-poll');
    expect(mockUpdateWorker).toHaveBeenCalledWith('w-poll', expect.objectContaining({ status: 'failed' }));
    expect(startFromClaim).not.toHaveBeenCalled();
  });

  test('poll claim still announces per-worker credentials and starts', async () => {
    mockClaimTask.mockImplementation(async () => ({ workers: [claimed('w-ok')] }));

    const started = await manager.claimPendingTasks();

    expect(started).toHaveLength(1);
    expect(mockNotifyBrokerCredentials).toHaveBeenCalledWith(announcement);
  });

  test('Pusher claim with an unresolvable workspace still throws workspace_not_found', async () => {
    mockResolve = () => null;
    mockClaimTask.mockImplementation(async () => ({ workers: [claimed('w-push2')] }));
    const markUnresolvable = mock((_id: string) => {});
    (manager as any).pusherManager.markUnresolvable = markUnresolvable;

    let caught: any;
    try { await manager.claimAndStart({ id: 'task-w-push2', title: 'T', workspaceId: 'ws-1' } as any); } catch (e) { caught = e; }

    expect(caught?.claimError).toBe('workspace_not_found');
    expect(markUnresolvable).toHaveBeenCalledWith('task-w-push2');
  });

  // The clone failed because GitHub throttled it (git-clone.ts remembers the
  // repo). That is not "this runner cannot resolve the workspace": report it
  // as an infrastructure failure so buildd requeues with backoff, and do not
  // stop Pusher from offering the task again.
  describe('a clone GitHub throttled', () => {
    beforeEach(() => clearCloneThrottles());
    afterEach(() => clearCloneThrottles());

    test('poll claim: failed with githubThrottled, awaited, not marked unresolvable', async () => {
      mockResolve = () => null;
      noteCloneThrottled('https://example.test/o/r', 30);
      let settled = false;
      mockUpdateWorker.mockImplementation(async () => { await new Promise(r => setTimeout(r, 5)); settled = true; return {}; });
      mockClaimTask.mockImplementation(async () => ({ workers: [claimed('w-thr')] }));
      const markUnresolvable = mock((_id: string) => {});
      (manager as any).pusherManager.markUnresolvable = markUnresolvable;

      const started = await manager.claimPendingTasks();

      expect(started).toHaveLength(0);
      expect(mockUpdateWorker).toHaveBeenCalledWith('w-thr', expect.objectContaining({ status: 'failed', githubThrottled: true }));
      const body = mockUpdateWorker.mock.calls.find((c: any[]) => c[0] === 'w-thr')![1] as { error: string };
      expect(body.error).toMatch(/rate limit/i);
      // A --once container exits right after this; the report must be out first.
      expect(settled).toBe(true);
      expect(markUnresolvable).not.toHaveBeenCalled();
    });

    test('Pusher claim: throws github_throttled', async () => {
      mockResolve = () => null;
      noteCloneThrottled('https://example.test/o/r', null);
      mockClaimTask.mockImplementation(async () => ({ workers: [claimed('w-thr2')] }));
      let caught: any;
      try { await manager.claimAndStart({ id: 'task-w-thr2', title: 'T', workspaceId: 'ws-1' } as any); } catch (e) { caught = e; }
      expect(caught?.claimError).toBe('github_throttled');
      expect(mockUpdateWorker).toHaveBeenCalledWith('w-thr2', expect.objectContaining({ githubThrottled: true }));
    });
  });
});
