import { beforeEach, expect, mock, test } from 'bun:test';
const refresh = mock(async (_input: unknown) => {});
const deferred: Array<() => Promise<void>> = [];
mock.module('@/lib/mission-branch-refresh', () => ({ refreshMissionBranchesForTrunkMerge: refresh }));
mock.module('next/server', () => ({ after: (fn: () => Promise<void>) => deferred.push(fn) }));
const { missionBranchRefreshSubscribers } = await import('./mission-branch-refresh-subscribers');
mock.module('@/modules', () => ({ SUBSCRIBERS: [] }));
mock.module('@buildd/core/report-ops', () => ({ reportOps: mock(async () => {}) }));
const { emit } = await import('./core-emit');
beforeEach(() => { refresh.mockClear(); deferred.length = 0; });
test('a delivered PR merge schedules refresh against its repository and base', async () => {
  await emit({ type: 'pr.merged', repoFullName: 'example/repo', prNumber: 7, url: null,
    delivery: { installationId: 1, baseRef: 'dev', baseSha: 'base', headSha: 'head', mergeCommitSha: 'merged', title: 'Feature' },
  }, { subscribers: missionBranchRefreshSubscribers });
  expect(refresh).not.toHaveBeenCalled();
  expect(deferred).toHaveLength(1);
  await deferred[0]();
  expect(refresh).toHaveBeenCalledWith({ repoFullName: 'example/repo', baseRef: 'dev' });
});
test('a merge without webhook base details does not schedule a refresh', async () => {
  await emit({ type: 'pr.merged', repoFullName: 'example/repo', prNumber: 7, url: null }, { subscribers: missionBranchRefreshSubscribers });
  expect(deferred).toHaveLength(0);
});
