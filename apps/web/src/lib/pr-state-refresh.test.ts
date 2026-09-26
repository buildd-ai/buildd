import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

// ─── DB mocks ─────────────────────────────────────────────────────────────────

const mockWorkersFindMany = mock(() => [] as any[]);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockGithubReposFindFirst = mock(() => null as any);
const mockWorkersUpdate = mock(() => ({
  set: mock(() => ({ where: mock(() => Promise.resolve()) })),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      githubRepos: { findFirst: mockGithubReposFindFirst },
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
    prLifecycleStatus: 'prLifecycleStatus',
    prLastCheckedAt: 'prLastCheckedAt',
    prLastVerifiedAt: 'prLastVerifiedAt',
    workspaceId: 'workspaceId',
    id: 'id',
  },
  workspaces: { id: 'id', repo: 'repo' },
  githubRepos: { id: 'id', fullName: 'fullName' },
}));

// ─── GitHub API mock ──────────────────────────────────────────────────────────

const mockGithubApi = mock(() =>
  Promise.resolve({ state: 'open', merged: false, merged_at: null }),
);
const mockFetchCiLifecycleStatus = mock(() => Promise.resolve(null as 'ci_green' | 'ci_failed' | 'ci_running' | null));
mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
  fetchCiLifecycleStatus: mockFetchCiLifecycleStatus,
}));

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
  _resetFailureBackoffForTests,
  FAILURE_BACKOFF_MS,
  RATE_LIMIT_PAUSE_MS,
  isGithubRateLimitError,
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
    mockFetchCiLifecycleStatus.mockReset();
    mockTriggerEvent.mockReset();
    mockCheckDependsOnResolved.mockClear();
    _resetFailureBackoffForTests();
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
      expect.objectContaining({
        prLifecycleStatus: 'merged',
        prLastCheckedAt: expect.any(Date),
        // AC-4: this write only ever happens after a successful GitHub call
        // (the catch branch below writes nothing at all), so it is always a
        // confirmed answer — the verification clock advances alongside the
        // attempt clock.
        prLastVerifiedAt: expect.any(Date),
      }),
    );
    expect(mockTriggerEvent).toHaveBeenCalledWith(
      expect.stringContaining('ws1'),
      'worker:progress',
      expect.objectContaining({ taskId: 'task1' }),
    );
    expect(mockCheckDependsOnResolved).toHaveBeenCalledWith('task1');
  });

  it('stamps mergedAt when webhook was missed for an externally-merged PR (pr_open + null prLastCheckedAt)', async () => {
    // Regression: home page Waiting-on-You showed REVIEW for merged PRs because
    // refreshStaleWorkersForWorkspaces was never called before openPrWorkers query.
    // This verifies the refresh correctly stamps workers whose merge webhook was dropped.
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w-missed', prNumber: 1826, workspaceId: 'ws1', taskId: 'task-missed' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({
      state: 'closed',
      merged: true,
      merged_at: '2026-08-27T07:00:00Z',
    });

    const setMock = makeSetMock();
    await refreshStaleWorkersForWorkspaces(['ws1']);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mergedAt: expect.any(Date),
        prLifecycleStatus: 'merged',
        prLastCheckedAt: expect.any(Date),
      }),
    );
    expect(mockCheckDependsOnResolved).toHaveBeenCalledWith('task-missed');
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
      expect.objectContaining({
        prLifecycleStatus: 'closed',
        prLastCheckedAt: expect.any(Date),
        prLastVerifiedAt: expect.any(Date),
      }),
    );
    expect(mockCheckDependsOnResolved).not.toHaveBeenCalled();
  });

  it('stamps prLastCheckedAt and prLastVerifiedAt for open PRs (no lifecycle change)', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 7, workspaceId: 'ws1', taskId: 'task1' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null });

    const setMock = makeSetMock();
    await refreshStaleWorkersForWorkspaces(['ws1']);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ prLastCheckedAt: expect.any(Date), prLastVerifiedAt: expect.any(Date) }),
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
    mockWorkspacesFindFirst.mockResolvedValue({
      repo: null,
      githubRepo: null,
      githubInstallation: null,
    });

    await refreshStaleWorkersForWorkspaces(['ws-no-gh']);

    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  it('uses the repo-mediated installation, not the stale legacy FK', async () => {
    // Regression (2026-08-22 freeze): a GitHub App reinstall left
    // workspaces.githubInstallationId pointing at a dead installation. Its token
    // is valid but has no repo access, so every PR lookup 404'd, mergedAt was
    // never stamped, and both claim gates that read it deadlocked the queue.
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 42, workspaceId: 'ws1', taskId: 'task1' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({
      repo: 'owner/repo',
      githubRepo: { installation: { installationId: 90000002 } },
      githubInstallation: { installationId: 90000001 },
    });
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null });

    makeSetMock();
    await refreshStaleWorkersForWorkspaces(['ws1']);

    expect(mockGithubApi).toHaveBeenCalledWith(90000002, '/repos/owner/repo/pulls/42');
  });

  it('falls back to the legacy FK when the workspace has no linked repo', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 42, workspaceId: 'ws1', taskId: 'task1' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({
      repo: 'owner/repo',
      githubRepo: null,
      githubInstallation: { installationId: 90000001 },
    });
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null });

    makeSetMock();
    await refreshStaleWorkersForWorkspaces(['ws1']);

    expect(mockGithubApi).toHaveBeenCalledWith(90000001, '/repos/owner/repo/pulls/42');
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
    mockFetchCiLifecycleStatus.mockReset();
    mockTriggerEvent.mockReset();
    mockCheckDependsOnResolved.mockClear();
    _resetFailureBackoffForTests();
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

  // AC-1: ci_failed worker whose PR CI is now green refreshes to ci_green
  it('AC-1: updates ci_failed → ci_green when live CI passes', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null, head: { sha: 'sha-abc' } });
    mockFetchCiLifecycleStatus.mockResolvedValue('ci_green');
    const setMock = makeSetMock();

    await refreshStaleWorkers([
      {
        id: 'w-ci-fail',
        prNumber: 42,
        workspaceId: 'ws1',
        taskId: 't1',
        prLifecycleStatus: 'ci_failed',
        prLastCheckedAt: FIVE_MIN_AGO,
      },
    ]);

    expect(mockFetchCiLifecycleStatus).toHaveBeenCalledWith(123, 'owner/repo', 'sha-abc');
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ prLifecycleStatus: 'ci_green' }),
    );
  });

  // AC-2: ci_green worker whose PR CI is now red refreshes to ci_failed
  it('AC-2: updates ci_green → ci_failed when live CI fails', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null, head: { sha: 'sha-def' } });
    mockFetchCiLifecycleStatus.mockResolvedValue('ci_failed');
    const setMock = makeSetMock();

    await refreshStaleWorkers([
      {
        id: 'w-ci-green',
        prNumber: 99,
        workspaceId: 'ws1',
        taskId: 't2',
        prLifecycleStatus: 'ci_green',
        prLastCheckedAt: FIVE_MIN_AGO,
      },
    ]);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ prLifecycleStatus: 'ci_failed' }),
    );
  });

  // AC-6: #2010 regression — worker stuck as ci_green (renders as Open), live CI
  // shows failure. Before fix: badge silently showed Open. After: badge shows
  // CI failing once refresh corrects the stored status.
  it('AC-6: #2010 regression — ci_green with live CI failure corrects to ci_failed', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null, head: { sha: 'sha-2010' } });
    mockFetchCiLifecycleStatus.mockResolvedValue('ci_failed');
    const setMock = makeSetMock();

    await refreshStaleWorkers([
      {
        id: 'w-2010',
        prNumber: 2010,
        workspaceId: 'ws1',
        taskId: 't-2010',
        // ci_green was set by webhook after first pass; pr-presentation maps ci_green→Open
        // so Activity showed OPEN #2010 while GitHub reported 6/7 failed.
        prLifecycleStatus: 'ci_green',
        prLastCheckedAt: FIVE_MIN_AGO,
      },
    ]);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ prLifecycleStatus: 'ci_failed' }),
    );
  });

  it('does not call fetchCiLifecycleStatus for non-CI prLifecycleStatus', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null, head: { sha: 'sha-open' } });
    makeSetMock();

    await refreshStaleWorkers([
      {
        id: 'w-open',
        prNumber: 5,
        workspaceId: 'ws1',
        taskId: 't3',
        prLifecycleStatus: 'pr_open',
        prLastCheckedAt: FIVE_MIN_AGO,
      },
    ]);

    expect(mockFetchCiLifecycleStatus).not.toHaveBeenCalled();
  });

  it('does not overwrite prLifecycleStatus when CI state is unchanged', async () => {
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null, head: { sha: 'sha-same' } });
    mockFetchCiLifecycleStatus.mockResolvedValue('ci_failed');
    const setMock = makeSetMock();

    await refreshStaleWorkers([
      {
        id: 'w-same',
        prNumber: 7,
        workspaceId: 'ws1',
        taskId: 't4',
        prLifecycleStatus: 'ci_failed',
        prLastCheckedAt: FIVE_MIN_AGO,
      },
    ]);

    // prLifecycleStatus should not be in the update when state is unchanged
    expect(setMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ prLifecycleStatus: expect.anything() }),
    );
  });
});

