/**
 * Reconcile and purge must stop a live session WITHOUT skipping its cleanup.
 *
 * startSession's finally only runs its per-worker cleanup — the per-worker
 * CLAUDE_CONFIG_DIR holding the materialized access token, the Codex auth dir,
 * the broker registration, the CBM dirs — while the session's map entry is
 * still present, and deletes the entry itself. Aborting a session AND deleting
 * its entry (teardownSession) therefore leaked every one of those, and sent the
 * abort down the catch path's failure arm. reapSession is the right tool.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/reconcile-reap-cleanup.test.ts
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { LocalUIConfig } from '../../src/types';
import * as realGitOps from '../../src/git-operations';

// An SDK stream that stays open until its abort controller fires — a session
// that is still running when reconcile/purge reaches it.
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: any) => {
    const signal: AbortSignal | undefined = opts?.options?.abortController?.signal;
    let sentInit = false;
    return {
      streamInput: mock(() => {}),
      supportedModels: async () => [],
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (!sentInit) {
              sentInit = true;
              return { value: { type: 'system', subtype: 'init', session_id: 'sess-reap' }, done: false };
            }
            await new Promise<void>(resolve => {
              if (!signal || signal.aborted) return resolve();
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
            throw new Error('Operation aborted');
          },
        };
      },
    };
  },
}));

const mockCleanupClaudeConfigDir = mock((_id: string, _dir: string) => {});
mock.module('../../src/claude-auth', () => ({
  materializeClaudeConfigDir: () => ({ claudeConfigDir: '/tmp/fake-claude-config' }),
  cleanupClaudeConfigDir: mockCleanupClaudeConfigDir,
  staleResumeCredentialError: () => null,
  buildClaudeCredentialsFile: () => ({}),
  isolatedClaudeConfigDirPath: () => '/tmp/fake-claude-config',
}));

const mockUpdateWorker = mock(async (_id: string, _payload: any) => ({}));
const mockClaimTask = mock(async () => ({ workers: [] as any[] }));
const mockGetWorkerRemote = mock(async (_id: string) => null as any);

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mockUpdateWorker;
    claimTask = mockClaimTask;
    getWorkerRemote = mockGetWorkerRemote;
    getWorkspaceConfig = mock(async () => ({ configStatus: 'unconfigured' }));
    getCompactObservations = mock(async () => ({ markdown: '', count: 0 }));
    searchObservations = mock(async () => []);
    getBatchObservations = mock(async () => []);
    createObservation = mock(async () => ({}));
    listWorkspaces = mock(async () => []);
    sendHeartbeat = mock(async () => ({}));
    runCleanup = mock(async () => ({}));
    searchFeedbackMemories = mock(async () => []);
    setOutbox() {}
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
    subscribe() { return { bind: () => {} }; }
    unsubscribe() {}
    disconnect() {}
  },
}));

mock.module('fs', () => ({
  existsSync: (p: string) => String(p).endsWith('/.git'),
  readFileSync: () => '{}',
  writeFileSync: () => {},
  mkdirSync: () => {},
  chmodSync: () => {},
  unlinkSync: () => {},
  renameSync: () => {},
  readdirSync: () => [],
  appendFileSync: () => {},
  statSync: () => ({ size: 0, mtimeMs: 0 }),
  copyFileSync: () => {},
  rmSync: () => {},
}));

mock.module('../../src/git-operations', () => ({
  ...realGitOps,
  setupWorktree: async (_repo: string, branch: string) => ({ path: '/tmp/test-workspace', branch, base: 'origin/main' }),
  removeWorktreeIfUnowned: async () => {},
}));

mock.module('../../src/worker-store', () => ({
  saveWorker: () => {},
  loadAllWorkers: () => [],
  loadTerminalWorkersCached: () => [],
  __resetDiskWorkersCache: () => {},
  loadWorker: () => null,
  deleteWorker: () => {},
}));

mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ platform: 'linux', arch: 'x64', tools: [], envKeys: [], mcp: [], mcpServers: [], labels: { type: 'local', os: 'linux', arch: 'x64', hostname: 'test' }, scannedAt: new Date(0).toISOString() }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  parseMcpJson: () => [],
  scanMcpServersRich: () => [],
  checkBwrapSupport: () => true,
  checkBwrapMountIsolationSupport: () => true,
}));

mock.module('../../src/history-store', () => ({
  archiveSession: () => {},
  initHistoryStore: () => {},
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

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise(r => setTimeout(r, 10));
  }
}

/** Claims a task and waits until its session is live (entry in the map). */
async function startLiveSession(manager: any, workerId: string): Promise<void> {
  const task = {
    id: `task-${workerId}`,
    title: 'Reap cleanup task',
    description: 'stay running',
    workspaceId: 'ws-1',
    workspace: { name: 'test-workspace', repo: 'acme/widgets' },
    status: 'waiting',
    priority: 1,
  };
  mockClaimTask.mockImplementation(async () => ({ workers: [{
    id: workerId,
    branch: `buildd/${workerId}`,
    task,
    claudeAccessToken: 'fixture-token',
  }] }));
  await manager.claimAndStart(task as any);
  await waitFor(() => manager.sessions.has(workerId) && manager.getWorker(workerId)?.sessionId === 'sess-reap');
}

