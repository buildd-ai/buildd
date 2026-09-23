/**
 * A repo task must never run outside a git checkout.
 *
 * What used to happen: a role packaged as `service` (which is every role saved
 * from the dashboard editor, since it never sends repoUrl) sent the session cwd
 * to `~/.buildd/roles/<slug>`. That is not a git directory, so `setupWorktree`
 * failed, the fallback logged "Worktree failed, using repo" — naming a repo it
 * was not in — and the agent then spent a whole budget in a directory holding
 * none of the task's code. The failure looked like an agent that could not find
 * anything, not like a misrouted cwd.
 *
 * `resolveRoleCwd` fixes the cause (role-cwd-resolution.test.ts); this is the
 * backstop for any other way of arriving somewhere without a `.git`.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { LocalUIConfig } from '../../src/types';

let sessionStarted = false;
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    sessionStarted = true;
    return {
      streamInput: mock(() => {}),
      supportedModels: async () => [],
      [Symbol.asyncIterator]: () => ({ async next() { return { value: undefined, done: true }; } }),
    };
  },
}));

/** null = `git worktree add` failed and the session falls back to the clone. */
let worktreeResult: { path: string; branch: string; base: string } | null = null;
mock.module('../../src/git-operations', () => ({
  setupWorktree: async () => worktreeResult,
  removeWorktreeIfUnowned: async () => ({ removed: true }),
  removeWorktreeIfUnownedSync: () => ({ removed: true }),
  cleanupWorktree: async () => ({ removed: true }),
  collectGitStats: async () => ({}),
}));

const mockUpdateWorker = mock(async (_id: string, _patch: any) => ({}));
const mockClaimTask = mock(async () => ({ workers: [] as any[] }));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mockUpdateWorker;
    claimTask = mockClaimTask;
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
    subscribe() { return { bind: () => {} }; }
    unsubscribe() {}
    disconnect() {}
  },
}));

/** Whether the session cwd looks like a git checkout. */
let cwdIsGitRepo = true;
mock.module('fs', () => ({
  existsSync: (p: string) => (String(p).endsWith('/.git') ? cwdIsGitRepo : false),
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

mock.module('../../src/roles', () => ({
  getRoleDir: (slug: string) => `/tmp/roles/${slug}`,
  syncRoleToLocal: async () => ({ cwd: '/tmp/roles/builder' }),
  overlayRoleFiles: async () => {},
  resolveRoleEnv: async () => ({ resolved: {}, missing: [] }),
  resolveRoleCwd: async (_rc: any, _t: any, workspacePath: string) => ({ cwd: workspacePath }),
  buildRoleSystemPromptSection: () => '',
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

async function runTask(manager: InstanceType<typeof WorkerManager>, repo: string | null, workerId: string, settleMs = 250) {
  const task = {
    id: `task-${workerId}`,
    title: 'Repo task',
    description: 'do work',
    workspaceId: 'ws-1',
    workspace: { name: 'test-workspace', repo },
    status: 'waiting',
    priority: 1,
  };
  mockClaimTask.mockImplementation(async () => ({ workers: [{
    id: workerId,
    branch: `buildd/${workerId}`,
    task,
  }] }));
  await manager.claimAndStart(task as any);
  await new Promise(r => setTimeout(r, settleMs));
}

/** The status:'failed' PATCH this worker reported, if any. */
function failurePatch(workerId: string) {
  return mockUpdateWorker.mock.calls
    .filter(([id, patch]: any) => id === workerId && patch?.status === 'failed')
    .map(([, patch]: any) => patch)[0];
}

describe('session cwd must be a git checkout for a repo task', () => {
  let manager: InstanceType<typeof WorkerManager>;

  beforeEach(() => {
    sessionStarted = false;
    cwdIsGitRepo = true;
    worktreeResult = null;
    mockUpdateWorker.mockClear();
    manager = new WorkerManager(makeConfig());
  });

  afterEach(() => {
    manager?.destroy?.();
  });

  test('fails the worker instead of running in a directory with no .git', async () => {
    cwdIsGitRepo = false;
    await runTask(manager, 'acme/widgets', 'w-nogit');

    expect(sessionStarted).toBe(false);
    const patch = failurePatch('w-nogit');
    expect(patch).toBeDefined();
    // The error has to name the directory: the whole point is that "worktree
    // failed, using repo" told the operator nothing about where it ended up.
    expect(patch.error).toContain('not a git checkout');
    expect(patch.error).toContain('/tmp/test-workspace');
  });

  test('starts normally when the cwd is a git checkout', async () => {
    await runTask(manager, 'acme/widgets', 'w-git');

    expect(sessionStarted).toBe(true);
    expect(failurePatch('w-git')).toBeUndefined();
  });

  // A coordination workspace has no repo and is not expected to be a checkout.
  test('does not apply to a workspace with no repo', async () => {
    cwdIsGitRepo = false;
    await runTask(manager, null, 'w-norepo');

    expect(sessionStarted).toBe(true);
    expect(failurePatch('w-norepo')).toBeUndefined();
  });

  test('does not fire when the cwd IS a checkout, whatever the worktree did', async () => {
    worktreeResult = { path: '/tmp/worktrees/w-wt', branch: 'buildd/w-wt', base: 'origin/main' };
    await runTask(manager, 'acme/widgets', 'w-wt');

    expect(failurePatch('w-wt')).toBeUndefined();
  });
});

// `git worktree add` just made the path it returns, so it is a checkout by
// construction; probing for a `.git` entry there could only produce false
// alarms on a slow or unusual filesystem. Pinned on the source because the
// branch is reached only when the SDK session is already under way, which this
// file's harness deliberately does not carry far enough to observe.
describe('the guard is scoped to a cwd git did not produce', () => {
  const src = Bun.file(new URL('../../src/workers.ts', import.meta.url).pathname);

  test('skips the probe when setupWorktree produced the cwd', async () => {
    expect(await src.text()).toContain('hasRepo && !worktreeCreated && !existsSync(join(sessionCwd');
  });
});