// ── Repo resolution ─────────────────────────────────────────────────────────
//
// Tier 1 had the identical defect as the tier-2 sweep (see pr-reconcile.test.ts
// for the full account): it built `/repos/${workspaces.repo}/pulls/N`, and that
// column holds a URL for nearly every workspace. With both tiers 404ing, the
// only thing that ever wrote a PR lifecycle status in production was the
// `pull_request` webhook — which is known-lossy, and is exactly what these two
// tiers exist to heal.
//
// The `ws` fixture above uses a bare `owner/repo`, which is why the existing
// suite passed throughout. These use the shape the database actually holds.

describe('pr-state-refresh repo resolution', () => {
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockGithubApi.mockReset();
    mockFetchCiLifecycleStatus.mockReset();
    mockTriggerEvent.mockReset();
    mockCheckDependsOnResolved.mockClear();
    _resetFailureBackoffForTests();
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null, head: { sha: 'abc' } });
  });

  it('builds a slug API path from a URL-shaped workspaces.repo', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 42, workspaceId: 'ws1', taskId: 't1', prUrl: null, prLifecycleStatus: 'pr_open' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({
      repo: 'https://github.com/owner/repo',
      githubRepo: { installation: { installationId: 123 } },
    });
    makeSetMock();

    await refreshStaleWorkersForWorkspaces(['ws1']);

    expect(mockGithubApi).toHaveBeenCalledWith(123, '/repos/owner/repo/pulls/42');
  });

  it('queries the repo the PR actually lives in, not the workspace repo', async () => {
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'w1',
        prNumber: 13,
        workspaceId: 'ws1',
        taskId: 't1',
        prUrl: 'https://github.com/owner/sibling-ios/pull/13',
        prLifecycleStatus: 'pr_open',
      },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({
      repo: 'https://github.com/owner/repo',
      githubRepo: { installation: { installationId: 123 } },
    });
    mockGithubReposFindFirst.mockResolvedValue({ installation: { installationId: 456 } });
    makeSetMock();

    await refreshStaleWorkersForWorkspaces(['ws1']);

    expect(mockGithubApi).toHaveBeenCalledWith(456, '/repos/owner/sibling-ios/pulls/13');
  });

  it('refreshes a worker whose workspace has no repo, using its prUrl', async () => {
    mockWorkersFindMany.mockResolvedValue([
      {
        id: 'w1',
        prNumber: 58,
        workspaceId: 'ws-coord',
        taskId: 't1',
        prUrl: 'https://github.com/owner/repo/pull/58',
        prLifecycleStatus: null,
      },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({ repo: null, githubInstallation: null });
    mockGithubReposFindFirst.mockResolvedValue({ installation: { installationId: 789 } });
    mockGithubApi.mockResolvedValue({ state: 'closed', merged: true, merged_at: '2026-06-05T22:43:47Z', head: { sha: 'abc' } });
    const setMock = makeSetMock();

    await refreshStaleWorkersForWorkspaces(['ws-coord']);

    expect(mockGithubApi).toHaveBeenCalledWith(789, '/repos/owner/repo/pulls/58');
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ prLifecycleStatus: 'merged' }),
    );
  });

  it('takes the fallback repo from the linked row, not the stale text column', async () => {
    // See the matching case in pr-reconcile.test.ts: the linked github_repos
    // row follows a repo rename, the free-text column does not.
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 42, workspaceId: 'ws1', taskId: 't1', prUrl: null, prLifecycleStatus: 'pr_open' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({
      repo: 'https://github.com/owner/old-name',
      githubRepo: { fullName: 'owner/new-name', repoId: 12345, installation: { installationId: 123 } },
    });
    makeSetMock();

    await refreshStaleWorkersForWorkspaces(['ws1']);

    expect(mockGithubApi).toHaveBeenCalledWith(123, '/repos/owner/new-name/pulls/42');
  });

  it('asks for prUrl in the candidate column set', async () => {
    // Without the column the resolver only ever sees the workspace repo, which
    // silently reinstates both bugs.
    mockWorkersFindMany.mockResolvedValue([]);
    await refreshStaleWorkersForWorkspaces(['ws1']);
    const columns = (mockWorkersFindMany.mock.calls[0][0] as any).columns;
    expect(columns.prUrl).toBe(true);
  });

  it('skips the GitHub call when no repo resolves from either source', async () => {
    mockWorkersFindMany.mockResolvedValue([
      { id: 'w1', prNumber: 1, workspaceId: 'ws-coord', taskId: 't1', prUrl: null, prLifecycleStatus: null },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({ repo: null, githubInstallation: null });
    makeSetMock();

    await refreshStaleWorkersForWorkspaces(['ws-coord']);

    expect(mockGithubApi).not.toHaveBeenCalled();
  });
});

