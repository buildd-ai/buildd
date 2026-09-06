import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ─── DB mocks ─────────────────────────────────────────────────────────────────

const mockWorkersFindMany = mock(() => [] as any[]);
const mockMissionsFindMany = mock(() => [] as any[]);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockGithubReposFindFirst = mock(() => null as any);
const mockWorkersUpdate = mock(() => ({
  set: mock(() => ({ where: mock(() => Promise.resolve()) })),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      missions: { findMany: mockMissionsFindMany },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      githubRepos: { findFirst: mockGithubReposFindFirst },
    },
    update: () => mockWorkersUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => ({ args, op: 'and' }),
  lt: (a: any, b: any) => ({ a, b, op: 'lt' }),
  gt: (a: any, b: any) => ({ a, b, op: 'gt' }),
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
    prLastVerifiedAt: 'prLastVerifiedAt',
    prLifecycleStatus: 'prLifecycleStatus',
    prCheckFailureCount: 'prCheckFailureCount',
    completedAt: 'completedAt',
    createdAt: 'createdAt',
  },
  workspaces: { id: 'id', repo: 'repo' },
  githubRepos: { id: 'id', fullName: 'fullName' },
  missions: {
    id: 'id',
    status: 'status',
    workingBranch: 'workingBranch',
    integrationBranchEnabled: 'integrationBranchEnabled',
    updatedAt: 'updatedAt',
  },
}));

const mockCheckDependsOnResolved = mock(() => Promise.resolve(undefined));
mock.module('@/lib/task-dependencies', () => ({
  checkDependsOnResolved: mockCheckDependsOnResolved,
}));

// The mission dependency gate. `missions.dependencyMetAt` has exactly one
// writer, and the `merged` gate is cleared only by that column — so whether this
// fires on a healed merge is the difference between a downstream mission
// starting and waiting forever.
const mockCheckAndUnblockDependentMissions = mock(() => Promise.resolve([] as string[]));
mock.module('@/lib/mission-dependency', () => ({
  checkAndUnblockDependentMissions: mockCheckAndUnblockDependentMissions,
  // Full module surface: mock.module replaces a module for the whole process,
  // so a partial stub would delete these for any other importer in it.
  isMissionBlocked: mock(() => Promise.resolve({ blocked: false })),
  wouldCreateCycle: mock(() => Promise.resolve(false)),
}));

// The mission-PR module is a black box here. The opener is idempotent, returns
// null for a mission that never opted in and a `{ ok: false, reason }` for every
// "not yet" case; the two readers below are what let the sweep decide whether a
// mission is worth an opener call at all.
const mockMaybeOpenMissionIntegrationPr = mock(() => Promise.resolve(null as any));
const mockFindMissionPrOwner = mock(() => Promise.resolve(null as any));
const mockEvaluateMissionWorkState = mock(() => Promise.resolve({
  complete: true,
  reason: 'complete',
  unfinishedTaskCount: 0,
  unmergedPrCount: 0,
  landedOnIntegrationCount: 1,
} as any));
mock.module('@/lib/mission-pr', () => ({
  maybeOpenMissionIntegrationPr: mockMaybeOpenMissionIntegrationPr,
  findMissionPrOwner: mockFindMissionPrOwner,
  evaluateMissionWorkState: mockEvaluateMissionWorkState,
}));

// ─── GitHub API mock ──────────────────────────────────────────────────────────

const mockGithubApi = mock(() => Promise.resolve({ state: 'open', merged: false, merged_at: null }));

mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));

// ─── Import after mocks ───────────────────────────────────────────────────────