function failedPatches(workerId: string) {
  return mockUpdateWorker.mock.calls.filter(([id, payload]) => id === workerId && payload?.status === 'failed');
}

describe('stopping a live session runs its own cleanup', () => {
  let manager: any;

  beforeEach(() => {
    mockCleanupClaudeConfigDir.mockClear();
    mockUpdateWorker.mockClear();
    mockGetWorkerRemote.mockReset();
    manager = new WorkerManager(makeConfig());
  });

  afterEach(() => {
    manager?.destroy?.();
  });

  test('reconcile on a confirmed 404 removes the per-worker Claude config dir', async () => {
    await startLiveSession(manager, 'w-reap-404');
    mockGetWorkerRemote.mockResolvedValue(null);

    await manager.reconcileLocalWorkers();
    await waitFor(() => !manager.sessions.has('w-reap-404'));

    expect(mockCleanupClaudeConfigDir).toHaveBeenCalledWith('w-reap-404', '/tmp/fake-claude-config');
    // The abort is cleanup, not an outcome: no `failed` PATCH for a worker
    // the server already said does not exist.
    expect(failedPatches('w-reap-404')).toHaveLength(0);
    expect(manager.getWorker('w-reap-404')?.status).toBe('error');
  });

  test('reconcile on a remote-terminal worker removes the per-worker Claude config dir', async () => {
    await startLiveSession(manager, 'w-reap-term');
    mockGetWorkerRemote.mockResolvedValue({ status: 'completed', task: { status: 'completed' } });

    await manager.reconcileLocalWorkers();
    await waitFor(() => !manager.sessions.has('w-reap-term'));

    expect(mockCleanupClaudeConfigDir).toHaveBeenCalledWith('w-reap-term', '/tmp/fake-claude-config');
    expect(failedPatches('w-reap-term')).toHaveLength(0);
    expect(manager.getWorker('w-reap-term')?.status).toBe('done');
  });

  test('purgeCompleted removes the per-worker Claude config dir of a purged live session', async () => {
    await startLiveSession(manager, 'w-reap-purge');
    // Terminal locally, session still running (e.g. hung after complete_task).
    manager.getWorker('w-reap-purge').status = 'done';

    manager.purgeCompleted();
    await waitFor(() => !manager.sessions.has('w-reap-purge'));

    expect(mockCleanupClaudeConfigDir).toHaveBeenCalledWith('w-reap-purge', '/tmp/fake-claude-config');
    expect(failedPatches('w-reap-purge')).toHaveLength(0);
  });
});
