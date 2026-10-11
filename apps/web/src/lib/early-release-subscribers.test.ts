import { describe, it, expect, mock, beforeEach } from 'bun:test';

const findWorkspace = mock(async (_q: unknown): Promise<unknown> => ({ teamId: 'team-1', gitConfig: { earlyRelease: { mode: 'rules' } } }));
const scheduled: unknown[] = [];
const undrafted: string[] = [];

mock.module('@buildd/core/db', () => ({ db: { query: { workspaces: { findFirst: findWorkspace } } } }));
mock.module('@/lib/early-release-dispatch-trigger', () => ({ scheduleEarlyReleaseDispatch: (i: unknown) => { scheduled.push(i); } }));
mock.module('@/lib/early-release-stacking', () => ({ undraftStackedDependents: async (id: string) => { undrafted.push(id); } }));

const { earlyReleaseSubscribers } = await import('./early-release-subscribers');
const { emit } = await import('./core-emit');

beforeEach(() => {
  scheduled.length = 0;
  undrafted.length = 0;
  findWorkspace.mockClear();
});

describe('earlyReleaseSubscribers', () => {
  it('pr.review_ready schedules a dispatch for the upstream task with the PR facts', async () => {
    await emit({
      type: 'pr.review_ready', installationId: 7, repoFullName: 'o/r',
      pr: { number: 12, headRef: 'buildd/abc-up', additions: 5, deletions: 2 },
      worker: { id: 'w1', workspaceId: 'ws1', taskId: 't1' },
    }, { subscribers: earlyReleaseSubscribers });
    expect(scheduled).toEqual([{
      workspaceId: 'ws1', teamId: 'team-1', gitConfig: { earlyRelease: { mode: 'rules' } },
      upstreamTaskId: 't1', upstreamPrNumber: 12, upstreamBranch: 'buildd/abc-up',
      repoFullName: 'o/r', installationId: 7, upstreamAdditions: 5, upstreamDeletions: 2,
    }]);
  });

  it('pr.review_ready does nothing when the workspace is gone', async () => {
    findWorkspace.mockResolvedValueOnce(undefined);
    await emit({
      type: 'pr.review_ready', installationId: 7, repoFullName: 'o/r',
      pr: { number: 12, headRef: 'b', additions: null, deletions: null },
      worker: { id: 'w1', workspaceId: 'ws1', taskId: 't1' },
    }, { subscribers: earlyReleaseSubscribers });
    expect(scheduled).toEqual([]);
  });

  it('task.pr_merge_delivered un-drafts the dependents stacked on the merged task', async () => {
    await emit({
      type: 'task.pr_merge_delivered', taskId: 't1', workerId: 'w1', workspaceId: 'ws1', missionId: null, baseRef: 'dev',
    }, { subscribers: earlyReleaseSubscribers });
    expect(undrafted).toEqual(['t1']);
  });
});
