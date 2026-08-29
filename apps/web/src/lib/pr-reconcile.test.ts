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
  or: (...args: any[]) => ({ args, op: 'or' }),
  isNull: (a: any) => ({ a, op: 'isNull' }),
  isNotNull: (a: any) => ({ a, op: 'isNotNull' }),
  notInArray: (a: any, b: any) => ({ a, b, op: 'notInArray' }),
  asc: (a: any) => ({ a, op: 'asc' }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({ op: 'sql', strings: [...strings], values }),
    { raw: (v: string) => ({ op: 'sql.raw', v }) },
  ),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: {
    prNumber: 'prNumber',
    mergedAt: 'mergedAt',
    prUrl: 'prUrl',
    updatedAt: 'updatedAt',
    prLastCheckedAt: 'prLastCheckedAt',
    prLifecycleStatus: 'prLifecycleStatus',
  },
  workspaces: { id: 'id' },
}));

const mockCheckDependsOnResolved = mock(() => Promise.resolve(undefined));
mock.module('@/lib/task-dependencies', () => ({
  checkDependsOnResolved: mockCheckDependsOnResolved,
}));

// ─── GitHub API mock ──────────────────────────────────────────────────────────

const mockGithubApi = mock(() => Promise.resolve({ state: 'open', merged: false, merged_at: null }));

mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));

// ─── Import after mocks ───────────────────────────────────────────────────────

import {
  reconcileStalePrWorkers,
  refreshWorkerMergeStateIfStale,
  RECONCILE_BATCH_CAP,
  RECONCILE_STALE_MS,
} from './pr-reconcile';

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
    mockCheckDependsOnResolved.mockReset();
    // Every outcome now records prLastCheckedAt, so update() must be callable.
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({ where: mock(() => Promise.resolve()) })),
    });
  });

  it('returns zeros when no stale workers found', async () => {
    mockWorkersFindMany.mockResolvedValue([]);
    const result = await reconcileStalePrWorkers();
    expect(result).toEqual({ total: 0, stamped: 0, closed: 0, skipped: 0, errors: 0 });
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

  it('leaves an open PR open, recording only that it was checked', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 7, workspaceId: 'ws1', taskId: 't1' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null });

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockWorkersUpdate.mockReturnValue({ set: setMock });

    const result = await reconcileStalePrWorkers();

    expect(result.skipped).toBe(1);
    // prLastCheckedAt must advance even when nothing changed, or the row stays
    // at the head of the oldest-first queue and the sweep never reaches the tail.
    const written = setMock.mock.calls[0][0] as Record<string, unknown>;
    expect(written.prLastCheckedAt).toBeInstanceOf(Date);
    expect(written.prLifecycleStatus).toBeUndefined();
    expect(written.mergedAt).toBeUndefined();
  });

  it('skips workspace with no GitHub installation', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 1, workspaceId: 'ws-no-gh' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({ repo: null, githubInstallation: null });

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockWorkersUpdate.mockReturnValue({ set: setMock });

    const result = await reconcileStalePrWorkers();

    expect(result.skipped).toBe(1);
    expect(mockGithubApi).not.toHaveBeenCalled();
    // A workspace with no installation can never be reconciled. Record the
    // check anyway, or these rows permanently occupy the head of the batch.
    expect((setMock.mock.calls[0][0] as Record<string, unknown>).prLastCheckedAt).toBeInstanceOf(Date);
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

  // ── Candidate selection ────────────────────────────────────────────────────
  //
  // The old gate was `updatedAt < now() - 7 days` with no cap, no ordering and
  // no terminal-status filter. Measured against production that selected ~200
  // rows of which the overwhelming majority were already known-closed — burning
  // a GitHub call each, unbounded, inside a 60 s function — while a PR whose
  // webhook was missed today was not even a candidate for a week.

  it('gates on when the row was last checked, not on 7 days of inactivity', async () => {
    mockWorkersFindMany.mockResolvedValue([]);
    await reconcileStalePrWorkers();

    const where = JSON.stringify((mockWorkersFindMany.mock.calls[0][0] as any).where);
    expect(where).toContain('prLastCheckedAt');
    // Minutes-to-an-hour, not days: a webhook missed at noon must be healed the
    // same afternoon, and the read-through refresh keeps hot rows out of range.
    expect(RECONCILE_STALE_MS).toBeGreaterThanOrEqual(60 * 1000);
    expect(RECONCILE_STALE_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('excludes rows already known to be merged or closed', async () => {
    mockWorkersFindMany.mockResolvedValue([]);
    await reconcileStalePrWorkers();

    const query = mockWorkersFindMany.mock.calls[0][0] as any;
    const where = JSON.stringify(query.where);
    expect(where).toContain('prLifecycleStatus');
    expect(where).toContain('merged');
    expect(where).toContain('closed');
  });

  it('bounds the batch and takes the least-recently-checked first', async () => {
    mockWorkersFindMany.mockResolvedValue([]);
    await reconcileStalePrWorkers();

    const query = mockWorkersFindMany.mock.calls[0][0] as any;
    expect(query.limit).toBe(RECONCILE_BATCH_CAP);
    expect(query.orderBy).toBeDefined();
    // Must fit inside the route's maxDuration with the inter-call delay.
    expect(RECONCILE_BATCH_CAP).toBeLessThanOrEqual(60);
  });

  it('records a check after a GitHub error so one bad row cannot block the queue', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 404, workspaceId: 'ws1', taskId: 't1' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockRejectedValue(new Error('Not Found'));

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockWorkersUpdate.mockReturnValue({ set: setMock });

    const result = await reconcileStalePrWorkers();

    expect(result.errors).toBe(1);
    expect(result.stamped).toBe(0);
    const written = setMock.mock.calls[0][0] as Record<string, unknown>;
    expect(written.prLastCheckedAt).toBeInstanceOf(Date);
  });

  it('unblocks dependents when it heals a missed merge', async () => {
    mockCheckDependsOnResolved.mockReset();
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 42, workspaceId: 'ws1', taskId: 'task-42' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z' });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });

    const result = await reconcileStalePrWorkers();

    expect(result.stamped).toBe(1);
    // Stamping mergedAt is not enough: something must tell the dependency gate,
    // or the tasks this PR was blocking stay pending until another poke.
    expect(mockCheckDependsOnResolved).toHaveBeenCalledWith('task-42');
  });

  it('does not notify dependents for a PR that is merely closed', async () => {
    mockCheckDependsOnResolved.mockReset();
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 43, workspaceId: 'ws1', taskId: 'task-43' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: false, merged_at: null });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });

    await reconcileStalePrWorkers();

    expect(mockCheckDependsOnResolved).not.toHaveBeenCalled();
  });
});
