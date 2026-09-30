/**
 * Wiring for M1: startFromClaim hands setupWorktree the retry's lineage, and
 * the release callback makes the prior (holder) worker non-resumable.
 */
import { describe, expect, mock, test } from 'bun:test';

const setup = mock(async (..._args: any[]) => ({ path: '/tmp/example-worktree', branch: 'buildd/aaaa1111-fix', base: 'origin/buildd/aaaa1111-fix' }));
mock.module('../../src/git-operations', () => ({
  setupWorktree: setup,
  removeWorktreeIfUnowned: mock(async () => ({ removed: true })),
  removeWorktreeIfUnownedSync: mock(() => ({ removed: true })),
  cleanupWorktree: mock(async () => ({ removed: true })),
  collectGitStats: async () => ({}),
}));
const saved: any[] = [];
mock.module('../../src/worker-store', () => ({
  saveWorker: (w: any) => { saved.push(w); }, loadAllWorkers: () => [], loadTerminalWorkersCached: () => [], __resetDiskWorkersCache: () => {}, loadWorker: () => null, deleteWorker: () => {},
}));
mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({}), checkMcpPreFlight: () => ({ warnings: [] }),
  parseMcpJson: () => [], scanMcpServersRich: () => [],
  checkBwrapSupport: () => true, checkBwrapMountIsolationSupport: () => true,
}));
const { WorkerManager } = await import('../../src/workers');

describe('lineage-held branch release wiring', () => {
  test('passes task lineage to setupWorktree and the callback clears the holder session', async () => {
    const holder: any = {
      id: 'w-prior', taskId: 'task-A', status: 'done', branch: 'buildd/aaaa1111-fix',
      sessionId: 'sess-1', codexThreadId: 'thr-1', milestones: [],
    };
    const manager = Object.create(WorkerManager.prototype) as any;
    const milestones: any[] = [];
    Object.assign(manager, {
      workers: new Map([['w-prior', holder]]), workerTeamKeys: new Map(), credCache: new Map(),
      config: {}, buildd: { updateWorker: mock(async () => ({ branch: 'buildd/aaaa1111-fix' })) },
      sendHeartbeat: () => {}, emit: () => {}, addMilestone: (_w: any, m: any) => milestones.push(m),
      pusherManager: { subscribeToWorker: () => {} },
      startSession: mock(async () => {}),
    });
    await manager.startFromClaim(
      { id: 'w-new', branch: 'buildd/bbbb2222-retry' },
      { id: 'task-B', parentTaskId: 'task-A', title: 'Retry', workspaceId: 'ws', context: { resumeBranch: 'buildd/aaaa1111-fix' }, workspace: { name: 'Example', repo: 'https://github.com/example/repo', gitConfig: { defaultBranch: 'dev' } } },
      '/tmp/example-repo',
    );
    expect(setup).toHaveBeenCalledTimes(1);
    const lineage = setup.mock.calls[0][7];
    expect(lineage).toMatchObject({ taskId: 'task-B', parentTaskId: 'task-A' });
    expect(manager.workers.get('w-new').parentTaskId).toBe('task-A');

    lineage.onHolderReleased('w-prior');
    expect(holder.sessionId).toBeUndefined();
    expect(holder.codexThreadId).toBeUndefined();
    expect(milestones.some(m => /no longer resumable/.test(m.label))).toBe(true);
    expect(saved).toContain(holder);
  });
});
