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

import { evaluateAutoMergeSafety, escalateConflictExhaustion } from './auto-merge';

// ── evaluateAutoMergeSafety ───────────────────────────────────────────────────

const mergeParams = [1, 'buildd-ai/buildd', 42, 'head-sha'] as const;

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
      evaluateAutoMergeSafety(...mergeParams, undefined),
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
      evaluateAutoMergeSafety(...mergeParams, undefined),
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
      evaluateAutoMergeSafety(...mergeParams, undefined),
    ).resolves.toEqual({ ok: true });
  });

  it('passes when mergeable_state is unknown (soft retry — do not block permanently)', async () => {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ mergeable_state: 'unknown' });
    await expect(
      evaluateAutoMergeSafety(...mergeParams, undefined),
    ).resolves.toEqual({ ok: true });
  });
});

describe('evaluateAutoMergeSafety schema deny paths', () => {
  beforeEach(() => {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([
        { filename: 'packages/core/db/schema.ts', additions: 2, deletions: 0 },
        { filename: 'packages/core/drizzle/0094_safe.sql', additions: 1, deletions: 0 },
      ]);
    mockInspectPullRequestMigrations.mockReset();
    mockInspectPullRequestMigrations.mockResolvedValue({ safe: true });
  });

  it('allows additive SQL through a schema-specific deny path', async () => {
    await expect(
      evaluateAutoMergeSafety(...mergeParams, {
        denyPaths: ['packages/core/db/schema.ts', 'packages/core/drizzle/'],
      }),
    ).resolves.toEqual({ ok: true });
    expect(mockInspectPullRequestMigrations).toHaveBeenCalledTimes(1);
  });

  it('returns the specific destructive migration reason', async () => {
    mockInspectPullRequestMigrations.mockResolvedValue({
      safe: false,
      reason: 'drops column missions.legacy_mode',
    });
    await expect(
      evaluateAutoMergeSafety(...mergeParams, {
        denyPaths: ['packages/core/db/schema.ts'],
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'drops column missions.legacy_mode',
    });
  });

  it('does not narrow an ordinary deny path', async () => {
    mockGithubApi.mockReset();
    mockGithubApi
      .mockResolvedValueOnce({ check_runs: [] })
      .mockResolvedValueOnce([
        { filename: '.github/workflows/build.yml', additions: 2, deletions: 0 },
      ]);
    await expect(
      evaluateAutoMergeSafety(...mergeParams, {
        denyPaths: ['.github/workflows/'],
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'touches protected path (.github/workflows/build.yml)',
    });
    expect(mockInspectPullRequestMigrations).not.toHaveBeenCalled();
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
