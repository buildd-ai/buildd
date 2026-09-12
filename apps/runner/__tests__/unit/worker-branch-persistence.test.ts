import { describe, expect, mock, test, beforeEach } from 'bun:test';

const CLAIMED_BRANCH = 'mission/example-integration';
const ACTUAL_BRANCH = 'buildd/example-task';
const cleanup = mock(async () => {});
const setup = mock(async () => ({ path: '/tmp/example-worktree', branch: ACTUAL_BRANCH, base: `origin/${CLAIMED_BRANCH}` }));
mock.module('../../src/git-operations', () => ({
  setupWorktree: setup, cleanupWorktree: cleanup, collectGitStats: async () => ({}),
}));
mock.module('../../src/worker-store', () => ({
  saveWorker: () => {}, loadAllWorkers: () => [], loadWorker: () => null, deleteWorker: () => {},
}));
mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({}), checkMcpPreFlight: () => ({ warnings: [] }),
  parseMcpJson: () => [], scanMcpServersRich: () => [],
  checkBwrapSupport: () => true, checkBwrapMountIsolationSupport: () => true,
}));
const { WorkerManager } = await import('../../src/workers');

function harness(update: (id: string, payload: any) => Promise<any>) {
  // Exercise the real claim-to-session startup without constructor timers or SDK execution.
  const manager = Object.create(WorkerManager.prototype) as any;
  Object.assign(manager, {
    workers: new Map(), workerTeamKeys: new Map(), credCache: new Map(),
    config: {}, buildd: { updateWorker: mock(update) },
    sendHeartbeat: () => {}, emit: () => {}, addMilestone: () => {},
    pusherManager: { subscribeToWorker: () => {} },
    startSession: mock(async () => {}),
  });
  const start = () => manager.startFromClaim(
    { id: 'worker-test', branch: CLAIMED_BRANCH },
    { id: 'task-test', title: 'Example', workspaceId: 'workspace-test', workspace: { name: 'Example', repo: 'https://github.com/example/repo', gitConfig: { defaultBranch: 'dev' } } },
    '/tmp/example-repo',
  );
  return { manager, start };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
beforeEach(() => {
  cleanup.mockClear();
  setup.mockReset();
  setup.mockResolvedValue({ path: '/tmp/example-worktree', branch: ACTUAL_BRANCH, base: `origin/${CLAIMED_BRANCH}` });
});

describe('actual checkout branch is persisted before agent startup', () => {
  test('waits for the branch PATCH before starting the session', async () => {
    let acknowledge!: (value: any) => void;
    const pending = new Promise(resolve => { acknowledge = resolve; });
    const { manager, start } = harness(async () => pending);
    const starting = start();
    await settle();
    expect(manager.buildd.updateWorker).toHaveBeenCalledWith('worker-test', { branch: ACTUAL_BRANCH });
    expect(manager.startSession).not.toHaveBeenCalled();
    acknowledge({ branch: ACTUAL_BRANCH });
    await starting;
    await settle();
    expect(manager.startSession).toHaveBeenCalledTimes(1);
    expect(manager.startSession.mock.calls[0][0].branch).toBe(ACTUAL_BRANCH);
  });

  test('retries a retryable CAS conflict before starting', async () => {
    let writes = 0;
    const { manager, start } = harness(async () => ++writes === 1
      ? { conflict: true, retryable: true }
      : { branch: ACTUAL_BRANCH });
    await start();
    await settle();
    expect(writes).toBe(2);
    expect(manager.startSession).toHaveBeenCalledTimes(1);
  });

  for (const [label, response] of [
    ['aborted worker', { abort: true, reason: 'Worker terminated' }],
    ['exhausted conflicts', { conflict: true, retryable: true }],
    ['corrupted branch', { branch: '[REDACTED:credential]' }],
  ] as const) {
    test(`does not start with ${label}`, async () => {
      const { manager, start } = harness(async (_id, payload) => payload.branch ? response : {});
      await start();
      await settle();
      expect(manager.startSession).not.toHaveBeenCalled();
      expect(manager.workers.get('worker-test').status).toBe('error');
      expect(cleanup).toHaveBeenCalled();
    });
  }

  test('starts without a branch PATCH when checkout matches the claim', async () => {
    setup.mockResolvedValueOnce({ path: '/tmp/example-worktree', branch: CLAIMED_BRANCH, base: 'origin/dev' });
    const { manager, start } = harness(async () => ({}));
    await start();
    await settle();
    expect(manager.buildd.updateWorker).not.toHaveBeenCalled();
    expect(manager.startSession).toHaveBeenCalledTimes(1);
  });

  test('does not start when the branch write throws', async () => {
    const { manager, start } = harness(async (_id, payload) => {
      if (payload.branch) throw new Error('Network unavailable');
      return {};
    });
    await start();
    await settle();
    expect(manager.startSession).not.toHaveBeenCalled();
    expect(manager.workers.get('worker-test').error).toContain('Network unavailable');
    expect(cleanup).toHaveBeenCalled();
  });
});
