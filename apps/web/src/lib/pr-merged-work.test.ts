import { describe, it, expect, mock, beforeEach } from 'bun:test';

const updateSpy = mock(() => ({ set: () => ({ where: () => ({ returning: async () => [{ id: 't1' }] }) }) }));
const emit = mock(async (_e: any) => {});

mock.module('next/server', () => ({ after: (fn: () => void) => fn() }));
mock.module('@buildd/core/db', () => ({ db: { update: updateSpy, query: { workers: { findFirst: async () => null } } } }));
mock.module('@buildd/core/db/schema', () => ({ tasks: {}, workspaces: {} }));
mock.module('drizzle-orm', () => ({ and: () => ({}), eq: () => ({}), ne: () => ({}) }));
mock.module('@/lib/core-emit', () => ({ emit }));
mock.module('@/lib/model-policy-outcomes', () => ({ reportTaskPolicyOutcome: async () => {} }));
mock.module('@/lib/task-dependencies', () => ({ checkDependsOnResolved: async () => {}, resolveCompletedTask: async () => {} }));
mock.module('@/lib/interactive-detach', () => ({ detachInteractiveWorkersOfEndedTasks: async () => {} }));
mock.module('@/lib/pusher', () => ({ triggerEvent: async () => {}, channels: { workspace: () => 'c' }, events: { WORKER_PROGRESS: 'p' } }));
mock.module('@/lib/work-tracker', () => ({ postWorkTrackerCompletionUpdate: async () => {} }));
mock.module('@/lib/path-claim-release', () => ({ releaseAndNotify: async () => {} }));
mock.module('@/lib/pr-merge-stamp', () => ({ stampPrMergedOnAllRows: async () => {} }));
mock.module('@/lib/repo-scope', () => ({ workerOwnsPr: () => ({}), workerOwnsPrUrl: () => ({}) }));
mock.module('@/lib/task-open-prs', () => ({ otherOpenPrsOfTask: async () => [] }));

const { runMergedPrWork } = await import('./pr-merged-work');

const input = (runner: string) => ({
  worker: { id: 'w1', workspaceId: 'ws', taskId: 't1', runner },
  task: { id: 't1', status: 'in_progress', workspaceId: 'ws', missionId: null, taskClass: null, release: null, loopState: null },
  repoFullName: 'o/r', prNumber: 1, prUrl: 'u', prHtmlUrl: 'u', baseRef: 'dev', headSha: 's',
  installationId: null, mergedAt: new Date(), mergeIsNew: true, stamp: false,
});

describe('runMergedPrWork completion', () => {
  beforeEach(() => { updateSpy.mockClear(); emit.mockClear(); });

  it('does not complete a task held by an interactive session', async () => {
    await runMergedPrWork(input('mcp'));
    expect(updateSpy).not.toHaveBeenCalled();
    const merged = emit.mock.calls.map((c) => c[0]).find((e: any) => e.type === 'task.pr_merged');
    expect(merged.transition).toBe('not_flipped');
  });

  it('still completes a runner-held task', async () => {
    await runMergedPrWork(input('runner-1'));
    expect(updateSpy).toHaveBeenCalled();
  });
});
