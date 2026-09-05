import { beforeEach, describe, expect, it, mock } from 'bun:test';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockNotify = mock(() => {});
mock.module('@/lib/pushover', () => ({
  notify: mockNotify,
}));

const mockGithubApi = mock(() => Promise.resolve({ check_runs: [] }) as Promise<unknown>);
const mockMergePullRequest = mock(() => Promise.resolve({ merged: true, message: 'merged' }) as Promise<any>);
mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
  mergePullRequest: mockMergePullRequest,
}));

let mockFindFirst = mock(() => null as any);
let mockUpdateReturns: any[] = [];
let capturedInsertValues: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: (...args: any[]) => mockFindFirst(...args) },
    },
    update: (_table: any) => ({
      set: (_vals: any) => ({
        where: (_cond: any) => ({
          returning: (_cols: any) => mockUpdateReturns.shift() ?? [],
        }),
      }),
    }),
    insert: (table: any) => ({
      values: (vals: any) => {
        if (table === 'missionNotes') capturedInsertValues.push(vals);
        return Promise.resolve();
      },
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  or: (...args: any[]) => ({ type: 'or', args }),
  sql: (strings: any, ...values: any[]) => ({ type: 'sql', strings, values }),
  isNull: (a: any) => ({ type: 'isNull', a }),
  ne: (a: any, b: any) => ({ type: 'ne', a, b }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: 'tasks',
  missionNotes: 'missionNotes',
  missions: 'missions',
}));

mock.module('@/lib/mission-notifications', () => ({
  notifyMissionPrReady: mock(() => Promise.resolve({ notified: false })),
}));

const mockInspectPullRequestMigrations = mock(() => Promise.resolve({ safe: true as const }));
mock.module('@/lib/migration-inspector', () => ({
  inspectPullRequestMigrations: mockInspectPullRequestMigrations,
}));

mock.module('@/lib/conflict-retry', () => ({
  classifyMergeFailure: mock(() => 'retryable'),
  dispatchConflictRetry: mock(() => Promise.resolve({ dispatched: false })),
  DEFAULT_MAX_CONFLICT_ITERATIONS: 3,
}));

import { evaluateAutoMergeSafety, tryAutoMergeWorkerPr, escalateConflictExhaustion, escalateReviewerExhaustion } from './auto-merge';
import type { MergePolicy } from '@buildd/shared';

// ── evaluateAutoMergeSafety ───────────────────────────────────────────────────

const params = [1, 'buildd-ai/buildd', 42, 'head-sha'] as const;
const autoThresholdPolicy: MergePolicy = { tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } };

describe('evaluateAutoMergeSafety CI verification', () => {
  beforeEach(() => {
    mockGithubApi.mockReset();
    mockInspectPullRequestMigrations.mockReset();
    mockInspectPullRequestMigrations.mockResolvedValue({ safe: true });
  });

  it('refuses the merge when the check-runs lookup fails', async () => {
    // Fail closed: this read is the only proof CI is green, so an API blip must
    // not become a merge with no CI verification.
    mockGithubApi.mockRejectedValueOnce(new Error('GitHub API error: 502 Bad Gateway'));

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('could not verify CI status'),
    });
  });

  it('does not reach the diff-size or mergeable_state reads after a failed lookup', async () => {
    mockGithubApi.mockRejectedValueOnce(new Error('GitHub API error: 502 Bad Gateway'));

    await evaluateAutoMergeSafety(...params, autoThresholdPolicy);

    expect(mockGithubApi).toHaveBeenCalledTimes(1);
  });

  it('refuses while a check run is still queued or in progress', async () => {
    mockGithubApi.mockResolvedValueOnce({
      check_runs: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'integration', status: 'queued', conclusion: null },
      ],
    });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('integration'),
    });
  });
});

describe('evaluateAutoMergeSafety mergeable_state check', () => {
  beforeEach(() => {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })           // check-runs
      .mockResolvedValueOnce([])                            // files
      .mockResolvedValueOnce({ mergeable_state: 'dirty' }); // PR state
    mockInspectPullRequestMigrations.mockReset();
    mockInspectPullRequestMigrations.mockResolvedValue({ safe: true });
  });

  it('returns ok:false when mergeable_state is dirty', async () => {
    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('dirty'),
    });
  });

  it('returns ok:false when mergeable_state is blocked', async () => {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ mergeable_state: 'blocked' });
    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('blocked'),
    });
  });

  it('passes when mergeable_state is clean', async () => {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ mergeable_state: 'clean' });
    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy),
    ).resolves.toEqual({ ok: true });
  });

  it('passes when mergeable_state is unknown (soft retry — do not block permanently)', async () => {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ mergeable_state: 'unknown' });
    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy),
    ).resolves.toEqual({ ok: true });
  });
});

