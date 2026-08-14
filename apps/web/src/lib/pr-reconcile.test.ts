import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ─── DB mocks ─────────────────────────────────────────────────────────────────

const mockWorkersFindMany = mock(() => [] as any[]);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockWorkersUpdate = mock(() => ({
  set: mock(() => ({ where: mock(() => Promise.resolve()) })),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    update: () => mockWorkersUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => ({ args, op: 'and' }),
  lt: (a: any, b: any) => ({ a, b, op: 'lt' }),
  isNull: (a: any) => ({ a, op: 'isNull' }),
  isNotNull: (a: any) => ({ a, op: 'isNotNull' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: { prNumber: 'prNumber', mergedAt: 'mergedAt', prUrl: 'prUrl', updatedAt: 'updatedAt' },
  workspaces: { id: 'id' },
}));

// ─── GitHub API mock ──────────────────────────────────────────────────────────

const mockGithubApi = mock(() => Promise.resolve({ state: 'open', merged: false, merged_at: null }));

mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { reconcileStalePrWorkers, refreshWorkerMergeStateIfStale } from './pr-reconcile';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ws = {
  repo: 'owner/repo',
  githubInstallation: { installationId: 123 },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('refreshWorkerMergeStateIfStale', () => {
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockGithubApi.mockReset();
  });

  it('returns false immediately when mergedAt is already set', async () => {
    const result = await refreshWorkerMergeStateIfStale(
      { id: 'w1', prNumber: 42, prUrl: 'https://github.com/owner/repo/pull/42', mergedAt: new Date() },
      123,
    );
    expect(result).toBe(false);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('calls GitHub API and stamps mergedAt when PR is merged', async () => {
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: true, merged_at: '2026-03-01T10:00:00Z' });
    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockWorkersUpdate.mockReturnValue({ set: setMock });

    const result = await refreshWorkerMergeStateIfStale(
      { id: 'w1', prNumber: 55, prUrl: 'https://github.com/owner/repo/pull/55' },
      456,
    );

    expect(result).toBe(true);
    expect(mockGithubApi).toHaveBeenCalledWith(456, '/repos/owner/repo/pulls/55');
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ prLifecycleStatus: 'merged' }),
    );
  });

  it('returns false when PR is open (not merged)', async () => {
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null });

    const result = await refreshWorkerMergeStateIfStale(
      { id: 'w1', prNumber: 7, prUrl: 'https://github.com/owner/repo/pull/7' },
      123,
    );

    expect(result).toBe(false);
    expect(mockWorkersUpdate).not.toHaveBeenCalled();
  });

  it('stamps prLastCheckedAt alongside mergedAt when PR is merged', async () => {
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: true, merged_at: '2026-03-01T10:00:00Z' });
    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockWorkersUpdate.mockReturnValue({ set: setMock });

    await refreshWorkerMergeStateIfStale(
      { id: 'w1', prNumber: 55, prUrl: 'https://github.com/owner/repo/pull/55' },
      456,
    );

    const [setArgs] = setMock.mock.calls;
    expect(setArgs[0]).toHaveProperty('prLastCheckedAt');
    expect(setArgs[0].prLastCheckedAt).toBeInstanceOf(Date);
  });

  it('returns false on GitHub API error without throwing', async () => {
    mockGithubApi.mockRejectedValue(new Error('GitHub API error: 404 Not Found'));

    const result = await refreshWorkerMergeStateIfStale(
      { id: 'w1', prNumber: 99, prUrl: 'https://github.com/owner/repo/pull/99' },
      123,
    );

    expect(result).toBe(false);
    expect(mockWorkersUpdate).not.toHaveBeenCalled();
  });

  it('logs a warning on GitHub API error', async () => {
    mockGithubApi.mockRejectedValue(new Error('rate limited'));
    const logs: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { logs.push(args); };

    await refreshWorkerMergeStateIfStale(
      { id: 'w1', prNumber: 99, prUrl: 'https://github.com/owner/repo/pull/99' },
      123,
    );

    console.warn = orig;
    expect(logs.length).toBeGreaterThan(0);
  });

  it('returns false when prUrl is not a valid GitHub URL', async () => {
    const result = await refreshWorkerMergeStateIfStale(
      { id: 'w1', prNumber: 1, prUrl: 'not-a-github-url' },
      123,
    );

    expect(result).toBe(false);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('extracts owner/repo correctly from deeply nested GitHub URL', async () => {
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z' });
    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockWorkersUpdate.mockReturnValue({ set: setMock });

    await refreshWorkerMergeStateIfStale(
      { id: 'w1', prNumber: 1234, prUrl: 'https://github.com/my-org/my-repo/pull/1234' },
      789,
    );

    expect(mockGithubApi).toHaveBeenCalledWith(789, '/repos/my-org/my-repo/pulls/1234');
  });
});

