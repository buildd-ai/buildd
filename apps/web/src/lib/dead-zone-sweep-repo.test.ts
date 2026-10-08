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

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';

// ─── DB mocks ─────────────────────────────────────────────────────────────────

const mockWorkersFindMany = mock(() => [] as any[]);
const mockTasksFindMany = mock(() => [] as any[]);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockGithubReposFindFirst = mock(() => null as any);
const mockInsertValues: any[] = [];
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
    insert: () => ({
      values: (vals: any) => {
        mockInsertValues.push(vals);
        return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: 'retry-1' }]) }) };
      },
    }),
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
const mockDispatchConflictRetry = mock(async (_p: any): Promise<any> => ({ dispatched: false }));
mock.module('@/lib/conflict-retry', () => ({
  buildConflictRetryTask: mockBuildConflictRetryTask,
  dispatchConflictRetry: mockDispatchConflictRetry,
  DEFAULT_MAX_CONFLICT_ITERATIONS: 3,
  isAutoResolveMergeConflictsEnabled: () => true,
  releaseSpentConflictRetryKey: async () => null,
}));

// Which authority owns the PR (workflow-state-kernel §14). Null = legacy.
const mockKernelDeliveryForPr = mock(async (_ws: string, _repo: string, _pr: number): Promise<string | null> => null);
mock.module('@/lib/workflow/authority', () => ({ kernelDeliveryForPr: mockKernelDeliveryForPr }));

// The dispatch authority's full surface: mock.module is process-global.
const mockWakeTask = mock(async (_taskId: string, _cause: string, _opts?: unknown) => {});
mock.module('@/lib/dispatch-authority', () => ({
  announceTaskCreated: mock(() => Promise.resolve()),
  wakeTask: mockWakeTask,
  wakeTasks: mock(async () => {}),
  kickDispatch: () => {},
  enqueueTaskDispatch: async () => {},
  drainDispatchOutbox: async () => ({ claimed: 0, delivered: 0, skipped: 0, failed: 0 }),
  deliverTaskDispatch: async () => 'pusher',
  routeForCause: () => ({ event: 'task.created', legacyDefault: true, legacyUnfilteredRunnerPreference: false }),
  webhookWants: () => false,
  primaryCause: (_causes: string[], fallback: string) => fallback,
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
  reseedDispatchTimer: async () => {},
}));

const mockInheritAttemptIdentity = mock((_parentTaskId: string | null | undefined) => Promise.resolve({
  roleSlug: null as string | null, kind: null, complexity: null, missionPhaseIndex: null, missionPhaseLabel: null,
}));
mock.module('@/lib/attempt-identity', () => ({ inheritAttemptIdentity: mockInheritAttemptIdentity }));

// The PR fact funnel (terminal-wins proven on real Postgres in
// tests/db/pr-facts.test.ts); here we only assert the fact handed over.
// Not spread from the real module: drizzle-orm above is a partial surface.
const recordedFacts: Array<{ target: unknown; fact: unknown; opts?: unknown }> = [];
mock.module('@buildd/core/pr-facts', () => ({
  recordPrFact: async (target: unknown, fact: unknown, opts?: unknown) => {
    recordedFacts.push({ target, fact, opts });
    return [{ id: 'w1', taskId: 't1', workspaceId: 'ws1', previousStatus: null }];
  },
  recordPrFactSql: () => null,
  prFactApplies: () => true,
}));

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
    mockInsertValues.length = 0;
    recordedFacts.length = 0;
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
    // A dirty PR is a conflict fact on the fact cache, for this worker.
    expect(recordedFacts).toEqual([{ target: { workerId: 'w1' }, fact: { kind: 'conflict' }, opts: undefined }]);
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

  it('takes the fallback repo from the linked row, not the stale text column', async () => {
    mockWorkersFindMany.mockResolvedValue([deadZoneWorker({ prUrl: COMPARE_URL })]);
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws1',
      repo: 'https://github.com/owner/old-name',
      gitConfig: {},
      githubRepo: { fullName: 'owner/new-name', repoId: 12345, installation: { installationId: 123 } },
    });

    await sweepDeadZonePrs();

    expect(mockGithubApi).toHaveBeenCalledWith(123, '/repos/owner/new-name/pulls/42');
    expect(mockBuildConflictRetryTask).toHaveBeenCalledWith(
      expect.objectContaining({ repoFullName: 'owner/new-name' }),
    );
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