// ─── Tests: failure backoff (render-path cost of a persistently failing PR) ──
//
// A GitHub error leaves prLastCheckedAt untouched (the attempt clock belongs to
// pr-reconcile, which counts failures toward `unresolvable`). But the rows it
// leaves behind are the OLDEST-checked, so they head every batch: before the
// backoff, each Home render re-issued the same failing GitHub calls, 200 ms
// apart, blocking the render. The backoff is in-process only — no DB clock
// moves — and holds a failed row out for the same window a success does.

const realNow = Date.now;
/** Pins Date.now for the module under test; afterEach always restores it. */
function setNow(ms: number) {
  Date.now = () => ms;
}

describe('pr-state-refresh failure backoff', () => {
  afterEach(() => {
    Date.now = realNow;
  });
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockGithubApi.mockReset();
    mockFetchCiLifecycleStatus.mockReset();
    mockTriggerEvent.mockReset();
    _resetFailureBackoffForTests();
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    makeSetMock();
  });

  const stale = (id: string) => ({
    id, prNumber: 7, workspaceId: 'ws1', taskId: `t-${id}`, prLifecycleStatus: 'pr_open', prLastCheckedAt: null,
  });

  /** Flattens the and/or tree the drizzle mock records into its leaf ops. */
  function leaves(node: any): any[] {
    if (!node || typeof node !== 'object') return [];
    if (node.op === 'and' || node.op === 'or') return node.args.flatMap(leaves);
    return [node];
  }

  it('does not re-call GitHub for a row that just failed (pre-fetched path)', async () => {
    mockGithubApi.mockRejectedValue(new Error('GitHub API error: 404 Not Found'));
    await refreshStaleWorkers([stale('w-bad')]);
    expect(mockGithubApi).toHaveBeenCalledTimes(1);

    await refreshStaleWorkers([stale('w-bad')]);
    expect(mockGithubApi).toHaveBeenCalledTimes(1);
  });

  it('excludes backed-off rows in SQL so they cannot fill the batch cap (DB path)', async () => {
    mockWorkersFindMany.mockResolvedValue([stale('w-bad')]);
    mockGithubApi.mockRejectedValue(new Error('GitHub API error: 500'));
    await refreshStaleWorkersForWorkspaces(['ws1']);

    const firstWhere = (mockWorkersFindMany.mock.calls[0] as any[])[0].where;
    expect(leaves(firstWhere).some(l => l.op === 'notInArray' && l.a === 'id')).toBe(false);

    mockWorkersFindMany.mockResolvedValue([]);
    await refreshStaleWorkersForWorkspaces(['ws1']);
    const secondWhere = (mockWorkersFindMany.mock.calls[1] as any[])[0].where;
    const exclusion = leaves(secondWhere).find(l => l.op === 'notInArray' && l.a === 'id');
    expect(exclusion).toBeDefined();
    expect(exclusion.b).toEqual(['w-bad']);
  });

  it('retries the row once the backoff window has passed', async () => {
    mockGithubApi.mockRejectedValue(new Error('GitHub API error: 502'));
    const t0 = realNow();
    setNow(t0);
    await refreshStaleWorkers([stale('w-bad')]);
    setNow(t0 + FAILURE_BACKOFF_MS - 1);
    await refreshStaleWorkers([stale('w-bad')]);
    expect(mockGithubApi).toHaveBeenCalledTimes(1);
    setNow(t0 + FAILURE_BACKOFF_MS + 1);
    await refreshStaleWorkers([stale('w-bad')]);
    expect(mockGithubApi).toHaveBeenCalledTimes(2);
  });

  it('only backs off the row that failed, not its neighbours', async () => {
    mockGithubApi.mockImplementation((_inst: number, path: string) =>
      path.endsWith('/pulls/1')
        ? Promise.reject(new Error('GitHub API error: 404'))
        : Promise.resolve({ state: 'open', merged: false, merged_at: null }),
    );
    await refreshStaleWorkers([{ ...stale('w-bad'), prNumber: 1 }, { ...stale('w-ok'), prNumber: 2 }]);
    mockGithubApi.mockClear();
    await refreshStaleWorkers([{ ...stale('w-bad'), prNumber: 1 }, { ...stale('w-ok'), prNumber: 2 }]);
    expect(mockGithubApi).toHaveBeenCalledTimes(1);
    expect((mockGithubApi.mock.calls[0] as any[])[1]).toEndWith('/pulls/2');
  });

  it('a success inside the window clears the backoff (overlapping renders)', async () => {
    // Two renders pick the same row before either finishes: the first call
    // fails, the second succeeds a moment later. The success is newer truth,
    // so the row must not stay held out for the rest of the window.
    const t0 = realNow();
    setNow(t0);
    let call = 0;
    mockGithubApi.mockImplementation(() => {
      call++;
      return call === 1
        ? Promise.reject(new Error('GitHub API error: 502'))
        : new Promise(res => setTimeout(() => res({ state: 'open', merged: false, merged_at: null }), 20));
    });
    await Promise.all([refreshStaleWorkers([stale('w-flaky')]), refreshStaleWorkers([stale('w-flaky')])]);
    expect(call).toBe(2);

    setNow(t0 + 1); // well inside FAILURE_BACKOFF_MS
    mockWorkersFindMany.mockResolvedValue([]);
    await refreshStaleWorkersForWorkspaces(['ws1']);
    const where = (mockWorkersFindMany.mock.calls[0] as any[])[0].where;
    expect(leaves(where).some(l => l.op === 'notInArray' && l.a === 'id')).toBe(false);
  });

  it('never writes a DB clock for a failed row (attempt clock stays with pr-reconcile)', async () => {
    const setMock = makeSetMock();
    mockGithubApi.mockRejectedValue(new Error('GitHub API error: 404'));
    await refreshStaleWorkers([stale('w-bad')]);
    await refreshStaleWorkers([stale('w-bad')]);
    expect(setMock).not.toHaveBeenCalled();
  });
});