describe('evaluateAutoMergeSafety migration operation-class gate (unconditional)', () => {
  // Migration inspection runs regardless of denyPaths / escalateToPaths config.
  // drizzle/ removed from escalateToPaths does NOT weaken the gate.

  it('EXPAND migration passes without drizzle/ in denyPaths', async () => {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([
        { filename: 'packages/core/db/schema.ts', additions: 2, deletions: 0 },
        { filename: 'packages/core/drizzle/0094_safe.sql', additions: 1, deletions: 0 },
      ])
      .mockResolvedValueOnce({ mergeable_state: 'clean' });
    mockInspectPullRequestMigrations.mockReset();
    mockInspectPullRequestMigrations.mockResolvedValue({ safe: true, operationClass: 'EXPAND' });

    const policy: MergePolicy = {
      tier: 'auto-threshold',
      threshold: { denyPaths: [] },
    };
    await expect(
      evaluateAutoMergeSafety(...params, policy),
    ).resolves.toEqual({ ok: true });
    expect(mockInspectPullRequestMigrations).toHaveBeenCalledTimes(1);
  });

  it('CONTRACT migration blocks even without drizzle/ in denyPaths (AC-6)', async () => {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([
        { filename: 'packages/core/drizzle/0095_drop.sql', additions: 1, deletions: 0 },
      ]);
    mockInspectPullRequestMigrations.mockReset();
    mockInspectPullRequestMigrations.mockResolvedValue({
      safe: false,
      operationClass: 'CONTRACT',
      reason: 'drops column missions.legacy_mode',
    });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy),
    ).resolves.toEqual({
      ok: false,
      reason: 'drops column missions.legacy_mode',
    });
    expect(mockInspectPullRequestMigrations).toHaveBeenCalledTimes(1);
  });

  it('returns the specific destructive migration reason', async () => {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([
        { filename: 'packages/core/db/schema.ts', additions: 2, deletions: 0 },
        { filename: 'packages/core/drizzle/0094_safe.sql', additions: 1, deletions: 0 },
      ]);
    mockInspectPullRequestMigrations.mockReset();
    mockInspectPullRequestMigrations.mockResolvedValue({
      safe: false,
      operationClass: 'CONTRACT',
      reason: 'drops column missions.legacy_mode',
    });
    const policy: MergePolicy = {
      tier: 'auto-threshold',
      threshold: { denyPaths: [] },
    };
    await expect(
      evaluateAutoMergeSafety(...params, policy),
    ).resolves.toEqual({
      ok: false,
      reason: 'drops column missions.legacy_mode',
    });
  });

  it('does not call inspector for a PR with no migration files or schema.ts', async () => {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([
        { filename: 'apps/web/src/app/page.tsx', additions: 5, deletions: 2 },
      ])
      .mockResolvedValueOnce({ mergeable_state: 'clean' });
    mockInspectPullRequestMigrations.mockReset();

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy),
    ).resolves.toEqual({ ok: true });
    expect(mockInspectPullRequestMigrations).not.toHaveBeenCalled();
  });

  it('does not narrow an ordinary deny path', async () => {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([
        { filename: '.github/workflows/build.yml', additions: 2, deletions: 0 },
      ]);
    mockInspectPullRequestMigrations.mockReset();
    const policy: MergePolicy = {
      tier: 'auto-threshold',
      threshold: { denyPaths: ['.github/workflows/'] },
    };
    await expect(
      evaluateAutoMergeSafety(...params, policy),
    ).resolves.toEqual({
      ok: false,
      reason: 'touches protected path (.github/workflows/build.yml)',
    });
    expect(mockInspectPullRequestMigrations).not.toHaveBeenCalled();
  });
});

