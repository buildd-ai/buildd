/**
 * Regression: a throw while starting one claimed worker orphaned every worker
 * behind it in the same claim batch.
 *
 * 2026-08-28 prod shape: a single claim response carried 3 worker rows (created
 * within 53ms of each other). The runner started row 1, then threw while
 * preparing row 2 — the exception escaped the `for (const claimedWorker of
 * claimed)` loop into the outer catch, so rows 2 and 3 were never started and
 * never reported. They sat with started_at NULL until the stale-worker reaper
 * killed them ~12 minutes later and booked them as infra failures, while their
 * tasks stayed 'assigned' for the whole window.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/claim-orphan-guard.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { LocalUIConfig } from '../../src/types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

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

// The resolver throws for one workspace only — a realistic in-loop failure
// (path resolution touches the filesystem).
mock.module('../../src/workspace', () => ({
  createWorkspaceResolver: () => ({
    resolve: (ws: any) => {
      if (ws?.name === 'boom-workspace') throw new Error('EACCES: cannot stat projects root');
      return '/tmp/test-workspace';
    },
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

function claimedWorker(id: string, workspaceName: string) {
  return {
    id,
    branch: `buildd/${id}`,
    task: {
      id: `task-${id}`,
      title: `Task for ${id}`,
      description: 'work',
      workspaceId: `ws-${id}`,
      workspace: { name: workspaceName },
      status: 'pending',
      priority: 0,
    },
  };
}

describe('claim batch start failures', () => {
  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(() => {
    mockUpdateWorker.mockReset();
    mockUpdateWorker.mockImplementation(async () => ({}));
    mockClaimTask.mockReset();
    mockSendHeartbeat.mockReset();
    mockSendHeartbeat.mockImplementation(async () => ({}));
  });

  afterEach(() => {
    manager?.destroy();
  });

  test('a start failure on one claimed worker does not orphan the rest of the batch', async () => {
    mockClaimTask.mockImplementation(async () => ({
      workers: [
        claimedWorker('w-boom', 'boom-workspace'),
        claimedWorker('w-ok', 'good-workspace'),
      ],
    }));

    manager = new WorkerManager(makeConfig());
    const started = await manager.claimPendingTasks();

    // The healthy worker behind the failure still started.
    expect(started.map(w => w.id)).toContain('w-ok');
    expect(manager.getWorker('w-ok')).toBeDefined();
  });

  test('reports the failed worker to the server instead of leaving it unstarted', async () => {
    mockClaimTask.mockImplementation(async () => ({
      workers: [
        claimedWorker('w-boom', 'boom-workspace'),
        claimedWorker('w-ok', 'good-workspace'),
      ],
    }));

    manager = new WorkerManager(makeConfig());
    await manager.claimPendingTasks();

    const failCall = mockUpdateWorker.mock.calls.find(
      (c: any[]) => c[0] === 'w-boom' && c[1]?.status === 'failed',
    );
    expect(failCall).toBeDefined();
    expect((failCall as any[])[1].error).toContain('EACCES');
  });
});