describe('pr-state-refresh GitHub rate limit', () => {
  afterEach(() => {
    Date.now = realNow;
  });
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkersUpdate.mockReset();
    mockGithubApi.mockReset();
    mockFetchCiLifecycleStatus.mockReset();
    mockTriggerEvent.mockReset();
    _resetFailureBackoffForTests();
    mockWorkspacesFindFirst.mockResolvedValue(ws);
    makeSetMock();
  });

  const row = (id: string, prNumber: number) => ({
    id, prNumber, workspaceId: 'ws1', taskId: `t-${id}`, prLifecycleStatus: 'pr_open', prLastCheckedAt: null,
  });

  it('classifies 429 and rate-limit 403s, not permission 403s or other errors', () => {
    expect(isGithubRateLimitError(new Error('GitHub API error: 429 Too Many Requests'))).toBe(true);
    expect(isGithubRateLimitError(new Error('GitHub API error: 403 {"message":"API rate limit exceeded for installation"}'))).toBe(true);
    expect(isGithubRateLimitError(new Error('GitHub API error: 403 {"message":"You have exceeded a secondary rate limit"}'))).toBe(true);
    expect(isGithubRateLimitError(new Error('GitHub API error: 403 {"message":"Resource not accessible by integration"}'))).toBe(false);
    expect(isGithubRateLimitError(new Error('GitHub API error: 404 Not Found'))).toBe(false);
    expect(isGithubRateLimitError(new Error('fetch failed'))).toBe(false);
  });

  it('stops the batch at the first rate-limited call', async () => {
    mockGithubApi.mockRejectedValue(new Error('GitHub API error: 429 Too Many Requests'));
    await refreshStaleWorkers([row('w1', 1), row('w2', 2), row('w3', 3)]);
    expect(mockGithubApi).toHaveBeenCalledTimes(1);
  });

  it('skips the whole fast path (no SELECT, no GitHub) until the cutoff, then resumes', async () => {
    const t0 = realNow();
    setNow(t0);
    mockGithubApi.mockRejectedValue(new Error('GitHub API error: 403 API rate limit exceeded'));
    await refreshStaleWorkers([row('w1', 1)]);
    expect(mockGithubApi).toHaveBeenCalledTimes(1);

    setNow(t0 + RATE_LIMIT_PAUSE_MS - 1);
    mockWorkersFindMany.mockResolvedValue([row('w2', 2)]);
    await refreshStaleWorkersForWorkspaces(['ws1']);
    await refreshStaleWorkers([row('w3', 3)]);
    expect(mockWorkersFindMany).not.toHaveBeenCalled();
    expect(mockGithubApi).toHaveBeenCalledTimes(1);

    setNow(t0 + RATE_LIMIT_PAUSE_MS + 1);
    mockGithubApi.mockResolvedValue({ state: 'open', merged: false, merged_at: null });
    await refreshStaleWorkersForWorkspaces(['ws1']);
    expect(mockWorkersFindMany).toHaveBeenCalledTimes(1);
    expect(mockGithubApi).toHaveBeenCalledTimes(2);
  });

  it('a permission 403 is a per-row failure: the batch continues', async () => {
    mockGithubApi.mockImplementation((_i: number, path: string) =>
      path.endsWith('/pulls/1')
        ? Promise.reject(new Error('GitHub API error: 403 Resource not accessible by integration'))
        : Promise.resolve({ state: 'open', merged: false, merged_at: null }),
    );
    await refreshStaleWorkers([row('w1', 1), row('w2', 2)]);
    expect(mockGithubApi).toHaveBeenCalledTimes(2);
  });

  it('a rate limit does not put the row itself into per-row backoff', async () => {
    const t0 = realNow();
    setNow(t0);
    mockGithubApi.mockRejectedValue(new Error('GitHub API error: 429'));
    await refreshStaleWorkers([row('w1', 1)]);
    setNow(t0 + RATE_LIMIT_PAUSE_MS + 1);
    mockWorkersFindMany.mockResolvedValue([]);
    await refreshStaleWorkersForWorkspaces(['ws1']);
    const where = (mockWorkersFindMany.mock.calls[0] as any[])[0].where;
    const flat = (n: any): any[] => (n && (n.op === 'and' || n.op === 'or') ? n.args.flatMap(flat) : n ? [n] : []);
    expect(flat(where).some(l => l.op === 'notInArray' && l.a === 'id')).toBe(false);
  });
});
