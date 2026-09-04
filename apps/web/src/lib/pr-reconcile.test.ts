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
    prCheckFailureCount: 'prCheckFailureCount',
    completedAt: 'completedAt',
    createdAt: 'createdAt',
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
} from './pr-reconcile';
import { TIER_SLA_MS, UNRESOLVABLE_FAILURE_THRESHOLD, DAY_MS, HOUR_MS } from './pr-freshness';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Legacy shape: only the direct `workspaces.githubInstallationId` FK resolves. */
const ws = {
  repo: 'owner/repo',
  githubInstallation: { installationId: 123 },
};

/** An old PR, well past the unknown TTL — eligible to go terminal. */
const ancientOpenedAt = new Date(Date.now() - 90 * DAY_MS);

/**
 * Flattens a mocked drizzle predicate tree to a string so a test can assert
 * which columns and literals it references. Cycle-safe: the stubbed `sql` tag
 * hands back objects that share sub-trees, which plain JSON.stringify chokes on.
 */
function describePredicate(node: unknown, seen = new WeakSet<object>()): string {
  if (node == null) return '';
  if (typeof node !== 'object') return String(node);
  if (seen.has(node as object)) return '';
  seen.add(node as object);
  if (Array.isArray(node)) return node.map(n => describePredicate(n, seen)).join(' ');
  return Object.entries(node as Record<string, unknown>)
    .map(([k, v]) => `${k} ${describePredicate(v, seen)}`)
    .join(' ');
}

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
    expect(result).toEqual({ total: 0, stamped: 0, closed: 0, skipped: 0, errors: 0, unresolvable: 0 });
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

  it('skips workspace with no GitHub installation, counting it as a failure not a clean check', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 1, workspaceId: 'ws-no-gh', prCheckFailureCount: 0, completedAt: ancientOpenedAt },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({ repo: null, githubInstallation: null });

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockWorkersUpdate.mockReturnValue({ set: setMock });

    const result = await reconcileStalePrWorkers();

    expect(result.skipped).toBe(1);
    expect(mockGithubApi).not.toHaveBeenCalled();
    const written = setMock.mock.calls[0][0] as Record<string, unknown>;
    // Record the check, or these rows permanently occupy the head of the batch.
    expect(written.prLastCheckedAt).toBeInstanceOf(Date);
    // But NOT as a clean check. The old code wrote a bare prLastCheckedAt here,
    // which made an unreconcilable row look healthy and hid it forever — the
    // precise mechanism behind the four stale MERGE cards on Home.
    expect(written.prCheckFailureCount).toBe(1);
  });

  // ── Installation resolution ────────────────────────────────────────────────
  //
  // The sweep used to read `workspaces.githubInstallationId` directly. That FK
  // is legacy: after an App uninstall/reinstall it points at a dead
  // installation whose token is valid but has access to no repos, so every call
  // 404s — and when it is null the sweep silently skipped the workspace for
  // good. lib/workspace-installation.ts exists precisely to prefer the
  // repo-mediated pointer; this sweep must go through it.

  it('resolves the installation through the repo, not the legacy workspace FK', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 42, workspaceId: 'ws1', prCheckFailureCount: 0 },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({
      repo: 'owner/repo',
      // Repo-mediated pointer is live; the legacy FK points at a dead install.
      githubRepo: { installation: { installationId: 999 } },
      githubInstallation: { installationId: 111 },
    });
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });

    await reconcileStalePrWorkers();

    expect(mockGithubApi).toHaveBeenCalledWith(999, '/repos/owner/repo/pulls/42');
  });

  it('asks the workspace query for both installation pointers', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 42, workspaceId: 'ws1', prCheckFailureCount: 0 },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });

    await reconcileStalePrWorkers();

    const withClause = (mockWorkspacesFindFirst.mock.calls[0][0] as any).with;
    expect(withClause).toHaveProperty('githubRepo');
    expect(withClause).toHaveProperty('githubInstallation');
  });

  // ── Unknown TTL and the terminal exit ──────────────────────────────────────

  it('retires an old row to terminal unresolvable once failures pass the threshold', async () => {
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'w1',
        prNumber: 404,
        workspaceId: 'ws1',
        taskId: 't1',
        prCheckFailureCount: UNRESOLVABLE_FAILURE_THRESHOLD - 1,
        completedAt: ancientOpenedAt,
      },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockRejectedValue(new Error('Not Found'));

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockWorkersUpdate.mockReturnValue({ set: setMock });

    const result = await reconcileStalePrWorkers();

    expect(result.unresolvable).toBe(1);
    const written = setMock.mock.calls[0][0] as Record<string, unknown>;
    expect(written.prLifecycleStatus).toBe('unresolvable');
    expect(written.prUnresolvableReason).toContain('Not Found');
    expect(written.prCheckFailureCount).toBe(UNRESOLVABLE_FAILURE_THRESHOLD);
  });

  it('does not retire a young row, however many times it has failed', async () => {
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'w1',
        prNumber: 404,
        workspaceId: 'ws1',
        prCheckFailureCount: 20,
        completedAt: new Date(Date.now() - HOUR_MS),
      },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockRejectedValue(new Error('502 Bad Gateway'));

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockWorkersUpdate.mockReturnValue({ set: setMock });

    const result = await reconcileStalePrWorkers();

    // A GitHub incident must not condemn a PR that opened an hour ago.
    expect(result.unresolvable).toBe(0);
    expect((setMock.mock.calls[0][0] as Record<string, unknown>).prLifecycleStatus).toBeUndefined();
  });

  it('clears the failure streak when a row resolves again', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 7, workspaceId: 'ws1', prCheckFailureCount: 2, completedAt: ancientOpenedAt },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null });

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockWorkersUpdate.mockReturnValue({ set: setMock });

    await reconcileStalePrWorkers();

    expect((setMock.mock.calls[0][0] as Record<string, unknown>).prCheckFailureCount).toBe(0);
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

    const where = describePredicate((mockWorkersFindMany.mock.calls[0][0] as any).where);
    expect(where).toContain('prLastCheckedAt');
    // Minutes-to-an-hour for a fresh PR, not days: a webhook missed at noon must
    // be healed the same afternoon, and the read-through refresh keeps hot rows
    // out of range.
    expect(TIER_SLA_MS.hot).toBeGreaterThanOrEqual(60 * 1000);
    expect(TIER_SLA_MS.hot).toBeLessThanOrEqual(HOUR_MS);
  });

  it('tiers the staleness window by PR age so cold rows cannot crowd out hot ones', async () => {
    mockWorkersFindMany.mockResolvedValue([]);
    await reconcileStalePrWorkers();

    const where = describePredicate((mockWorkersFindMany.mock.calls[0][0] as any).where);
    // The gate must reference the PR's own age, not a single flat cutoff.
    expect(where).toContain('completedAt');
    expect(where).toContain('createdAt');
    // Tier SLAs must be strictly ordered, and every tier bounded by a day — the
    // documented invariant is that no row's state is ever older than its SLA.
    expect(TIER_SLA_MS.hot).toBeLessThan(TIER_SLA_MS.warm);
    expect(TIER_SLA_MS.warm).toBeLessThan(TIER_SLA_MS.cold);
    expect(TIER_SLA_MS.cold).toBeLessThanOrEqual(DAY_MS);
  });

  it('excludes rows already known to be merged, closed or unresolvable', async () => {
    mockWorkersFindMany.mockResolvedValue([]);
    await reconcileStalePrWorkers();

    const query = mockWorkersFindMany.mock.calls[0][0] as any;
    const where = describePredicate(query.where);
    expect(where).toContain('prLifecycleStatus');
    expect(where).toContain('merged');
    expect(where).toContain('closed');
    // Terminal for the same reason the other two are: re-asking GitHub cannot
    // change the answer, and a retired row must not re-enter the rotation.
    expect(where).toContain('unresolvable');
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