describe('evaluateAutoMergeSafety tier 2 escalateToPaths', () => {
  it('blocks on escalateToPaths for agent-review tier', async () => {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([
        { filename: '.github/workflows/build.yml', additions: 1, deletions: 0 },
      ])
      .mockResolvedValueOnce({ mergeable_state: 'clean' });
    const policy: MergePolicy = {
      tier: 'agent-review',
      agentReview: { reviewerRole: 'reviewer', escalateToPaths: ['.github/workflows/'] },
    };
    await expect(
      evaluateAutoMergeSafety(...params, policy),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('.github/workflows/build.yml'),
    });
  });

  it('passes for agent-review when no escalateToPaths hit', async () => {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([
        { filename: 'apps/web/src/app/page.tsx', additions: 5, deletions: 2 },
      ])
      .mockResolvedValueOnce({ mergeable_state: 'clean' });
    const policy: MergePolicy = {
      tier: 'agent-review',
      agentReview: { reviewerRole: 'reviewer', escalateToPaths: ['.github/workflows/'] },
    };
    await expect(
      evaluateAutoMergeSafety(...params, policy),
    ).resolves.toEqual({ ok: true });
  });
});

describe('evaluateAutoMergeSafety generated-path exclusion', () => {
  const POLICY: MergePolicy = {
    tier: 'auto-threshold',
    threshold: { maxLines: 800, denyPaths: [] },
  };

  it('drizzle meta snapshot lines are excluded from the line count', async () => {
    // Source change: 100 lines. Snapshot: 9,413 lines. Total would be 9,513 — over cap.
    // After exclusion: 100 lines — under cap → should pass.
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([
        { filename: 'apps/web/src/lib/feature.ts', additions: 100, deletions: 0 },
        { filename: 'packages/core/drizzle/meta/0001_snapshot.json', additions: 9413, deletions: 0 },
        { filename: 'packages/core/drizzle/meta/_journal.json', additions: 4, deletions: 2 },
      ])
      .mockResolvedValueOnce({ mergeable_state: 'clean' });
    mockInspectPullRequestMigrations.mockReset();
    mockInspectPullRequestMigrations.mockResolvedValue({ safe: true });

    await expect(
      evaluateAutoMergeSafety(...params, POLICY),
    ).resolves.toEqual({ ok: true });
  });

  it('still blocks when non-generated lines alone exceed the cap', async () => {
    // Source change: 900 lines (over the 800 cap) + snapshot.
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([
        { filename: 'apps/web/src/lib/feature.ts', additions: 900, deletions: 0 },
        { filename: 'packages/core/drizzle/meta/0001_snapshot.json', additions: 9413, deletions: 0 },
      ])
      .mockResolvedValueOnce({ mergeable_state: 'clean' });
    mockInspectPullRequestMigrations.mockReset();
    mockInspectPullRequestMigrations.mockResolvedValue({ safe: true });

    await expect(
      evaluateAutoMergeSafety(...params, POLICY),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('900'),
    });
  });

  it('CONTRACT migration in a drizzle file still escalates — generated-path line exclusion does NOT weaken the operation-class gate', async () => {
    // Regression: line-count exclusion of generated paths must never bypass the
    // migration operation-class inspector. A CONTRACT migration always blocks.
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([
        { filename: 'packages/core/drizzle/0001_drop_column.sql', additions: 10, deletions: 0 },
      ])
      .mockResolvedValueOnce({ mergeable_state: 'clean' });
    mockInspectPullRequestMigrations.mockReset();
    mockInspectPullRequestMigrations.mockResolvedValue({
      safe: false,
      operationClass: 'CONTRACT',
      reason: 'drops column foo',
    });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('drops column foo'),
    });
  });
});

// ── escalateConflictExhaustion ────────────────────────────────────────────────