describe('sweepDeadZonePrs retry identity', () => {
  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGithubApi.mockReset();
    mockBuildConflictRetryTask.mockReset();
    mockInheritAttemptIdentity.mockClear();
    mockInsertValues.length = 0;
    mockTasksFindMany.mockResolvedValue([]);
    mockGithubApi.mockResolvedValue(DIRTY_PR);
  });

  it('inherits the parent task\'s roleSlug on the conflict retry it sparks', async () => {
    // role-routing §1 row 8: this insert hand-enumerated its columns and
    // dropped the role that conflict-retry.ts's own insert carries.
    mockWorkersFindMany.mockResolvedValue([deadZoneWorker()]);
    mockWorkspacesFindFirst.mockResolvedValue({
      id: 'ws1', repo: 'owner/repo', gitConfig: {},
      githubRepo: { installation: { installationId: 123 } },
    });
    mockBuildConflictRetryTask.mockReturnValue({
      workspaceId: 'ws1', title: '[builder · after conflict #1] T', description: 'd',
      parentTaskId: 't1', missionId: null, creationSource: 'webhook',
      context: { conflictIteration: 1, maxConflictIterations: 3 },
      conflictRetryPrNumber: 42, conflictRetryHeadSha: 'deadbeef',
    });
    mockInheritAttemptIdentity.mockResolvedValueOnce({
      roleSlug: 'builder', kind: null, complexity: null, missionPhaseIndex: null, missionPhaseLabel: null,
    });

    await sweepDeadZonePrs();

    expect(mockInheritAttemptIdentity).toHaveBeenCalledWith('t1');
    expect(mockInsertValues).toHaveLength(1);
    expect(mockInsertValues[0]).toMatchObject({ roleSlug: 'builder', taskClass: 'attempt', parentTaskId: 't1' });
  });
});

describe('sweepDeadZonePrs PR facts', () => {
  const WORKSPACE = {
    id: 'ws1', repo: 'owner/repo', gitConfig: {},
    githubRepo: { installation: { installationId: 123 } },
  };

  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGithubApi.mockReset();
    mockBuildConflictRetryTask.mockReset();
    mockInsertValues.length = 0;
    recordedFacts.length = 0;
    mockTasksFindMany.mockResolvedValue([]);
    mockWorkersFindMany.mockResolvedValue([deadZoneWorker()]);
    mockWorkspacesFindFirst.mockResolvedValue(WORKSPACE);
  });

  it('records red CI as a ci_failed fact for the head it ran on, never as a conflict', async () => {
    // §18.2: the old write mapped red CI to `conflict`, overloading the status.
    mockGithubApi.mockImplementation((async (_inst: number, path: string) => (
      path.includes('/check-runs')
        ? { check_runs: [{ status: 'completed', conclusion: 'failure' }] }
        : { state: 'open', merged: false, merged_at: null, mergeable_state: 'blocked', head: { sha: 'cafe01' } }
    )) as any);

    await sweepDeadZonePrs();

    expect(recordedFacts).toEqual([{
      target: { workerId: 'w1' },
      fact: { kind: 'ci', status: 'ci_failed', headSha: 'cafe01', currentHeadSha: 'cafe01' },
      opts: undefined,
    }]);
    expect(recordedFacts.some((r) => (r.fact as { kind: string }).kind === 'conflict')).toBe(false);
  });

  it('records a merged PR as a merged fact carrying GitHub\'s merged_at', async () => {
    mockGithubApi.mockResolvedValue({
      state: 'closed', merged: true, merged_at: '2026-01-02T03:04:05Z',
      mergeable_state: null, head: { sha: 'cafe01' },
    });

    const result = await sweepDeadZonePrs();

    expect(recordedFacts).toEqual([{
      target: { workerId: 'w1' },
      fact: { kind: 'merged', mergedAt: '2026-01-02T03:04:05Z' },
      opts: undefined,
    }]);
    expect(result.skipped).toBe(1);
    expect(mockBuildConflictRetryTask).not.toHaveBeenCalled();
  });

  it('records a PR closed without merging as a closed fact', async () => {
    mockGithubApi.mockResolvedValue({
      state: 'closed', merged: false, merged_at: null,
      mergeable_state: null, head: { sha: 'cafe01' },
    });

    await sweepDeadZonePrs();

    expect(recordedFacts).toEqual([{ target: { workerId: 'w1' }, fact: { kind: 'closed' }, opts: undefined }]);
  });

  it('records no fact for a clean open PR', async () => {
    mockGithubApi.mockResolvedValue({
      state: 'open', merged: false, merged_at: null, mergeable_state: 'clean', head: { sha: 'cafe01' },
    });

    await sweepDeadZonePrs();

    expect(recordedFacts).toEqual([]);
  });
});