import {
  reconcileStalePrWorkers,
  refreshWorkerMergeStateIfStale,
  sweepMissionIntegrationPrs,
  RECONCILE_BATCH_CAP,
  MISSION_PR_SWEEP_CAP,
  MISSION_PR_SWEEP_WINDOW_MS,
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
    // AC-4: this path only ever writes on a confirmed merge, so it must stamp
    // the verification clock too — the admin backfill route relies on this to
    // clear rows into a state resolveStaleGate will actually treat as fresh.
    expect(setArgs[0]).toHaveProperty('prLastVerifiedAt');
    expect(setArgs[0].prLastVerifiedAt).toBeInstanceOf(Date);
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
    mockMaybeOpenMissionIntegrationPr.mockReset();
    mockMaybeOpenMissionIntegrationPr.mockResolvedValue(null);
    mockCheckAndUnblockDependentMissions.mockReset();
    mockCheckAndUnblockDependentMissions.mockResolvedValue([]);
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

  it('AC-4: advances prLastVerifiedAt alongside prLastCheckedAt when GitHub confirms merged', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 42, workspaceId: 'ws1' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z' });

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockWorkersUpdate.mockReturnValue({ set: setMock });

    await reconcileStalePrWorkers();

    const written = setMock.mock.calls[0][0] as Record<string, unknown>;
    expect(written.prLastCheckedAt).toBeInstanceOf(Date);
    expect(written.prLastVerifiedAt).toBeInstanceOf(Date);
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
    // AC-4: closed is a confirmed GitHub answer too — both clocks advance.
    const written = setMock.mock.calls[0][0] as Record<string, unknown>;
    expect(written.prLastVerifiedAt).toBeInstanceOf(Date);
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
    // AC-2/AC-4: a confirmed-still-open answer is a real GitHub answer, so the
    // verification clock advances too — this row is NOT the failure case.
    expect(written.prLastVerifiedAt).toBeInstanceOf(Date);
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
    // AC-2: a failure must never advance the verification clock — that is the
    // exact conflation that made resolveStaleGate's unverified branch dead.
    expect(written.prLastVerifiedAt).toBeUndefined();
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
    // AC-2/AC-5: going terminal is buildd giving up, not GitHub confirming
    // anything — the verification clock must stay untouched even here.
    expect(written.prLastVerifiedAt).toBeUndefined();
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
    // AC-2: the attempt clock advances on this GitHub error; the verification
    // clock must not, or this row reads as freshly verified while it is not.
    expect(written.prLastVerifiedAt).toBeUndefined();
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

  // ── Option A' — the mission PR opener needs a non-webhook trigger ──────────
  //
  // The webhook was the ONLY caller of maybeOpenMissionIntegrationPr, and
  // `workers.mergedAt` is documented as lossy in this repo. A lost delivery for
  // the last task PR therefore healed the row here an hour later and still left
  // the mission with no PR — and since the completion gate refuses a mission in
  // that state, a transient delivery gap became terminal.

  it("re-attempts the mission PR when it heals a missed merge", async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 42, workspaceId: 'ws1', taskId: 'task-42', task: { missionId: 'm1' } },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z' });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });

    const result = await reconcileStalePrWorkers();

    expect(result.stamped).toBe(1);
    expect(mockMaybeOpenMissionIntegrationPr).toHaveBeenCalledWith('m1');
  });

  it('asks the candidate query for the task mission link the opener needs', async () => {
    mockWorkersFindMany.mockResolvedValue([]);
    await reconcileStalePrWorkers();

    // Without this the sweep would have to re-read tasks one at a time, and a
    // missing relation would silently make the opener call unreachable.
    const query = mockWorkersFindMany.mock.calls[0][0] as any;
    expect(query.with?.task?.columns?.missionId).toBe(true);
  });

  it('does not call the opener for a worker whose task has no mission', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 42, workspaceId: 'ws1', taskId: 'task-42', task: { missionId: null } },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z' });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });

    await reconcileStalePrWorkers();

    expect(mockMaybeOpenMissionIntegrationPr).not.toHaveBeenCalled();
  });

  it('does not call the opener for a PR that is merely closed', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 43, workspaceId: 'ws1', taskId: 'task-43', task: { missionId: 'm1' } },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: false, merged_at: null });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });

    await reconcileStalePrWorkers();

    expect(mockMaybeOpenMissionIntegrationPr).not.toHaveBeenCalled();
  });

  it('tells the mission dependency gate when it heals a missed merge', async () => {
    // Same gap as the opener had, one tier down: a downstream mission whose
    // gateCondition is 'merged' is cleared ONLY by dependencyMetAt, and the
    // webhook and the dashboard merge route were the only two writers of it. A
    // lost delivery left that mission blocked with "Waiting for mission X PRs to
    // merge" until something unrelated poked it.
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 42, workspaceId: 'ws1', taskId: 'task-42', task: { missionId: 'm1' } },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z' });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });

    await reconcileStalePrWorkers();

    expect(mockCheckAndUnblockDependentMissions).toHaveBeenCalledWith('m1', 'merged');
  });

  it('raises the mission signal only after the opener has run', async () => {
    // Ordering is load-bearing: the mission PR must already exist, unmerged,
    // before missionHasUnmergedWork is asked — otherwise a task-PR merge would
    // unblock dependents early, before the mission's own gate had even opened.
    const order: string[] = [];
    mockMaybeOpenMissionIntegrationPr.mockImplementation(async () => { order.push('open'); return null; });
    mockCheckAndUnblockDependentMissions.mockImplementation(async () => { order.push('unblock'); return []; });
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 42, workspaceId: 'ws1', taskId: 'task-42', task: { missionId: 'm1' } },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z' });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });

    await reconcileStalePrWorkers();

    expect(order).toEqual(['open', 'unblock']);
  });

  it('does not raise the mission signal for a PR that is merely closed', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 43, workspaceId: 'ws1', taskId: 'task-43', task: { missionId: 'm1' } },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: false, merged_at: null });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });

    await reconcileStalePrWorkers();

    expect(mockCheckAndUnblockDependentMissions).not.toHaveBeenCalled();
  });

  it('a failing mission signal is logged, never fatal to the sweep', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 42, workspaceId: 'ws1', taskId: 'task-42', task: { missionId: 'm1' } },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z' });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
    mockCheckAndUnblockDependentMissions.mockRejectedValue(new Error('DB blip'));

    const orig = console.error;
    console.error = () => {};
    const result = await reconcileStalePrWorkers();
    console.error = orig;

    expect(result.stamped).toBe(1);
    // The task-level gate must still have been told.
    expect(mockCheckDependsOnResolved).toHaveBeenCalledWith('task-42');
  });

  it('asks the opener once per mission, however many of its PRs heal at once', async () => {
    // A batch can heal several workers of the same mission. The opener is
    // idempotent, so repeating it is safe — but each repeat is a handful of
    // queries inside a 60 s function for an answer that cannot have changed.
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 1, workspaceId: 'ws1', taskId: 'ta', task: { missionId: 'm1' } },
      { id: 'w2', prNumber: 2, workspaceId: 'ws1', taskId: 'tb', task: { missionId: 'm1' } },
      { id: 'w3', prNumber: 3, workspaceId: 'ws1', taskId: 'tc', task: { missionId: 'm2' } },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z' });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });

    const result = await reconcileStalePrWorkers();

    expect(result.stamped).toBe(3);
    expect(mockMaybeOpenMissionIntegrationPr).toHaveBeenCalledTimes(2);
    expect(mockMaybeOpenMissionIntegrationPr).toHaveBeenCalledWith('m1');
    expect(mockMaybeOpenMissionIntegrationPr).toHaveBeenCalledWith('m2');
    // Both mission-level effects share the one dedupe: the signal is idempotent,
    // but it is also two counting queries per call.
    expect(mockCheckAndUnblockDependentMissions).toHaveBeenCalledTimes(2);
  });

  it('an opener failure is logged, never fatal to the sweep', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 42, workspaceId: 'ws1', taskId: 'task-42', task: { missionId: 'm1' } },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z' });
    mockWorkersUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
    mockMaybeOpenMissionIntegrationPr.mockRejectedValue(new Error('GitHub 500'));

    const orig = console.error;
    console.error = () => {};
    const result = await reconcileStalePrWorkers();
    console.error = orig;

    expect(result.stamped).toBe(1);
    // The dependency gate must still have been told.
    expect(mockCheckDependsOnResolved).toHaveBeenCalledWith('task-42');
  });
});

