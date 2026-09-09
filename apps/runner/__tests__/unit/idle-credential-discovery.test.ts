/**
 * Regression: an idle-but-online runner never discovered its own credentials.
 *
 * The credential broker only learned which secrets it manages by piggybacking
 * on a claim response's PER-WORKER `pendingCredentialRefreshes`. A runner that
 * is up but has nothing to claim gets `workers: []`, so nothing was announced,
 * `broker.managed` stayed empty, and `refreshExpiring()` iterated over nothing
 * — the credentials it is responsible for aged out untouched. (A synthetic task
 * that manufactured a claim purely to trigger the piggyback was the workaround.)
 *
 * The server now also announces at the TOP LEVEL of every claim response. This
 * file covers the runner half: the poll path must read that field before its
 * empty-claim early return.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/idle-credential-discovery.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { LocalUIConfig } from '../../src/types';

// ─── Mocks (must precede importing workers.ts) ──────────────────────────────

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
  saveWorker: mock(() => {}),
  loadAllWorkers: () => [],
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

describe('idle runner credential discovery', () => {
  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(() => {
    mockNotifyBrokerCredentials.mockClear();
    mockClaimTask.mockReset();
    mockUpdateWorker.mockReset();
    mockUpdateWorker.mockImplementation(async () => ({}));
    mockSendHeartbeat.mockReset();
    mockSendHeartbeat.mockImplementation(async () => ({}));
  });

  afterEach(() => {
    manager?.destroy();
  });

  // THE case: nothing claimed, so the per-worker field cannot exist.
  test('announces top-level credentials on a poll that claims zero workers', async () => {
    mockClaimTask.mockImplementation(async () => ({
      workers: [],
      diagnostics: { reason: 'no_pending_tasks' },
      pendingCredentialRefreshes: announcement,
    }));

    manager = new WorkerManager(makeConfig());
    const started = await manager.claimPendingTasks();

    expect(started).toHaveLength(0);
    expect(mockNotifyBrokerCredentials).toHaveBeenCalledTimes(1);
    expect(mockNotifyBrokerCredentials.mock.calls[0][0]).toEqual(announcement);
  });

  test('announces nothing when the server sent no top-level field', async () => {
    mockClaimTask.mockImplementation(async () => ({
      workers: [],
      diagnostics: { reason: 'no_pending_tasks' },
    }));

    manager = new WorkerManager(makeConfig());
    await manager.claimPendingTasks();

    expect(mockNotifyBrokerCredentials).not.toHaveBeenCalled();
  });

  test('an empty announcement is not forwarded as a no-op notify', async () => {
    mockClaimTask.mockImplementation(async () => ({
      workers: [],
      diagnostics: { reason: 'no_slots' },
      pendingCredentialRefreshes: [],
    }));

    manager = new WorkerManager(makeConfig());
    await manager.claimPendingTasks();

    expect(mockNotifyBrokerCredentials).not.toHaveBeenCalled();
  });
});
