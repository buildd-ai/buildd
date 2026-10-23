/**
 * Acceptance for spec "Parallelism limits: runner slots and mission cap only"
 * (revision 2), the runner half: the runner decides how much of its own login
 * it uses from the provider's own signals, nothing else.
 *
 *   R-18  a provider warning about the login's limit: no new work on that
 *         provider, running work finishes, resumes when the reset time passes
 *   AC-9  the warning arrives mid-session: the session runs on to completion,
 *         nothing is killed
 */
import { describe, test, expect, mock, setDefaultTimeout, afterAll, beforeEach } from 'bun:test';
import { tmpdir } from 'os';
import { cleanupTestWorkspace } from '../../../runner/__tests__/test-workspace';

setDefaultTimeout(30_000);

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() {
      return { async next() { return { value: undefined, done: true }; } };
    },
  }),
}));

let claimResult: any = { workers: [] };
const mockClaimTask = mock(async () => claimResult);

mock.module('../../../runner/src/buildd', () => ({
  BuilddClient: class {
    claimTask = mockClaimTask;
    updateWorker = mock(async () => ({}));
    sendHeartbeat = mock(async () => ({}));
    getWorkspaceConfig = async () => ({ configStatus: 'unconfigured' });
    getCompactObservations = async () => ({ markdown: '', count: 0 });
    searchObservations = async () => [];
    getBatchObservations = async () => [];
    createObservation = async () => ({});
    listWorkspaces = async () => [];
    runCleanup = async () => ({});
    searchFeedbackMemories = async () => [];
    getWorkerRemote = async () => null;
  },
}));

mock.module('../../../runner/src/workspace', () => ({
  createWorkspaceResolver: () => ({
    resolve: () => null,
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
  copyFileSync: () => {},
  rmSync: () => {},
  statSync: () => ({ size: 0, mtimeMs: 0 }),
}));

mock.module('../../../runner/src/worker-store', () => ({
  saveWorker: () => {},
  loadAllWorkers: () => [],
  loadTerminalWorkersCached: () => [],
  __resetDiskWorkersCache: () => {},
  loadWorker: () => null,
  deleteWorker: () => {},
}));

mock.module('../../../runner/src/skills.js', () => ({ syncSkillToLocal: async () => {} }));

mock.module('../../../runner/src/env-scan', () => ({
  scanEnvironment: () => ({ tools: [], envKeys: [], mcp: [], mcpServers: [] }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  checkBwrapSupport: () => true,
  checkBwrapMountIsolationSupport: () => true,
}));

const { WorkerManager } = await import('../../../runner/src/workers');

const config: any = {
  projectsRoot: '/tmp',
  builddServer: 'http://localhost:3000',
  apiKey: 'test-key',
  maxConcurrent: 3,
  model: 'claude-sonnet-4-5-20250929',
  serverless: false,
};

function runningWorker(): any {
  return {
    id: 'w-claude-1', taskId: 'task-1', taskTitle: 'Test', taskBackend: 'claude', status: 'working',
    output: [], toolCalls: [], commits: [], milestones: [], messages: [], chatMessages: [],
    subagentTasks: [], phaseTools: [], phaseToolCount: 0,
  };
}

/** The SDK's own limit signal about this login (system message, subtype rate_limit). */
const limitEvent = (status: 'allowed_warning' | 'rejected', resetsAt: number) => ({
  type: 'system',
  subtype: 'rate_limit',
  rate_limit_info: { status, rateLimitType: 'five_hour', resetsAt, utilization: 0.92 },
});

describe('provider limit signals', () => {
  let mgr: any;
  let worker: any;
  let aborted: boolean;

  afterAll(() => cleanupTestWorkspace());

  beforeEach(() => {
    mgr = new WorkerManager(config);
    mgr.hasCredentials = true;
    worker = runningWorker();
    aborted = false;
    const abortController = new AbortController();
    abortController.signal.addEventListener('abort', () => { aborted = true; });
    mgr.workers.set(worker.id, worker);
    mgr.sessions.set(worker.id, { abortController, inputStream: { enqueue() {}, end() {} } });
    mockClaimTask.mockClear();
    claimResult = { workers: [] };
  });

  // Control: the harness reaches the real handler. A rejection already pauses claims today.
  test('control: a rejection from the provider pauses new claims', async () => {
    await mgr.handleMessage(worker, limitEvent('rejected', Date.now() + 3_600_000));
    expect(await mgr.claimPendingTasks()).toEqual([]);
    expect(mockClaimTask).not.toHaveBeenCalled();
  });

  test('R-18: a provider warning about the login stops new work on that provider and resumes when the reset time passes', async () => {
    const resetsAt = Date.now() + 3_600_000;
    await mgr.handleMessage(worker, limitEvent('allowed_warning', resetsAt));

    // Before the reset: the runner asks for no new Claude work.
    expect(await mgr.claimPendingTasks()).toEqual([]);
    expect(mockClaimTask).not.toHaveBeenCalled();

    // The provider's reset time passes: claims resume, with no estimate in between.
    const hold = mgr.claimsPausedUntil as number;
    expect(hold).toBeGreaterThanOrEqual(resetsAt - 1000);
    expect(hold).toBeLessThanOrEqual(resetsAt + 1000);
    mgr.claimsPausedUntil = Date.now() - 1;
    await mgr.claimPendingTasks();
    expect(mockClaimTask).toHaveBeenCalledTimes(1);
  });

  test('AC-9: a provider warning mid-session lets the session run on; nothing is killed', async () => {
    await mgr.handleMessage(worker, limitEvent('allowed_warning', Date.now() + 3_600_000));

    expect(aborted).toBe(false);
    expect(worker.status).toBe('working');
    expect(worker.error).toBeUndefined();
    // And it still stops new work, so the session is the only thing running on.
    expect(await mgr.claimPendingTasks()).toEqual([]);
    expect(mockClaimTask).not.toHaveBeenCalled();
  });
});
