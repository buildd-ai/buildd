/**
 * Regression test for a dropped-on-the-floor field: the claim route resolves
 * `task.context.skillSlugs` into full `SkillBundle`s and attaches them to the
 * claim response as `worker.skillBundles` (see attachSkillBundles in
 * apps/web/src/app/api/workers/claim/skill-and-role-injection.ts). Nothing in
 * startFromClaim ever copied that field onto the LocalWorker it builds, so
 * startSession's `syncSkillToLocal` pass — which is what actually writes the
 * skill to disk for the SDK's native Skill tool to find — always saw
 * `undefined` and silently skipped. The task's system prompt still told the
 * agent "You MUST use the <slug> skill" (that part reads `context.skillSlugs`,
 * which IS on the task), so the agent tried, got "Unknown skill: <slug>",
 * and had no way to recover.
 */
import { describe, expect, mock, test } from 'bun:test';

mock.module('../../src/git-operations', () => ({
  setupWorktree: mock(async () => ({ path: '/tmp/example-worktree', branch: 'buildd/example-task', base: 'origin/dev' })),
  removeWorktreeIfUnowned: mock(async () => ({ removed: true })),
  removeWorktreeIfUnownedSync: mock(() => ({ removed: true })),
  cleanupWorktree: mock(async () => ({ removed: true })),
  collectGitStats: async () => ({}),
}));
mock.module('../../src/worker-store', () => ({
  saveWorker: () => {}, loadAllWorkers: () => [], loadTerminalWorkersCached: () => [], __resetDiskWorkersCache: () => {}, loadWorker: () => null, deleteWorker: () => {},
}));
mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({}), checkMcpPreFlight: () => ({ warnings: [] }),
  parseMcpJson: () => [], scanMcpServersRich: () => [],
  checkBwrapSupport: () => true, checkBwrapMountIsolationSupport: () => true,
}));
const { WorkerManager } = await import('../../src/workers');

function harness() {
  // Same minimal-prototype harness as worker-branch-persistence.test.ts:
  // exercises the real claim-to-worker wiring in startFromClaim without
  // constructor timers or SDK execution.
  const manager = Object.create(WorkerManager.prototype) as any;
  Object.assign(manager, {
    workers: new Map(), workerTeamKeys: new Map(), credCache: new Map(),
    config: {}, buildd: { updateWorker: mock(async () => ({})) },
    sendHeartbeat: () => {}, emit: () => {}, addMilestone: () => {},
    pusherManager: { subscribeToWorker: () => {} },
    startSession: mock(async () => {}),
  });
  const skillBundle = {
    slug: 'changelog-generator',
    name: 'changelog-generator',
    description: 'Generates CHANGELOG.md entries from conventional commits',
    content: '# Changelog Generator\n...',
  };
  const start = () => manager.startFromClaim(
    { id: 'worker-test', branch: 'buildd/example-task', skillBundles: [skillBundle] },
    {
      id: 'task-test', title: 'Update CHANGELOG.md', workspaceId: 'workspace-test',
      context: { skillSlugs: ['changelog-generator'] },
      workspace: { name: 'Example', repo: 'https://github.com/example/repo', gitConfig: { defaultBranch: 'dev' } },
    },
    '/tmp/example-repo',
  );
  return { manager, start, skillBundle };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('skillBundles propagate from the claim response to the LocalWorker', () => {
  test('startFromClaim copies claimedWorker.skillBundles onto the worker', async () => {
    const { manager, start, skillBundle } = harness();
    await start();
    await settle();
    expect(manager.workers.get('worker-test').skillBundles).toEqual([skillBundle]);
  });

  test('the worker passed to startSession carries skillBundles (what syncSkillToLocal reads)', async () => {
    const { manager, start, skillBundle } = harness();
    await start();
    await settle();
    expect(manager.startSession).toHaveBeenCalledTimes(1);
    expect(manager.startSession.mock.calls[0][0].skillBundles).toEqual([skillBundle]);
  });

  test('no skillBundles on the claim leaves the worker field unset', async () => {
    const manager = Object.create(WorkerManager.prototype) as any;
    Object.assign(manager, {
      workers: new Map(), workerTeamKeys: new Map(), credCache: new Map(),
      config: {}, buildd: { updateWorker: mock(async () => ({})) },
      sendHeartbeat: () => {}, emit: () => {}, addMilestone: () => {},
      pusherManager: { subscribeToWorker: () => {} },
      startSession: mock(async () => {}),
    });
    await manager.startFromClaim(
      { id: 'worker-test', branch: 'buildd/example-task' },
      { id: 'task-test', title: 'Example', workspaceId: 'workspace-test', workspace: { name: 'Example', repo: 'https://github.com/example/repo', gitConfig: { defaultBranch: 'dev' } } },
      '/tmp/example-repo',
    );
    await settle();
    expect(manager.workers.get('worker-test').skillBundles).toBeUndefined();
  });
});
