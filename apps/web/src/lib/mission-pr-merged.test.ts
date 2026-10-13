/**
 * The shipping-PR merged check reads cheapest first and stops at the first
 * source that shows the merge (docs/specs/mission-branch-refresh.md,
 * "Eligibility"). A failed read is never a merge.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockFindMissionPrOwner = mock((_id: string) => Promise.resolve(null as any));
const mockDeliveryPrStates = mock((_ws: string, _prs: number[]) => Promise.resolve([] as any[]));
const mockGithubApi = mock((_i: number, _path: string) => Promise.resolve(null as any));

mock.module('@/lib/mission-pr', () => ({ findMissionPrOwner: (id: string) => mockFindMissionPrOwner(id) }));
mock.module('@/lib/workflow/delivery-view', () => ({
  deliveryPrStates: (ws: string, prs: number[]) => mockDeliveryPrStates(ws, prs),
}));
mock.module('@/lib/github', () => ({ githubApi: (i: number, path: string) => mockGithubApi(i, path) }));

const { missionShippingPrMerged } = await import('./mission-pr-merged');

const repo = { workspaceId: 'ws-1', installationId: 7, repoFullName: 'org/repo' };
const owner = (over: Record<string, unknown> = {}) => ({
  taskId: 't', workerId: 'w', prNumber: 12, prUrl: 'https://github.com/org/repo/pull/12', mergedAt: null, state: 'open', ...over,
});

describe('missionShippingPrMerged', () => {
  beforeEach(() => {
    mockFindMissionPrOwner.mockReset();
    mockDeliveryPrStates.mockReset();
    mockDeliveryPrStates.mockResolvedValue([]);
    mockGithubApi.mockReset();
    mockGithubApi.mockResolvedValue(null);
  });

  it('no mission PR at all: not merged, nothing else read', async () => {
    mockFindMissionPrOwner.mockResolvedValue(null);
    expect(await missionShippingPrMerged('m', repo)).toBeNull();
    expect(mockDeliveryPrStates).not.toHaveBeenCalled();
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('the worker row says merged: no further reads', async () => {
    mockFindMissionPrOwner.mockResolvedValue(owner({ state: 'merged', mergedAt: new Date() }));
    expect(await missionShippingPrMerged('m', repo)).toEqual({ prNumber: 12, via: 'worker' });
    expect(mockDeliveryPrStates).not.toHaveBeenCalled();
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('the kernel delivery is MERGED: no GitHub read', async () => {
    mockFindMissionPrOwner.mockResolvedValue(owner());
    mockDeliveryPrStates.mockResolvedValue([{ prNumber: 12, state: 'MERGED', mergedAt: null }]);
    expect(await missionShippingPrMerged('m', repo)).toEqual({ prNumber: 12, via: 'delivery' });
    expect(mockDeliveryPrStates.mock.calls[0]).toEqual(['ws-1', [12]]);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('GitHub says merged: one PR read, number taken from the URL when the column is empty', async () => {
    mockFindMissionPrOwner.mockResolvedValue(owner({ prNumber: null }));
    mockGithubApi.mockResolvedValue({ merged: true });
    expect(await missionShippingPrMerged('m', repo)).toEqual({ prNumber: 12, via: 'github' });
    expect(mockGithubApi.mock.calls).toEqual([[7, '/repos/org/repo/pulls/12']]);
  });

  it('an open PR everywhere: not merged', async () => {
    mockFindMissionPrOwner.mockResolvedValue(owner());
    mockDeliveryPrStates.mockResolvedValue([{ prNumber: 12, state: 'APPROVED', mergedAt: null }]);
    mockGithubApi.mockResolvedValue({ merged: false, state: 'open' });
    expect(await missionShippingPrMerged('m', repo)).toBeNull();
  });

  it('failed reads are never a merge', async () => {
    mockFindMissionPrOwner.mockResolvedValue(owner());
    mockDeliveryPrStates.mockRejectedValue(new Error('db down'));
    mockGithubApi.mockRejectedValue(new Error('GitHub API error: 502'));
    expect(await missionShippingPrMerged('m', repo)).toBeNull();
  });

  it('without a repo only the worker row is read', async () => {
    mockFindMissionPrOwner.mockResolvedValue(owner());
    expect(await missionShippingPrMerged('m')).toBeNull();
    expect(mockDeliveryPrStates).not.toHaveBeenCalled();
    expect(mockGithubApi).not.toHaveBeenCalled();
  });
});