// Final kernel audit (task b6a62a4e): the sweep inserted a conflict task straight
// into `tasks` for any open PR whose owner task was terminal. A kernel owner task
// is normally `completed` while its delivery is live, so kernel PRs qualified,
// and the task it filed had no delivery, no ledger row and no budget. Spec §14:
// no two authorities. A kernel PR goes through the one conflict door (T12).
describe('sweepDeadZonePrs on a kernel-owned PR', () => {
  const WORKSPACE = {
    id: 'ws1', repo: 'owner/repo', gitConfig: {},
    githubRepo: { installation: { installationId: 123 } },
  };

  beforeEach(() => {
    mockWorkersFindMany.mockReset();
    mockTasksFindMany.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockGithubApi.mockReset();
    mockBuildConflictRetryTask.mockReset();
    mockDispatchConflictRetry.mockReset();
    mockKernelDeliveryForPr.mockReset();
    mockWakeTask.mockClear();
    mockInsertValues.length = 0;
    mockTasksFindMany.mockResolvedValue([]);
    mockWorkersFindMany.mockResolvedValue([deadZoneWorker()]);
    mockWorkspacesFindFirst.mockResolvedValue(WORKSPACE);
    mockKernelDeliveryForPr.mockResolvedValue('delivery-1');
    mockBuildConflictRetryTask.mockReturnValue({
      workspaceId: 'ws1', title: 't', description: 'd', parentTaskId: 't1', missionId: null, creationSource: 'webhook',
      context: { conflictIteration: 1, maxConflictIterations: 3 }, conflictRetryPrNumber: 42, conflictRetryHeadSha: 'deadbeef',
    });
  });

  afterAll(() => {
    mockKernelDeliveryForPr.mockReset();
    mockKernelDeliveryForPr.mockResolvedValue(null);
  });

  it('a dirty kernel PR goes through dispatchConflictRetry, and no task is inserted here', async () => {
    mockGithubApi.mockResolvedValue(DIRTY_PR);
    mockDispatchConflictRetry.mockResolvedValue({ dispatched: true, taskId: 'kernel-fix-1', kernel: { result: 'applied', reason: null, state: 'REPAIRING', attempt: null } });

    const result = await sweepDeadZonePrs();

    expect(mockKernelDeliveryForPr).toHaveBeenCalledWith('ws1', 'owner/repo', 42);
    expect(mockDispatchConflictRetry).toHaveBeenCalledTimes(1);
    expect(mockDispatchConflictRetry.mock.calls[0]![0]).toMatchObject({
      workerId: 'w1', taskId: 't1', prNumber: 42, headSha: 'deadbeef', repoFullName: 'owner/repo', workspaceId: 'ws1',
    });
    expect(mockBuildConflictRetryTask).not.toHaveBeenCalled();
    expect(mockInsertValues).toHaveLength(0);
    expect(mockWakeTask).not.toHaveBeenCalled();
    expect(result.sparked).toBe(1);
  });

  it('counts a spent kernel budget as exhausted, and still inserts nothing', async () => {
    mockGithubApi.mockResolvedValue(DIRTY_PR);
    mockDispatchConflictRetry.mockResolvedValue({ dispatched: false, exhausted: true, kernel: { result: 'applied', reason: null, state: 'ESCALATED', attempt: null } });

    const result = await sweepDeadZonePrs();

    expect(result.exhausted).toBe(1);
    expect(mockInsertValues).toHaveLength(0);
  });

  it('ignores the legacy retry count: the kernel ledger is the budget', async () => {
    mockGithubApi.mockResolvedValue(DIRTY_PR);
    mockTasksFindMany.mockResolvedValue([{ id: 'r1', status: 'completed' }, { id: 'r2', status: 'completed' }, { id: 'r3', status: 'completed' }]);
    mockDispatchConflictRetry.mockResolvedValue({ dispatched: false, inFlightTaskId: 'kernel-fix-1' });

    const result = await sweepDeadZonePrs();

    expect(mockDispatchConflictRetry).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(1);
    expect(mockInsertValues).toHaveLength(0);
  });

  it('a red-CI kernel PR is left to the kernel CI family: no conflict retry of any kind', async () => {
    mockGithubApi.mockImplementation((async (_inst: number, path: string) => (
      path.includes('/check-runs')
        ? { check_runs: [{ status: 'completed', conclusion: 'failure' }] }
        : { state: 'open', merged: false, merged_at: null, mergeable_state: 'blocked', head: { sha: 'cafe01' } }
    )) as any);

    const result = await sweepDeadZonePrs();

    expect(mockDispatchConflictRetry).not.toHaveBeenCalled();
    expect(mockBuildConflictRetryTask).not.toHaveBeenCalled();
    expect(mockInsertValues).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it('an authority read error inserts nothing (fails closed for this PR)', async () => {
    mockGithubApi.mockResolvedValue(DIRTY_PR);
    mockKernelDeliveryForPr.mockRejectedValue(new Error('db down'));

    const result = await sweepDeadZonePrs();

    expect(mockInsertValues).toHaveLength(0);
    expect(mockDispatchConflictRetry).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('a legacy PR (no kernel delivery) keeps today\'s direct retry insert', async () => {
    mockGithubApi.mockResolvedValue(DIRTY_PR);
    mockKernelDeliveryForPr.mockResolvedValue(null);

    const result = await sweepDeadZonePrs();

    expect(mockDispatchConflictRetry).not.toHaveBeenCalled();
    expect(mockInsertValues).toHaveLength(1);
    expect(result.sparked).toBe(1);
  });
});