// ─── Mission PR sweep ─────────────────────────────────────────────────────────
//
// Some states reach "work complete" with NO PR-merge event at all: the last
// deliverable finishes with outputRequirement 'none', or every deliverable task
// is cancelled. Nothing in the merge path can heal those, so the cron needs a
// trigger that does not depend on a merge having happened.

describe('sweepMissionIntegrationPrs', () => {
  const workState = (over: Record<string, unknown> = {}) => ({
    complete: true,
    reason: 'complete',
    unfinishedTaskCount: 0,
    unmergedPrCount: 0,
    landedOnIntegrationCount: 1,
    ...over,
  });

  beforeEach(() => {
    mockMissionsFindMany.mockReset();
    mockMissionsFindMany.mockResolvedValue([]);
    mockMaybeOpenMissionIntegrationPr.mockReset();
    mockMaybeOpenMissionIntegrationPr.mockResolvedValue({ ok: true, prNumber: 5, prUrl: 'u', created: true });
    mockFindMissionPrOwner.mockReset();
    mockFindMissionPrOwner.mockResolvedValue(null);
    mockEvaluateMissionWorkState.mockReset();
    mockEvaluateMissionWorkState.mockResolvedValue(workState());
    mockGithubApi.mockReset();
  });

  it('returns zeros and asks nothing when there are no opted-in missions', async () => {
    const result = await sweepMissionIntegrationPrs();
    expect(result.total).toBe(0);
    expect(result.opened).toBe(0);
    expect(mockMaybeOpenMissionIntegrationPr).not.toHaveBeenCalled();
  });

  it('bounds the candidate set to opted-in missions with an integration branch', async () => {
    await sweepMissionIntegrationPrs();

    const query = mockMissionsFindMany.mock.calls[0][0] as any;
    const where = describePredicate(query.where);
    // Opted-in ONLY: a mission that never set the flag has no mission PR to open,
    // and scanning every mission on every tick is exactly what must not happen.
    expect(where).toContain('integrationBranchEnabled');
    expect(where).toContain('workingBranch');
    // Still-live missions only.
    expect(where).toContain('status');
    // And a recency window, so a mission that has genuinely gone quiet leaves the
    // candidate set instead of being retried until the end of time.
    expect(where).toContain('updatedAt');
    expect(query.limit).toBe(MISSION_PR_SWEEP_CAP);
    expect(query.orderBy).toBeDefined();
    expect(MISSION_PR_SWEEP_WINDOW_MS).toBeLessThanOrEqual(30 * DAY_MS);
  });

  it('opens the mission PR for a mission that reached completeness with no merge event', async () => {
    mockMissionsFindMany.mockResolvedValue([{ id: 'm1' }]);

    const result = await sweepMissionIntegrationPrs();

    expect(mockMaybeOpenMissionIntegrationPr).toHaveBeenCalledWith('m1');
    expect(result.opened).toBe(1);
    expect(result.total).toBe(1);
  });

  it('leaves a mission whose PR is already open alone, without calling the opener', async () => {
    mockMissionsFindMany.mockResolvedValue([{ id: 'm1' }]);
    mockFindMissionPrOwner.mockResolvedValue({
      taskId: 't', workerId: 'w', prNumber: 9, prUrl: 'u', mergedAt: null, state: 'open',
    });

    const result = await sweepMissionIntegrationPrs();

    expect(result.alreadyOpen).toBe(1);
    expect(result.opened).toBe(0);
    expect(mockMaybeOpenMissionIntegrationPr).not.toHaveBeenCalled();
  });

  it('never reopens a mission PR a human closed, and says nothing about it', async () => {
    mockMissionsFindMany.mockResolvedValue([{ id: 'm1' }]);
    mockFindMissionPrOwner.mockResolvedValue({
      taskId: 't', workerId: 'w', prNumber: 9, prUrl: 'u', mergedAt: null, state: 'closed',
    });

    const logs: unknown[][] = [];
    const origErr = console.error;
    const origWarn = console.warn;
    console.error = (...a: unknown[]) => { logs.push(a); };
    console.warn = (...a: unknown[]) => { logs.push(a); };
    const result = await sweepMissionIntegrationPrs();
    console.error = origErr;
    console.warn = origWarn;

    expect(result.prClosed).toBe(1);
    expect(mockMaybeOpenMissionIntegrationPr).not.toHaveBeenCalled();
    // Closing the mission PR is a decision. Re-litigating it hourly in the logs
    // is the spam this sweep must not produce.
    expect(logs).toEqual([]);
  });

  it('does not ask GitHub anything for a mission with nothing landed on its branch', async () => {
    mockMissionsFindMany.mockResolvedValue([{ id: 'm1' }]);
    // Work is "complete" — every deliverable is terminal — but nothing merged
    // into the integration branch (all cancelled, or all artifact-only). There
    // is no PR to open, and asking GitHub to compare an empty branch every hour
    // is a cost with no possible outcome.
    mockEvaluateMissionWorkState.mockResolvedValue(workState({ landedOnIntegrationCount: 0 }));

    const logs: unknown[][] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => { logs.push(a); };
    const result = await sweepMissionIntegrationPrs();
    console.error = origErr;

    expect(result.nothingToShip).toBe(1);
    expect(mockMaybeOpenMissionIntegrationPr).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it('skips a mission whose work is not finished yet', async () => {
    mockMissionsFindMany.mockResolvedValue([{ id: 'm1' }]);
    mockEvaluateMissionWorkState.mockResolvedValue(
      workState({ complete: false, reason: 'tasks_unfinished', unfinishedTaskCount: 2 }),
    );

    const result = await sweepMissionIntegrationPrs();

    expect(result.notReady).toBe(1);
    expect(mockMaybeOpenMissionIntegrationPr).not.toHaveBeenCalled();
  });

  it('one failing mission does not stop the sweep', async () => {
    mockMissionsFindMany.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);
    mockMaybeOpenMissionIntegrationPr
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true, prNumber: 7, prUrl: 'u', created: true });

    const orig = console.error;
    console.error = () => {};
    const result = await sweepMissionIntegrationPrs();
    console.error = orig;

    expect(result.errors).toBe(1);
    expect(result.opened).toBe(1);
  });

  it('counts an api_error as an error rather than a silent skip', async () => {
    mockMissionsFindMany.mockResolvedValue([{ id: 'm1' }]);
    mockMaybeOpenMissionIntegrationPr.mockResolvedValue({ ok: false, reason: 'api_error', detail: '500' });

    const orig = console.error;
    console.error = () => {};
    const result = await sweepMissionIntegrationPrs();
    console.error = orig;

    expect(result.errors).toBe(1);
    expect(result.opened).toBe(0);
  });

  it('treats a mission_pr_closed race as terminal, not as an error', async () => {
    mockMissionsFindMany.mockResolvedValue([{ id: 'm1' }]);
    mockMaybeOpenMissionIntegrationPr.mockResolvedValue({ ok: false, reason: 'mission_pr_closed' });

    const result = await sweepMissionIntegrationPrs();

    expect(result.prClosed).toBe(1);
    expect(result.errors).toBe(0);
  });
});