describe('reconcileStalePrWorkers', () => {
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockGithubApi.mockReset();
  });

  it('returns zeros when no stale workers found', async () => {
    mockWorkersFindMany.mockResolvedValue([]);
    const result = await reconcileStalePrWorkers();
    expect(result).toEqual({ total: 0, stamped: 0, closed: 0, skipped: 0 });
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('stamps mergedAt when GitHub reports PR as merged', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 42, workspaceId: 'ws1' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z' });

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockWorkersUpdate.mockReturnValue({ set: setMock });

    const result = await reconcileStalePrWorkers();

    expect(result.stamped).toBe(1);
    expect(result.closed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ prLifecycleStatus: 'merged' }),
    );
  });

  it('marks closed when GitHub reports PR closed-unmerged', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 99, workspaceId: 'ws1' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: false, merged_at: null });

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockWorkersUpdate.mockReturnValue({ set: setMock });

    const result = await reconcileStalePrWorkers();

    expect(result.closed).toBe(1);
    expect(result.stamped).toBe(0);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ prLifecycleStatus: 'closed' }),
    );
  });

  it('skips open PRs without writing', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 7, workspaceId: 'ws1' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null });

    const result = await reconcileStalePrWorkers();

    expect(result.skipped).toBe(1);
    expect(mockWorkersUpdate).not.toHaveBeenCalled();
  });

  it('skips workspace with no GitHub installation', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 1, workspaceId: 'ws-no-gh' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({ repo: null, githubInstallation: null });

    const result = await reconcileStalePrWorkers();

    expect(result.skipped).toBe(1);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('skips (non-fatal) on GitHub API error', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 5, workspaceId: 'ws1' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockRejectedValue(new Error('GitHub API error: 404 Not Found'));

    const result = await reconcileStalePrWorkers();

    expect(result.skipped).toBe(1);
    expect(result.stamped).toBe(0);
    expect(mockWorkersUpdate).not.toHaveBeenCalled();
  });

  it('processes multiple workspaces independently', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 10, workspaceId: 'wsA' },
      { id: 'w2', prNumber: 20, workspaceId: 'wsB' },
    ]);
    mockWorkspacesFindFirst
      .mockResolvedValueOnce({ repo: 'owner/repoA', githubInstallation: { installationId: 1 } })
      .mockResolvedValueOnce({ repo: 'owner/repoB', githubInstallation: { installationId: 2 } });
    mockGithubApi
      .mockResolvedValueOnce({ state: 'closed', merged: true, merged_at: '2026-02-01T00:00:00Z' })
      .mockResolvedValueOnce({ state: 'open', merged: false, merged_at: null });

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockWorkersUpdate.mockReturnValue({ set: setMock });

    const result = await reconcileStalePrWorkers();

    expect(result.total).toBe(2);
    expect(result.stamped).toBe(1);
    expect(result.skipped).toBe(1);
    expect(mockGithubApi).toHaveBeenCalledTimes(2);
  });
});