describe('escalateConflictExhaustion', () => {
  const TASK_ID = 'task-abc-123';
  const REPO = 'acme/my-app';
  const PR_NUMBER = 42;
  const HEAD_SHA = 'deadbeef1234567890abcdef';

  const baseTask = {
    id: TASK_ID,
    missionId: null as string | null,
    title: 'feat: add dark mode',
    context: { conflictIteration: 3, maxConflictIterations: 3 },
  };

  beforeEach(() => {
    mockNotify.mockReset();
    capturedInsertValues = [];
    mockUpdateReturns = [];
    mockFindFirst = mock(() => baseTask);
  });

  it('returns early without firing Pushover when task is not found', async () => {
    mockFindFirst = mock(() => null);
    await escalateConflictExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('fires Pushover on first call when CAS succeeds', async () => {
    mockUpdateReturns = [[{ id: TASK_ID }]]; // CAS claims the slot
    await escalateConflictExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const call = mockNotify.mock.calls[0][0] as any;
    expect(call.app).toBe('tasks');
    expect(call.priority).toBe(0);
    expect(call.title).toContain(`PR #${PR_NUMBER}`);
    expect(call.message).toContain('feat: add dark mode');
  });

  it('does NOT fire Pushover when CAS returns empty (already escalated for this headSha)', async () => {
    mockUpdateReturns = [[]]; // CAS fails — already done
    await escalateConflictExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('is idempotent: exactly one Pushover across three concurrent exhaustion observations', async () => {
    mockUpdateReturns = [[{ id: TASK_ID }], [], []];
    await Promise.all([
      escalateConflictExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA),
      escalateConflictExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA),
      escalateConflictExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA),
    ]);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('fires Pushover but inserts NO note when task has no missionId', async () => {
    mockUpdateReturns = [[{ id: TASK_ID }]];
    await escalateConflictExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA);
    expect(capturedInsertValues).toHaveLength(0);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('inserts a reviewer_escalated note AND fires Pushover when task has a missionId', async () => {
    mockFindFirst = mock(() => ({ ...baseTask, missionId: 'mission-xyz' }));
    mockUpdateReturns = [[{ id: TASK_ID }]];
    await escalateConflictExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA);
    expect(capturedInsertValues).toHaveLength(1);
    expect(capturedInsertValues[0].type).toBe('reviewer_escalated');
    expect(capturedInsertValues[0].missionId).toBe('mission-xyz');
    expect(capturedInsertValues[0].taskId).toBe(TASK_ID);
    expect(capturedInsertValues[0].status).toBe('open');
    expect(capturedInsertValues[0].title).toContain(`PR #${PR_NUMBER}`);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('includes iteration count from task context in the Pushover message', async () => {
    mockUpdateReturns = [[{ id: TASK_ID }]];
    await escalateConflictExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA);
    const msg = (mockNotify.mock.calls[0][0] as any).message as string;
    expect(msg).toContain('3');
  });

  it('Pushover URL points to the buildd task page', async () => {
    mockUpdateReturns = [[{ id: TASK_ID }]];
    await escalateConflictExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA);
    const url = (mockNotify.mock.calls[0][0] as any).url as string;
    expect(url).toContain(`/app/tasks/${TASK_ID}`);
  });
});

// ── escalateReviewerExhaustion ────────────────────────────────────────────────

describe('escalateReviewerExhaustion', () => {
  const TASK_ID = 'task-rev-456';
  const REPO = 'acme/my-app';
  const PR_NUMBER = 99;
  const HEAD_SHA = 'cafe1234567890abcdef';
  const MAX_ITERATIONS = 3;

  const baseTask = {
    id: TASK_ID,
    missionId: null as string | null,
    title: 'feat: add search',
    context: {},
  };

  beforeEach(() => {
    mockNotify.mockReset();
    capturedInsertValues = [];
    mockUpdateReturns = [];
    mockFindFirst = mock(() => baseTask);
  });

  it('returns early without firing Pushover when task is not found', async () => {
    mockFindFirst = mock(() => null);
    await escalateReviewerExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA, MAX_ITERATIONS, null);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('fires Pushover on first call when CAS succeeds', async () => {
    mockUpdateReturns = [[{ id: TASK_ID }]];
    await escalateReviewerExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA, MAX_ITERATIONS, 'Fix the handler');
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const call = mockNotify.mock.calls[0][0] as any;
    expect(call.app).toBe('tasks');
    expect(call.priority).toBe(0);
    expect(call.title).toContain(`PR #${PR_NUMBER}`);
    expect(call.message).toContain('feat: add search');
  });

  it('does NOT fire Pushover when CAS returns empty (already escalated for this headSha)', async () => {
    mockUpdateReturns = [[]];
    await escalateReviewerExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA, MAX_ITERATIONS, null);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('is idempotent: exactly one Pushover across three concurrent exhaustion observations', async () => {
    mockUpdateReturns = [[{ id: TASK_ID }], [], []];
    await Promise.all([
      escalateReviewerExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA, MAX_ITERATIONS, null),
      escalateReviewerExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA, MAX_ITERATIONS, null),
      escalateReviewerExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA, MAX_ITERATIONS, null),
    ]);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('inserts a reviewer_escalated note when task has a missionId', async () => {
    mockFindFirst = mock(() => ({ ...baseTask, missionId: 'mission-xyz' }));
    mockUpdateReturns = [[{ id: TASK_ID }]];
    await escalateReviewerExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA, MAX_ITERATIONS, 'Missing mock');
    expect(capturedInsertValues).toHaveLength(1);
    expect(capturedInsertValues[0].type).toBe('reviewer_escalated');
    expect(capturedInsertValues[0].missionId).toBe('mission-xyz');
    expect(capturedInsertValues[0].taskId).toBe(TASK_ID);
    expect(capturedInsertValues[0].status).toBe('open');
    expect(capturedInsertValues[0].title).toContain(`PR #${PR_NUMBER}`);
    expect(capturedInsertValues[0].body).toContain('Missing mock');
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('fires Pushover but inserts NO note when task has no missionId', async () => {
    mockUpdateReturns = [[{ id: TASK_ID }]];
    await escalateReviewerExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA, MAX_ITERATIONS, null);
    expect(capturedInsertValues).toHaveLength(0);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('Pushover URL points to the buildd task page', async () => {
    mockUpdateReturns = [[{ id: TASK_ID }]];
    await escalateReviewerExhaustion(TASK_ID, REPO, PR_NUMBER, HEAD_SHA, MAX_ITERATIONS, null);
    const url = (mockNotify.mock.calls[0][0] as any).url as string;
    expect(url).toContain(`/app/tasks/${TASK_ID}`);
  });
});

// ── Option A': the mission integration PR and the aggregate size gate ────────
//
// The mission PR is the union of every task diff in the mission, and each of
// those diffs was already size-gated when it merged into the integration
// branch. Re-applying an aggregate size gate at the mission PR double-counts a
// check that already passed at the right granularity — and with the DEFAULT
// policy (auto-threshold / 800 lines) it makes every mission PR structurally
// unmergeable by the platform, so "the tier applies at the mission PR" would be
// true only for an operator who explicitly configured a tier.
//
// Exactly ONE gate is exempt. CI-green, denyPaths / escalateToPaths, the
// migration operation-class inspector and the conflict / branch-protection
// checks all still run for a mission PR, and each has a test below.

const MISSION_BRANCH = 'mission/example-slug-0a1b2c3d';
const optedInMission = { workingBranch: MISSION_BRANCH, integrationBranchEnabled: true };
/** 2,500 source lines — three times the default 800-line cap. */
const OVERSIZED_FILES = [{ filename: 'apps/web/src/lib/feature.ts', additions: 2500, deletions: 0 }];

describe("evaluateAutoMergeSafety — Option A' mission integration PR", () => {
  beforeEach(() => {
    mockGithubApi.mockReset();
    mockInspectPullRequestMigrations.mockReset();
    mockInspectPullRequestMigrations.mockResolvedValue({ safe: true });
  });

  it('does not apply the aggregate line threshold to the mission integration PR', async () => {
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce(OVERSIZED_FILES)
      .mockResolvedValueOnce({ mergeable_state: 'clean', head: { ref: MISSION_BRANCH } });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, { mission: optedInMission }),
    ).resolves.toEqual({ ok: true });
  });

  it('still applies it when the mission has not opted in — a branch that merely LOOKS like one is not exempt', async () => {
    // Authoritative predicate, not the `mission/` shape heuristic: a workspace is
    // free to carry a mission/… branch that no mission owns, and a false positive
    // here silently drops the size gate for it.
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce(OVERSIZED_FILES)
      .mockResolvedValueOnce({ mergeable_state: 'clean', head: { ref: MISSION_BRANCH } });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, {
        mission: { workingBranch: MISSION_BRANCH, integrationBranchEnabled: false },
      }),
    ).resolves.toEqual({ ok: false, reason: expect.stringContaining('2500') });
  });

  it('still applies it when the head ref is not the mission integration branch', async () => {
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce(OVERSIZED_FILES)
      .mockResolvedValueOnce({ mergeable_state: 'clean', head: { ref: 'feature/some-task' } });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, { mission: optedInMission }),
    ).resolves.toEqual({ ok: false, reason: expect.stringContaining('2500') });
  });

  it('still applies it when the PR read fails, so an unknown head ref never grants the exemption', async () => {
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce(OVERSIZED_FILES)
      .mockRejectedValueOnce(new Error('GitHub API error: 502 Bad Gateway'));

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, { mission: optedInMission }),
    ).resolves.toEqual({ ok: false, reason: expect.stringContaining('2500') });
  });

  it('still applies it with no opts at all — the exemption is opt-in per call', async () => {
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce(OVERSIZED_FILES)
      .mockResolvedValueOnce({ mergeable_state: 'clean', head: { ref: MISSION_BRANCH } });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy),
    ).resolves.toEqual({ ok: false, reason: expect.stringContaining('2500') });
  });

  // ── What is NOT exempt ─────────────────────────────────────────────────────

  it('CI must still be green for the mission integration PR', async () => {
    mockGithubApi.mockResolvedValueOnce({
      check_runs: [{ name: 'build', status: 'completed', conclusion: 'failure' }],
    });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, { mission: optedInMission }),
    ).resolves.toEqual({ ok: false, reason: expect.stringContaining('build') });
  });

  it('an unverifiable CI status still fails closed for the mission integration PR', async () => {
    mockGithubApi.mockRejectedValueOnce(new Error('GitHub API error: 502 Bad Gateway'));

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, { mission: optedInMission }),
    ).resolves.toEqual({ ok: false, reason: expect.stringContaining('could not verify CI status') });
  });

  it('denyPaths still block the mission integration PR', async () => {
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([{ filename: '.github/workflows/build.yml', additions: 1, deletions: 0 }]);

    await expect(
      evaluateAutoMergeSafety(
        ...params,
        { tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: ['.github/workflows/'] } },
        { mission: optedInMission },
      ),
    ).resolves.toEqual({
      ok: false,
      reason: 'touches protected path (.github/workflows/build.yml)',
    });
  });

  it('escalateToPaths still block the mission integration PR under agent-review', async () => {
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([{ filename: '.github/workflows/build.yml', additions: 1, deletions: 0 }]);

    await expect(
      evaluateAutoMergeSafety(
        ...params,
        { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer', escalateToPaths: ['.github/workflows/'] } },
        { mission: optedInMission },
      ),
    ).resolves.toEqual({ ok: false, reason: expect.stringContaining('.github/workflows/build.yml') });
  });

  it('a CONTRACT migration still blocks the mission integration PR', async () => {
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([{ filename: 'packages/core/drizzle/0001_drop_column.sql', additions: 2, deletions: 0 }]);
    mockInspectPullRequestMigrations.mockResolvedValue({
      safe: false,
      operationClass: 'CONTRACT',
      reason: 'drops a column',
    });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, { mission: optedInMission }),
    ).resolves.toEqual({ ok: false, reason: 'drops a column' });
  });

  it('conflicts still block the mission integration PR', async () => {
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce(OVERSIZED_FILES)
      .mockResolvedValueOnce({ mergeable_state: 'dirty', head: { ref: MISSION_BRANCH } });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, { mission: optedInMission }),
    ).resolves.toEqual({ ok: false, reason: expect.stringContaining('dirty') });
  });

  it('branch protection still blocks the mission integration PR', async () => {
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce(OVERSIZED_FILES)
      .mockResolvedValueOnce({ mergeable_state: 'blocked', head: { ref: MISSION_BRANCH } });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, { mission: optedInMission }),
    ).resolves.toEqual({ ok: false, reason: expect.stringContaining('blocked') });
  });
});