// ── Repo resolution ─────────────────────────────────────────────────────────
//
// Measured against production, September 2026: every card in the "waiting on
// you" queue was a PR that had already merged or closed, some of them months
// earlier. Three independent defects, all in the one line that built the API
// path from `workspaces.repo`:
//
//   1. That column stores a URL (`https://github.com/owner/name`) for nearly
//      every workspace, not a slug. The request went to
//      `/repos/https://github.com/owner/name/pulls/N`, which is a 404, on every
//      run. The fixtures in this file all used a bare `owner/repo`, so nothing
//      here ever exercised the shape the database actually holds — that is why
//      the whole tier-2 sweep could be dead in production with a green suite.
//   2. A worker's PR is frequently NOT in its workspace's repo (a sibling
//      mobile repo, an umbrella repo). Even with (1) fixed, the sweep asked the
//      wrong repo for the PR number and got someone else's PR or a 404.
//   3. Coordination workspaces have no repo at all, so their PRs were
//      unreconcilable forever — while every one of those rows carried a `prUrl`
//      naming a real, installed repo.
//
// `workers.prUrl` is the authoritative source for a PR's repo. The workspace is
// a fallback, never the primary.

describe('reconcileStalePrWorkers repo resolution', () => {
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockGithubApi.mockReset();
    mockCheckDependsOnResolved.mockReset();
    mockMissionsFindMany.mockResolvedValue([]);
    mockWorkersUpdate.mockReturnValue({
      set: mock(() => ({ where: mock(() => Promise.resolve()) })),
    });
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null });
  });

  it('builds a slug API path from a URL-shaped workspaces.repo', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 42, workspaceId: 'ws1', prUrl: null, prCheckFailureCount: 0 },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({
      repo: 'https://github.com/owner/repo',
      githubRepo: { installation: { installationId: 123 } },
    });

    await reconcileStalePrWorkers();

    expect(mockGithubApi).toHaveBeenCalledWith(123, '/repos/owner/repo/pulls/42');
  });

  it('queries the repo the PR actually lives in, not the workspace repo', async () => {
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'w1',
        prNumber: 25,
        workspaceId: 'ws1',
        prUrl: 'https://github.com/owner/sibling-ios/pull/25',
        prCheckFailureCount: 0,
      },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({
      repo: 'https://github.com/owner/repo',
      githubRepo: { installation: { installationId: 123 } },
    });
    mockGithubReposFindFirst.mockResolvedValue({ installation: { installationId: 456 } });

    await reconcileStalePrWorkers();

    // The PR's own repo, with the installation that actually covers it.
    expect(mockGithubApi).toHaveBeenCalledWith(456, '/repos/owner/sibling-ios/pulls/25');
  });

  it('reconciles a worker whose workspace has no repo, using its prUrl', async () => {
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'w1',
        prNumber: 58,
        workspaceId: 'ws-coord',
        prUrl: 'https://github.com/owner/repo/pull/58',
        prCheckFailureCount: 0,
        completedAt: ancientOpenedAt,
      },
    ]);
    // A coordination workspace: no repo, no installation pointer of its own.
    mockWorkspacesFindFirst.mockResolvedValue({ repo: '', githubInstallation: null });
    mockGithubReposFindFirst.mockResolvedValue({ installation: { installationId: 789 } });
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: true, merged_at: '2026-06-05T22:43:47Z' });

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockWorkersUpdate.mockReturnValue({ set: setMock });

    const result = await reconcileStalePrWorkers();

    expect(mockGithubApi).toHaveBeenCalledWith(789, '/repos/owner/repo/pulls/58');
    expect(result.stamped).toBe(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ prLifecycleStatus: 'merged' }),
    );
  });

  it('records a failure, not a clean check, when no repo resolves from either source', async () => {
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'w1',
        prNumber: 1,
        workspaceId: 'ws-coord',
        prUrl: null,
        prCheckFailureCount: 0,
        completedAt: ancientOpenedAt,
      },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({ repo: null, githubInstallation: null });

    const setMock = mock(() => ({ where: mock(() => Promise.resolve()) }));
    mockWorkersUpdate.mockReturnValue({ set: setMock });

    const result = await reconcileStalePrWorkers();

    expect(mockGithubApi).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    const written = setMock.mock.calls[0][0] as Record<string, unknown>;
    expect(written.prLastCheckedAt).toBeInstanceOf(Date);
    expect(written.prCheckFailureCount).toBe(1);
    expect(written.prLastVerifiedAt).toBeUndefined();
  });

  it('does not fabricate a PR number from a pull/new compare url', async () => {
    // A worker that prepared a branch but never opened a PR stores
    // `.../pull/new/<branch>` with prNumber NULL. If such a row ever reaches
    // the sweep with a number attached, the repo must still come out clean and
    // the branch name must never land in the API path.
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'w1',
        prNumber: 9,
        workspaceId: 'ws1',
        prUrl: 'https://github.com/owner/other/pull/new/feat/branch',
        prCheckFailureCount: 0,
      },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({
      repo: 'https://github.com/owner/repo',
      githubRepo: { installation: { installationId: 123 } },
    });

    await reconcileStalePrWorkers();

    // Falls back to the workspace repo rather than trusting the compare url.
    expect(mockGithubApi).toHaveBeenCalledWith(123, '/repos/owner/repo/pulls/9');
  });
});
