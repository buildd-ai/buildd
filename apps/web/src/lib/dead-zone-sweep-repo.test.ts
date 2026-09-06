/**
 * Repo resolution for the dead-zone sweep.
 *
 * Kept in its own file because these cases need `mock.module`, which replaces a
 * module for the whole process and is never undone — dead-zone-sweep.test.ts
 * covers the pure predicates and must stay mock-free.
 *
 * Same defect as both PR reconcile tiers (see pr-reconcile.test.ts for the full
 * account): the sweep built `/repos/${workspaces.repo}/pulls/N`, and that
 * column holds `https://github.com/owner/name` rather than `owner/name`, so
 * every call 404'd. For this sweep the consequence is that no merge conflict on
 * a terminal task was ever detected: no conflict retry was ever sparked, and no
 * BLOCKED card ever appeared from this path.
 *
 * The bad value also flowed onward as `repoFullName` into
 * `buildConflictRetryTask`, i.e. into the instructions handed to an agent.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ─── DB mocks ─────────────────────────────────────────────────────────────────

const mockWorkersFindMany = mock(() => [] as any[]);
const mockTasksFindMany = mock(() => [] as any[]);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockGithubReposFindFirst = mock(() => null as any);
const mockDbUpdate = mock(() => ({
  set: mock(() => ({ where: mock(() => Promise.resolve()) })),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      tasks: { findMany: mockTasksFindMany },
      workspaces: { findFirst: mockWorkspacesFindFirst },
      githubRepos: { findFirst: mockGithubReposFindFirst },
    },
    update: () => mockDbUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => ({ args, op: 'and' }),
  isNull: (a: any) => ({ a, op: 'isNull' }),
  isNotNull: (a: any) => ({ a, op: 'isNotNull' }),
  desc: (a: any) => ({ a, op: 'desc' }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({ op: 'sql', strings: [...strings], values }),
    { raw: (v: string) => ({ op: 'sql.raw', v }) },
  ),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: {
    id: 'id', taskId: 'taskId', workspaceId: 'workspaceId', prUrl: 'prUrl',
    prNumber: 'prNumber', prLifecycleStatus: 'prLifecycleStatus', mergedAt: 'mergedAt',
    branch: 'branch', conflictDetectedAt: 'conflictDetectedAt',
  },
  tasks: { id: 'id', workspaceId: 'workspaceId', status: 'status' },
  workspaces: { id: 'id', repo: 'repo' },
  githubRepos: { id: 'id', fullName: 'fullName' },
}));

const mockGithubApi = mock(() => Promise.resolve({} as any));
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi }));

const mockBuildConflictRetryTask = mock(() => null as any);
mock.module('@/lib/conflict-retry', () => ({
  buildConflictRetryTask: mockBuildConflictRetryTask,
  DEFAULT_MAX_CONFLICT_ITERATIONS: 3,
  isAutoResolveMergeConflictsEnabled: () => true,
}));

mock.module('@/lib/task-dispatch', () => ({ dispatchNewTask: mock(() => Promise.resolve()) }));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { sweepDeadZonePrs } from './dead-zone-sweep';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A worker with an open PR whose originating task is terminal. */
function deadZoneWorker(over: Record<string, unknown> = {}) {
  return {
    id: 'w1',
    taskId: 't1',
    workspaceId: 'ws1',
    prUrl: 'https://github.com/owner/repo/pull/42',
    prNumber: 42,
    prLifecycleStatus: 'pr_open',
    branch: 'feat/x',
    conflictDetectedAt: null,
    task: { id: 't1', title: 'T', description: null, context: null, missionId: null, status: 'completed' },
    ...over,
  };
}

/**
 * A `pull/new/<branch>` compare url — what a worker stores when it prepared a
 * branch but never opened a PR. Carries no PR, so the repo must come from the
 * workspace instead. Deliberately names a different repo than the workspace's,
 * so a test that passes cannot be reading the repo out of this url.
 */
const COMPARE_URL = 'https://github.com/owner/other/pull/new/feat/x';

/** GitHub's answer for a conflicted PR — the case this sweep exists to catch. */
const DIRTY_PR = {
  state: 'open', merged: false, merged_at: null,
  mergeable_state: 'dirty', head: { sha: 'deadbeef' },
};

describe('sweepDeadZonePrs repo resolution', () => {
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGithubReposFindFirst.mockReset();
    mockGithubApi.mockReset();
    mockBuildConflictRetryTask.mockReset();
    mockDbUpdate.mockReturnValue({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) });
    mockTasksFindMany.mockResolvedValue([]);
    mockGithubApi.mockResolvedValue(DIRTY_PR);
  });

  it('builds a slug API path from a URL-shaped workspaces.repo', async () => {
    // The prUrl here is a compare url naming a DIFFERENT repo, so it must be
    // rejected and the workspace's URL-shaped column normalized instead.
    mockWorkersFindMany.mockResolvedValue([deadZoneWorker({ prUrl: COMPARE_URL })]);
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws1',
      repo: 'https://github.com/owner/repo',
      gitConfig: {},
      githubRepo: { installation: { installationId: 123 } },
    });

    await sweepDeadZonePrs();

    expect(mockGithubApi).toHaveBeenCalledWith(123, '/repos/owner/repo/pulls/42');
  });

  it('queries the repo the PR actually lives in, not the workspace repo', async () => {
    mockWorkersFindMany.mockResolvedValue([
      deadZoneWorker({ prUrl: 'https://github.com/owner/sibling-ios/pull/42' }),
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws1',
      repo: 'https://github.com/owner/repo',
      gitConfig: {},
      githubRepo: { installation: { installationId: 123 } },
    });
    mockGithubReposFindFirst.mockResolvedValue({ installation: { installationId: 456 } });

    await sweepDeadZonePrs();

    expect(mockGithubApi).toHaveBeenCalledWith(456, '/repos/owner/sibling-ios/pulls/42');
  });

  it('hands the conflict retry a slug repoFullName, not a url', async () => {
    // This value lands in the instructions given to a resolving agent.
    mockWorkersFindMany.mockResolvedValue([deadZoneWorker({ prUrl: COMPARE_URL })]);
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws1',
      repo: 'https://github.com/owner/repo',
      gitConfig: {},
      githubRepo: { installation: { installationId: 123 } },
    });

    await sweepDeadZonePrs();

    expect(mockBuildConflictRetryTask).toHaveBeenCalledWith(
      expect.objectContaining({ repoFullName: 'owner/repo' }),
    );
  });

  it('sweeps a worker whose workspace has no repo, using its prUrl', async () => {
    mockWorkersFindMany.mockResolvedValue([
      deadZoneWorker({ workspaceId: 'ws-coord', prUrl: 'https://github.com/owner/repo/pull/42' }),
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-coord', repo: null, gitConfig: {}, githubInstallation: null,
    });
    mockGithubReposFindFirst.mockResolvedValue({ installation: { installationId: 789 } });

    await sweepDeadZonePrs();

    expect(mockGithubApi).toHaveBeenCalledWith(789, '/repos/owner/repo/pulls/42');
  });

  it('skips, without a GitHub call, when no repo resolves from either source', async () => {
    mockWorkersFindMany.mockResolvedValue([
      deadZoneWorker({ workspaceId: 'ws-coord', prUrl: COMPARE_URL }),
    ]);
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws-coord', repo: null, gitConfig: {}, githubInstallation: null,
    });

    const result = await sweepDeadZonePrs();

    expect(mockGithubApi).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });
});