describe("tryAutoMergeWorkerPr — Option A' mission integration PR", () => {
  beforeEach(() => {
    mockGithubApi.mockReset();
    mockMergePullRequest.mockClear();
    mockInspectPullRequestMigrations.mockReset();
    mockInspectPullRequestMigrations.mockResolvedValue({ safe: true });
  });

  it('resolves the mission from the worker task and merges an oversized mission PR', async () => {
    // The wiring test: the exemption is only reachable if the merge path actually
    // looks the mission up, which is also what makes the predicate authoritative.
    mockFindFirst = mock(() => ({
      id: 'task-owner',
      mission: optedInMission,
    })) as any;
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce(OVERSIZED_FILES)
      .mockResolvedValueOnce({ mergeable_state: 'clean', head: { ref: MISSION_BRANCH } });

    await tryAutoMergeWorkerPr({
      installationId: 1,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 42,
      headSha: 'head-sha',
      worker: { id: 'worker-1', taskId: 'task-owner', workspaceId: 'ws-1' },
      policy: { tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } },
    });

    expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
  });

  it('does not merge an oversized ordinary task PR (the gate is still there)', async () => {
    mockFindFirst = mock(() => ({ id: 'task-1', mission: null })) as any;
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce(OVERSIZED_FILES)
      .mockResolvedValueOnce({ mergeable_state: 'clean', head: { ref: 'feature/task-1' } });

    await tryAutoMergeWorkerPr({
      installationId: 1,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 43,
      headSha: 'head-sha',
      worker: { id: 'worker-2', taskId: 'task-1', workspaceId: 'ws-1' },
      policy: { tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } },
    });

    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });
});

