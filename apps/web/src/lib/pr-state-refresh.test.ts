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
  or: (...args: any[]) => ({ args, op: 'or' }),
  lt: (a: any, b: any) => ({ a, b, op: 'lt' }),
  isNull: (a: any) => ({ a, op: 'isNull' }),
  isNotNull: (a: any) => ({ a, op: 'isNotNull' }),
  inArray: (a: any, b: any) => ({ a, b, op: 'inArray' }),
  notInArray: (a: any, b: any) => ({ a, b, op: 'notInArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: {
    prNumber: 'prNumber',
    mergedAt: 'mergedAt',
    prUrl: 'prUrl',
    updatedAt: 'updatedAt',
    prLifecycleStatus: 'prLifecycleStatus',
    prLastCheckedAt: 'prLastCheckedAt',
    workspaceId: 'workspaceId',
    id: 'id',
  },
  workspaces: { id: 'id' },
}));

// ─── GitHub API mock ──────────────────────────────────────────────────────────

const mockGithubApi = mock(() =>
  Promise.resolve({ state: 'open', merged: false, merged_at: null }),
);
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));

// ─── Pusher mock ──────────────────────────────────────────────────────────────

const mockTriggerEvent = mock(() => Promise.resolve());
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { WORKER_PROGRESS: 'worker:progress' },
}));

// ─── Task dependencies mock ───────────────────────────────────────────────────

const mockCheckDependsOnResolved = mock(() => Promise.resolve());
mock.module('@/lib/task-dependencies', () => ({
  checkDependsOnResolved: mockCheckDependsOnResolved,
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import {
  refreshStaleWorkersForWorkspaces,
  refreshStaleWorkers,
} from './pr-state-refresh';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FIVE_MIN_AGO = new Date(Date.now() - 6 * 60 * 1000);
const TWO_MIN_AGO = new Date(Date.now() - 2 * 60 * 1000);

const ws = {
  repo: 'owner/repo',
  githubInstallation: { installationId: 123 },
};

function makeSetMock() {
  const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
  mockWorkersUpdate.mockReturnValue({ set: setMock });
  return setMock;
}

// ─── Tests: refreshStaleWorkersForWorkspaces ──────────────────────────────────

describe('refreshStaleWorkersForWorkspaces', () => {
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockGithubApi.mockReset();
    mockTriggerEvent.mockReset();
    // mockClear preserves the Promise-returning implementation so the function stays
    // callable after this file's tests complete. mockReset() would leave it returning
    // undefined, which causes .catch() to throw in co-running test files.
    mockCheckDependsOnResolved.mockClear();
  });

  it('does nothing for empty workspace list', async () => {
    await refreshStaleWorkersForWorkspaces([]);
    expect(mockWorkersFindMany).not.toHaveBeenCalled();
  });

  it('does nothing when no stale workers found', async () => {
    mockWorkersFindMany.mockResolvedValue([]);
    await refreshStaleWorkersForWorkspaces(['ws1']);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('stamps mergedAt and fires WORKER_PROGRESS on merged PR', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 42, workspaceId: 'ws1', taskId: 'task1' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({
      state: 'closed',
      merged: true,
      merged_at: '2026-01-01T00:00:00Z',
    });

    const setMock = makeSetMock();
    await refreshStaleWorkersForWorkspaces(['ws1']);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ prLifecycleStatus: 'merged', prLastCheckedAt: expect.any(Date) }),
    );
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      expect.stringContaining('ws1'),
      'worker:progress',
      expect.objectContaining({ taskId: 'task1' }),
    );
    expect(mockCheckDependsOnResolved).toHaveBeenCalledWith('task1');
  });

  it('stamps closed status on closed-unmerged PR', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 99, workspaceId: 'ws1', taskId: 'task1' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: false, merged_at: null });

    const setMock = makeSetMock();
    await refreshStaleWorkersForWorkspaces(['ws1']);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ prLifecycleStatus: 'closed', prLastCheckedAt: expect.any(Date) }),
    );
    expect(mockCheckDependsOnResolved).not.toHaveBeenCalled();
  });

  it('stamps only prLastCheckedAt for open PRs (no lifecycle change)', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 7, workspaceId: 'ws1', taskId: 'task1' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null });

    const setMock = makeSetMock();
    await refreshStaleWorkersForWorkspaces(['ws1']);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ prLastCheckedAt: expect.any(Date) }),
    );
    expect(setMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ prLifecycleStatus: 'merged' }),
    );
    expect(mockCheckDependsOnResolved).not.toHaveBeenCalled();
  });

  it('skips workspace with no GitHub installation', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 1, workspaceId: 'ws-no-gh', taskId: 't1' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({ repo: null, githubInstallation: null });

    await refreshStaleWorkersForWorkspaces(['ws-no-gh']);

    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('is non-fatal on GitHub error: logs and does not stamp prLastCheckedAt', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 5, workspaceId: 'ws1', taskId: 't1' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockRejectedValue(new Error('GitHub API error: 404 Not Found'));

    const setMock = makeSetMock();
    await expect(refreshStaleWorkersForWorkspaces(['ws1'])).resolves.toBeUndefined();
    expect(setMock).not.toHaveBeenCalled();
  });
});

