/**
 * Unit tests: non-2xx claimTask responses must be logged + emitted
 *
 * Bug: when BuilddClient.claimTask() throws (422, 500, …) the runner was
 * completely silent — no claims.log entry, no UI event. Only the outer
 * pusher-manager catch wrote a bare console.error.
 *
 * Run: bun test apps/runner/__tests__/unit/claim-rejected.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { LocalUIConfig } from '../../src/types';

// ─── Spy on claimLog directly ─────────────────────────────────────────────────

const claimLogSpy = mock((_entry: any) => {});

mock.module('../../src/session-logger', () => ({
  claimLog: claimLogSpy,
  sessionLog: () => {},
  readSessionLogs: () => [],
  cleanupOldLogs: () => {},
  readClaimLogs: () => [],
}));

// ─── Standard module mocks ────────────────────────────────────────────────────

mock.module('pusher-js', () => ({
  default: class MockPusher {
    connection = { bind: () => {} };
    subscribe = () => ({ bind: () => {}, unbind_all: () => {}, unbind: () => {} });
    unsubscribe = () => {};
    disconnect = () => {};
  },
}));

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (_opts: any) => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { value: undefined, done: true };
        },
      };
    },
  }),
}));

const mockClaimTask = mock(async () => ({ workers: [{ id: 'w-1', branch: 'buildd/test', task: null }] }));
const mockUpdateWorker = mock(async () => ({}));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    claimTask = mockClaimTask;
    updateWorker = mockUpdateWorker;
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
  scanEnvironment: () => ({ tools: [], envKeys: [], mcp: [] }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  parseMcpJson: () => [],
  scanMcpServersRich: () => [],
  checkBwrapSupport: () => true,
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

const { WorkerManager } = await import('../../src/workers');

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function makeTask() {
  return {
    id: 'task-42',
    title: 'Test task',
    description: 'Do something',
    workspaceId: 'ws-1',
    workspace: { name: 'test-workspace' },
    status: 'waiting',
    priority: 1,
  };
}

function collectEvents(manager: InstanceType<typeof WorkerManager>) {
  const events: any[] = [];
  manager.onEvent((e: any) => events.push(e));
  return events;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('claim_rejected logging', () => {
  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(() => {
    claimLogSpy.mockClear();
    mockClaimTask.mockReset();
    mockUpdateWorker.mockReset();
    mockUpdateWorker.mockImplementation(async () => ({}));
  });

  afterEach(() => {
    manager?.destroy();
  });

  test('422 API error writes claim_rejected log entry and rethrows', async () => {
    mockClaimTask.mockImplementation(async () => {
      throw new Error('API error: 422 - {"error":"routing_mismatch","detail":"role not available"}');
    });

    manager = new WorkerManager(makeConfig());
    const events = collectEvents(manager);

    await expect(manager.claimAndStart(makeTask())).rejects.toThrow('API error: 422');

    const calls = claimLogSpy.mock.calls;
    const rejectedCall = calls.find((args: any[]) => args[0]?.event === 'claim_rejected');
    expect(rejectedCall).toBeDefined();
    const entry = rejectedCall![0];
    expect(entry.status).toBe(422);
    expect(entry.reason).toBe('routing_mismatch');
    expect(entry.taskId).toBe('task-42');

    const rejectedEvent = events.find(e => e.type === 'claim_rejected');
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent.status).toBe(422);
    expect(rejectedEvent.reason).toBe('routing_mismatch');
  });

  test('500 API error writes claim_rejected with status 500 and rethrows', async () => {
    mockClaimTask.mockImplementation(async () => {
      throw new Error('API error: 500 - Internal Server Error');
    });

    manager = new WorkerManager(makeConfig());

    await expect(manager.claimAndStart(makeTask())).rejects.toThrow('API error: 500');

    const calls = claimLogSpy.mock.calls;
    const rejectedCall = calls.find((args: any[]) => args[0]?.event === 'claim_rejected');
    expect(rejectedCall).toBeDefined();
    const entry = rejectedCall![0];
    expect(entry.status).toBe(500);
    expect(entry.taskId).toBe('task-42');
  });

  test('200 with workers:[] still writes claim_empty (regression guard)', async () => {
    mockClaimTask.mockImplementation(async () => ({
      workers: [],
      diagnostics: { reason: 'no_slots' },
    }));

    manager = new WorkerManager(makeConfig());

    await expect(manager.claimAndStart(makeTask())).rejects.toThrow('Server rejected claim');

    const calls = claimLogSpy.mock.calls;
    const emptyCall = calls.find((args: any[]) => args[0]?.event === 'claim_empty');
    expect(emptyCall).toBeDefined();
    expect(emptyCall![0].diagnosticReason).toBe('no_slots');

    // No spurious claim_rejected entry on a 200 response
    const rejectedCall = calls.find((args: any[]) => args[0]?.event === 'claim_rejected');
    expect(rejectedCall).toBeUndefined();
  });
});