// ── Option A': the bound on a merge driven by a MODEL approve verdict ────────
//
// A reviewer agent's `approve` may merge unattended only into the mission's own
// integration branch, and only with positive proof that build/test ran green on
// the head SHA. Both halves matter and each refusal below asserts WHICH gate
// fired: several of them refuse a `dev` base, so a test that only checked "dev
// is refused" would pass under any one of them.

describe('evaluateAutoMergeSafety model-approve bound', () => {
  const bound = { protectedBranches: ['main', 'dev', 'production'] };
  const GREEN = [{ name: 'build', status: 'completed', conclusion: 'success' }];
  const ORDINARY_FILES = [{ filename: 'apps/web/src/lib/foo.ts', additions: 4, deletions: 1 }];

  /** Stubs the three GitHub reads in order: check-runs, files, the PR itself. */
  function stubPr(
    pr: { base?: string; head?: string },
    opts: { checkRuns?: unknown[]; files?: unknown[] } = {},
  ) {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: opts.checkRuns ?? GREEN })
      .mockResolvedValueOnce(opts.files ?? ORDINARY_FILES)
      .mockResolvedValueOnce({
        mergeable_state: 'clean',
        base: { ref: pr.base },
        head: { ref: pr.head ?? 'task/some-work' },
      });
    mockInspectPullRequestMigrations.mockReset();
    mockInspectPullRequestMigrations.mockResolvedValue({ safe: true });
  }

  it("merges an approved task PR based on the mission's integration branch", async () => {
    stubPr({ base: MISSION_BRANCH });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, { mission: optedInMission, bound }),
    ).resolves.toEqual({ ok: true });
  });

  // ── the base must be the mission's OWN integration branch ─────────────────

  it('refuses a base that merely LOOKS like a mission branch when the mission has not opted in', async () => {
    // The authoritative predicate, not the `mission/` name shape: a workspace is
    // free to carry a mission/… branch that no mission owns, and treating one as
    // quarantined is what silently removes the human gate.
    stubPr({ base: MISSION_BRANCH });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, {
        mission: { workingBranch: MISSION_BRANCH, integrationBranchEnabled: false },
        bound,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining("is not this mission's integration branch"),
    });
  });

  it("refuses a mission/-shaped base that is not THIS mission's working branch", async () => {
    stubPr({ base: 'mission/someone-elses-slug-9f8e7d6c' });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, { mission: optedInMission, bound }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining("is not this mission's integration branch"),
    });
  });

  it('refuses when no mission row was resolved at all', async () => {
    stubPr({ base: MISSION_BRANCH });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, { mission: null, bound }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining("is not this mission's integration branch"),
    });
  });

  it('keys off the BASE ref, not the head ref', async () => {
    // A PR whose HEAD is the integration branch is the mission PR merging into
    // trunk — the one PR in the topology that must stay a human gate. Reading
    // the wrong ref would hand exactly that PR to a model verdict.
    stubPr({ base: 'dev', head: MISSION_BRANCH });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, { mission: optedInMission, bound }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('protected trunk branch'),
    });
  });

  // ── the trunk deny list, which the mission row cannot talk its way past ───

  it("refuses a trunk base even when the mission's working branch IS that trunk", async () => {
    // The deny list is not redundant with the positive test: `missions.workingBranch`
    // is data an agent can write, so a mission pointed at trunk would otherwise
    // satisfy `isMissionIntegrationBase` for a PR based on trunk. Only the deny
    // list can refuse this one — the positive test would permit it.
    stubPr({ base: 'dev' });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, {
        mission: { workingBranch: 'dev', integrationBranchEnabled: true },
        bound,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining("base 'dev' is a protected trunk branch"),
    });
  });

  it('refuses when the base is main', async () => {
    stubPr({ base: 'main' });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, {
        mission: { workingBranch: 'main', integrationBranchEnabled: true },
        bound,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining("base 'main' is a protected trunk branch"),
    });
  });

  it("refuses when the base is the workspace's prodBranch", async () => {
    stubPr({ base: 'production' });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, {
        mission: { workingBranch: 'production', integrationBranchEnabled: true },
        bound,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining("base 'production' is a protected trunk branch"),
    });
  });

  // ── positive build proof, which is the gap the shared gate only warns about ─

  it('refuses when the build workflow never ran for the head SHA', async () => {
    // `evaluateAutoMergeSafety` alone only console.warns about absent checks, so
    // this zero-run PR is "not failing" to every other gate in the function.
    stubPr({ base: MISSION_BRANCH }, { checkRuns: [] });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, { mission: optedInMission, bound }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('no build/test check reported'),
    });
  });

  it('refuses when a check ran but under an unrelated name', async () => {
    stubPr({ base: MISSION_BRANCH }, {
      checkRuns: [{ name: 'lint', status: 'completed', conclusion: 'success' }],
    });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, { mission: optedInMission, bound }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('no build/test check reported'),
    });
  });

  it('refuses when every build check was skipped', async () => {
    stubPr({ base: MISSION_BRANCH }, {
      checkRuns: [{ name: 'build', status: 'completed', conclusion: 'skipped' }],
    });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, { mission: optedInMission, bound }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('successful conclusion'),
    });
  });

  // ── fail closed, and only under the bound ─────────────────────────────────

  it('refuses when the PR read that carries the base ref fails — fail closed', async () => {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: GREEN })
      .mockResolvedValueOnce(ORDINARY_FILES)
      .mockRejectedValueOnce(new Error('GitHub API error: 502 Bad Gateway'));
    mockInspectPullRequestMigrations.mockReset();
    mockInspectPullRequestMigrations.mockResolvedValue({ safe: true });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, { mission: optedInMission, bound }),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('could not verify the PR base ref'),
    });
  });

  it('leaves the unbounded (CI-green, human-configured policy) path alone', async () => {
    // The same dev-based, zero-check-run PR that the bound refuses passes with no
    // bound — proving each refusal above comes from the bound, not from a new
    // restriction on every auto-merge.
    stubPr({ base: 'dev' }, { checkRuns: [] });

    await expect(
      evaluateAutoMergeSafety(...params, autoThresholdPolicy, { mission: optedInMission }),
    ).resolves.toEqual({ ok: true });
  });
});