// ─── Tests: refreshStaleWorkers (pre-fetched workers) ────────────────────────

describe('refreshStaleWorkers', () => {
  beforeEach(() => {
    mockWorkspacesFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockGithubApi.mockReset();
    mockTriggerEvent.mockReset();
    mockCheckDependsOnResolved.mockClear();
  });

  it('skips workers without a prNumber', async () => {
    await refreshStaleWorkers([
      {
        id: 'w1',
        prNumber: null,
        workspaceId: 'ws1',
        taskId: 't1',
        prLifecycleStatus: null,
        prLastCheckedAt: null,
      },
    ]);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('skips already-terminal workers (merged)', async () => {
    await refreshStaleWorkers([
      {
        id: 'w1',
        prNumber: 10,
        workspaceId: 'ws1',
        taskId: 't1',
        prLifecycleStatus: 'merged',
        prLastCheckedAt: null,
      },
    ]);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('skips already-terminal workers (closed)', async () => {
    await refreshStaleWorkers([
      {
        id: 'w1',
        prNumber: 10,
        workspaceId: 'ws1',
        taskId: 't1',
        prLifecycleStatus: 'closed',
        prLastCheckedAt: null,
      },
    ]);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('skips recently-checked workers (within 5 min)', async () => {
    await refreshStaleWorkers([
      {
        id: 'w1',
        prNumber: 10,
        workspaceId: 'ws1',
        taskId: 't1',
        prLifecycleStatus: 'ci_running',
        prLastCheckedAt: TWO_MIN_AGO,
      },
    ]);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('processes workers with null prLastCheckedAt (never checked)', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null });
    const setMock = makeSetMock();

    await refreshStaleWorkers([
      {
        id: 'w1',
        prNumber: 10,
        workspaceId: 'ws1',
        taskId: 't1',
        prLifecycleStatus: null,
        prLastCheckedAt: null,
      },
    ]);

    expect(mockGithubApi).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalled();
  });

  it('processes workers whose prLastCheckedAt is older than 5 min', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null });
    const setMock = makeSetMock();

    await refreshStaleWorkers([
      {
        id: 'w1',
        prNumber: 10,
        workspaceId: 'ws1',
        taskId: 't1',
        prLifecycleStatus: 'ci_running',
        prLastCheckedAt: FIVE_MIN_AGO,
      },
    ]);

    expect(mockGithubApi).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalled();
  });

  it('calls checkDependsOnResolved on merge discovery', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({
      state: 'closed',
      merged: true,
      merged_at: '2026-01-01T00:00:00Z',
    });
    makeSetMock();

    await refreshStaleWorkers([
      {
        id: 'w1',
        prNumber: 10,
        workspaceId: 'ws1',
        taskId: 'task-abc',
        prLifecycleStatus: 'ci_green',
        prLastCheckedAt: FIVE_MIN_AGO,
      },
    ]);

    expect(mockCheckDependsOnResolved).toHaveBeenCalledWith('task-abc');
  });

  it('caps batch at 10 workers', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null });
    makeSetMock();

    const manyWorkers = Array.from({ length: 15 }, (_, i) => ({
      id: `w${i}`,
      prNumber: i + 1,
      workspaceId: 'ws1',
      taskId: `t${i}`,
      prLifecycleStatus: null as string | null,
      prLastCheckedAt: null as Date | null,
    }));

    await refreshStaleWorkers(manyWorkers);

    expect(mockGithubApi).toHaveBeenCalledTimes(10);
  });
});
