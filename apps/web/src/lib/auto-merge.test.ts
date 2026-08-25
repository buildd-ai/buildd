import { beforeEach, describe, expect, it, mock } from 'bun:test';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockNotify = mock(() => {});
mock.module('@/lib/pushover', () => ({
  notify: mockNotify,
}));

const mockGithubApi = mock(() => Promise.resolve({ check_runs: [] }) as Promise<unknown>);
mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
  mergePullRequest: mock(() => Promise.resolve()),
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

import { evaluateAutoMergeSafety, escalateConflictExhaustion, escalateReviewerExhaustion } from './auto-merge';
import type { MergePolicy } from '@buildd/shared';

// ── evaluateAutoMergeSafety ───────────────────────────────────────────────────

const params = [1, 'buildd-ai/buildd', 42, 'head-sha'] as const;
const autoThresholdPolicy: MergePolicy = { tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } };

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
