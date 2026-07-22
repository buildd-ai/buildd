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

import { reconcileStalePrWorkers } from './pr-reconcile';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ws = {
  repo: 'owner/repo',
  githubInstallation: { installationId: 123 },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

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