describe('tryAutoMergeWorkerPr passes the bound through to the safety rails', () => {
  // Without this, a mutation that drops `bound` on the way to
  // evaluateAutoMergeSafety silently disables the entire base-ref rail while
  // every bound unit test above stays green.
  const bound = { protectedBranches: ['main', 'dev'] };
  const policy: MergePolicy = { tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } };

  function stubPr(baseRef: string) {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] })
      .mockResolvedValueOnce([{ filename: 'apps/web/src/lib/foo.ts', additions: 3, deletions: 1 }])
      .mockResolvedValueOnce({
        mergeable_state: 'clean',
        base: { ref: baseRef },
        head: { ref: 'task/some-work' },
      });
    mockInspectPullRequestMigrations.mockReset();
    mockInspectPullRequestMigrations.mockResolvedValue({ safe: true });
    mockMergePullRequest.mockClear();
    // The same mission read the size-gate exemption uses — the bound needs the
    // row too, which is why they share one `opts`.
    mockFindFirst = mock(() => ({ id: 'task-owner', mission: optedInMission })) as any;
  }

  it("merges when the base is the mission's integration branch", async () => {
    stubPr(MISSION_BRANCH);

    await tryAutoMergeWorkerPr({
      installationId: 1,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 42,
      headSha: 'head-sha',
      worker: { id: 'worker-1', taskId: 'task-owner', workspaceId: 'ws-1' },
      policy,
      bound,
    });

    expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
  });

  it('does not merge the identical PR when the base is dev', async () => {
    stubPr('dev');

    await tryAutoMergeWorkerPr({
      installationId: 1,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 42,
      headSha: 'head-sha',
      worker: { id: 'worker-1', taskId: 'task-owner', workspaceId: 'ws-1' },
      policy,
      bound,
    });

    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });
});
