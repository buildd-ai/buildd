import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// ── Mocks ──────────────────────────────────────────────────────────────────────
// A fake GitHub answers by path, so the real `evaluateAutoMergeSafety` runs its
// rails against it: a row that merges did so because every rail passed.

mock.module('@/lib/notify', () => ({ notifyTeamOf: async () => {} }));
mock.module('@/lib/pushover', () => ({ notifyOperator: mock(() => undefined) }));

type Gh = {
  state: string;
  merged: boolean;
  head: string;
  baseRef: string;
  mergeableState: string;
  checkRuns: Array<{ name: string; status: string; conclusion: string | null }>;
  behindBy: number;
  baseTip: string;
  prFiles: string[];
  baseMovement: { ahead_by: number; files: string[] };
  failPr?: boolean;
  failCompare?: boolean;
};
let gh: Gh;
const freshGh = (): Gh => ({
  state: 'open',
  merged: false,
  head: 'head1',
  baseRef: 'dev',
  mergeableState: 'clean',
  checkRuns: [{ name: 'build', status: 'completed', conclusion: 'success' }],
  behindBy: 0,
  baseTip: 'base2',
  prFiles: ['apps/web/src/a.ts'],
  baseMovement: { ahead_by: 0, files: [] },
});

const mockGithubApi = mock(async (_installationId: number, path: string): Promise<any> => {
  if (/\/commits\/[^/]+\/check-runs$/.test(path)) return { check_runs: gh.checkRuns };
  if (/\/pulls\/42\/files/.test(path)) {
    return gh.prFiles.map((filename) => ({ filename, additions: 5, deletions: 1 }));
  }
  if (/\/pulls\/42$/.test(path)) {
    if (gh.failPr) throw new Error('boom');
    return {
      state: gh.state,
      title: 'Add the thing',
      merged: gh.merged,
      merge_commit_sha: gh.merged ? 'merge-sha' : null,
      mergeable_state: gh.mergeableState,
      head: { sha: gh.head, ref: 'buildd/task' },
      base: { ref: gh.baseRef },
    };
  }
  if (/\/compare\/dev\.\.\.[^/]+$/.test(path)) {
    if (gh.failCompare) throw new Error('compare down');
    return { behind_by: gh.behindBy };
  }
  if (/\/compare\/[^/]+\.\.\.dev$/.test(path)) {
    return {
      ahead_by: gh.baseMovement.ahead_by,
      files: gh.baseMovement.files.map((filename) => ({ filename })),
    };
  }
  if (/\/commits\/dev$/.test(path)) return { sha: gh.baseTip };
  throw new Error(`unexpected github path ${path}`);
});
const mockMergePullRequest = mock(async (..._a: any[]): Promise<any> => ({ merged: true, message: 'merged' }));
mock.module('@/lib/github', () => ({ githubApi: mockGithubApi, mergePullRequest: mockMergePullRequest }));

let mockFindFirst = mock((..._a: any[]) => null as any);
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: (...a: any[]) => mockFindFirst(...a), findMany: () => [] },
      workers: { findMany: () => [] },
      missions: { findFirst: () => null },
    },
    update: () => ({ set: () => ({ where: () => ({ returning: () => [] }) }) }),
    insert: () => ({ values: () => Promise.resolve() }),
  },
}));
mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  or: (...args: any[]) => ({ type: 'or', args }),
  sql: (strings: any, ...values: any[]) => ({ type: 'sql', strings, values }),
  isNull: (a: any) => ({ type: 'isNull', a }),
  isNotNull: (a: any) => ({ type: 'isNotNull', a }),
  inArray: (a: any, b: any) => ({ type: 'inArray', a, b }),
  ne: (a: any, b: any) => ({ type: 'ne', a, b }),
}));
mock.module('@buildd/core/db/schema', () => ({
  tasks: 'tasks',
  missionNotes: 'missionNotes',
  missions: 'missions',
  workers: 'workers',
}));
mock.module('@/lib/mission-notifications', () => ({
  notifyMissionPrReady: mock(() => Promise.resolve({ notified: false })),
}));
mock.module('@/lib/migration-inspector', () => ({
  inspectPullRequestMigrations: mock(() => Promise.resolve({ safe: true as const })),
}));
mock.module('@/lib/pr-activity-comment', () => ({
  appendPrActivity: mock(() => Promise.resolve({ action: 'updated', commentId: 1 })),
}));

const mockDispatchConflictRetry = mock(async (..._a: any[]): Promise<any> => ({ dispatched: false }));
mock.module('@/lib/conflict-retry', () => ({
  classifyMergeFailure: (m: string) => (/conflict|needs rebase/i.test(m) ? 'conflict' : 'retryable'),
  dispatchConflictRetry: mockDispatchConflictRetry,
  DEFAULT_MAX_CONFLICT_ITERATIONS: 3,
}));

type Verdict = 'approved' | 'none' | 'changes_requested' | 'escalated' | 'in_flight' | 'stale' | 'carried';
let verdict: Verdict;
const staleBlock = {
  blocks: true,
  kind: 'stale_approval',
  state: 'approved',
  reviewTaskId: 'review-1',
  reason: 'the approval was given on an earlier commit',
  clearedBy: 'Request a new review.',
};
const mockGuardReviewVerdict = mock(async (p: any): Promise<any> => {
  switch (verdict) {
    case 'approved':
    case 'none':
      return { blocks: false, state: verdict === 'none' ? 'not_requested' : 'approved' };
    case 'carried':
      return p.carryForward ? { blocks: false, state: 'approved' } : staleBlock;
    case 'stale':
      return staleBlock;
    case 'changes_requested':
      return { blocks: true, kind: 'changes_requested', state: 'changes_requested', reviewTaskId: 'review-2', reason: 'changes requested', clearedBy: 'push a fix' };
    case 'escalated':
      return { blocks: true, kind: 'escalated', state: 'escalated', reviewTaskId: 'review-3', reason: 'reviewer escalated', clearedBy: 'a human decides' };
    case 'in_flight':
      return { blocks: true, kind: 'in_flight', state: 'in_flight', reviewTaskId: 'review-4', reason: 'review running', clearedBy: 'wait' };
  }
});
mock.module('@/lib/review-verdict-gate', () => ({ guardReviewVerdict: mockGuardReviewVerdict }));

// The carry-forward primitive records the new head on the approving review task
// (a DB write). The landing function must route shadow through a dry run of it.
const mockCarryForward = mock(async (_p: any): Promise<any> => ({ carried: true, reason: 'unchanged' }));
mock.module('@/lib/approval-carry-forward', () => ({ carryForwardApprovalIfUnchanged: mockCarryForward }));

let reviewStatus: any;
const mockReadPrReviewStatus = mock(async (..._a: any[]) => reviewStatus);
mock.module('@/lib/pr-review-request', () => ({ readPrReviewStatus: mockReadPrReviewStatus }));

const mockFireGateEvent = mock((_input: any) => 'sig');
mock.module('@/lib/gate-ledger', () => ({
  fireGateEvent: mockFireGateEvent,
  GATE_SLUGS: {
    REVIEW_VERDICT: 'review_verdict',
    MERGE_BASE_FRESHNESS: 'merge_base_freshness',
    AUTO_MERGE: 'auto_merge',
    MISSION_PR_LIFECYCLE: 'mission_pr_lifecycle',
    PR_LANDING: 'pr_landing',
  },
}));

// In-memory marker store with the same compare-and-set contract as the real one.
let markerStore: any | null;
const mockWriteMarker = mock(async (_taskId: string, marker: any, expected: number) => {
  if ((markerStore?.refreshCount ?? 0) !== expected) return false;
  markerStore = { ...markerStore, ...marker };
  return true;
});
const mockClearMarker = mock(async (_taskId: string) => {
  markerStore = null;
});
mock.module('@/lib/pr-landing-marker', () => ({
  readLandingMarker: async (_t: string, pr: number) => (markerStore && markerStore.prNumber === pr ? markerStore : null),
  writeLandingMarker: mockWriteMarker,
  clearLandingMarker: mockClearMarker,
}));

// Surface merge ordering: pass-through unless a test below drives it.
let mockCheckSurfaceOrder = mock(async (_input: any): Promise<any> => ({ blocks: false, slot: null }));
let mockMergeInSurfaceSlot = mock(async (_v: any, merge: () => Promise<any>): Promise<any> => ({ result: await merge() }));
mock.module('@/lib/surface-ordering-door', () => ({
  checkSurfaceOrder: (i: any) => mockCheckSurfaceOrder(i),
  mergeInSurfaceSlot: (v: any, m: () => Promise<any>) => mockMergeInSurfaceSlot(v, m),
}));

// Post-refresh semantic hold (base-refresh.ts): pass-through unless a test sets it.
let mockCheckBaseRefreshHold = mock(async (_i: any) => ({ blocks: false }) as any);
mock.module('@/lib/base-refresh', () => ({
  checkBaseRefreshHold: (i: any) => mockCheckBaseRefreshHold(i),
}));

import {
  landPr,
  evaluateTreadmillBound,
  resolveLandingMode,
  outcomeOwner,
  TREADMILL_MAX_BASE_COMMITS,
  TREADMILL_MAX_REFRESHES,
  type LandPrInput,
  type LandPrDeps,
  type LandingOutcome,
} from './pr-landing';
import type { MergePolicy } from '@buildd/shared';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const autoThreshold: MergePolicy = { tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } };
const agentReview: MergePolicy = { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer', maxConfidenceThreshold: 0.6 } };
const humanTier: MergePolicy = { tier: 'human' };

const mockDispatchFix = mock(async (_i: any): Promise<{ taskId?: string } | null> => ({ taskId: 'fix-task-1' }));
const mockEscalate = mock(async (..._a: any[]) => {});
const mockLiveRetry = mock(async (..._a: any[]): Promise<string | null> => null);
const NOW = Date.parse('2030-01-01T01:00:00.000Z');

const deps = (): LandPrDeps => ({
  dispatchFix: mockDispatchFix,
  escalateConflictExhaustion: mockEscalate,
  findLiveReviewerRetry: mockLiveRetry,
  now: () => NOW,
});

const input = (over: Partial<LandPrInput> = {}): LandPrInput => ({
  workspaceId: 'ws-1',
  installationId: 7,
  repoFullName: 'buildd-ai/buildd',
  prNumber: 42,
  eventHeadSha: 'head1',
  door: 'check_suite',
  actor: { kind: 'system' },
  mode: 'enforce',
  policy: autoThreshold,
  owner: { taskId: 'task-1', workerId: 'worker-1' },
  ...over,
});

const land = (over: Partial<LandPrInput> = {}, d: LandPrDeps = deps()) => landPr(input(over), d);

const marker = (over: Record<string, unknown> = {}) => ({
  prNumber: 42,
  pendingHeadSha: 'head1',
  baseShaAtUpdate: 'base1',
  refreshCount: 1,
  firstApprovedGreenAt: '2030-01-01T00:40:00.000Z',
  lastOutcome: 'updating_branch',
  ...over,
});

const landingEvents = () => mockFireGateEvent.mock.calls.map((c) => c[0]).filter((e: any) => e.gate === 'pr_landing');

beforeEach(() => {
  gh = freshGh();
  verdict = 'approved';
  reviewStatus = { state: 'approved', verdict: 'approve', confidence: 0.9, merged: false };
  markerStore = null;
  mockFindFirst = mock(() => null as any);
  for (const m of [
    mockGithubApi, mockMergePullRequest, mockDispatchConflictRetry, mockGuardReviewVerdict, mockReadPrReviewStatus,
    mockFireGateEvent, mockWriteMarker, mockClearMarker, mockDispatchFix, mockEscalate, mockLiveRetry, mockCarryForward,
  ]) {
    m.mockClear();
  }
  mockMergePullRequest.mockImplementation(async () => ({ merged: true, message: 'merged' }));
  mockDispatchConflictRetry.mockImplementation(async () => ({ dispatched: false }));
  mockDispatchFix.mockImplementation(async () => ({ taskId: 'fix-task-1' }));
  mockLiveRetry.mockImplementation(async () => null);
});

// ── Pure pieces ────────────────────────────────────────────────────────────────

describe('evaluateTreadmillBound', () => {
  const ok = { marker: marker(), liveHeadSha: 'head1', baseCommitsSince: 1, baseFiles: ['x/other.ts'], prFiles: ['apps/web/src/a.ts'] };

  it('accepts a head a refresh produced when the base moved a little, elsewhere', () => {
    expect(evaluateTreadmillBound(ok)).toEqual({ accepted: true });
  });

  it('accepts exactly N base commits and refuses N+1', () => {
    expect(evaluateTreadmillBound({ ...ok, baseCommitsSince: TREADMILL_MAX_BASE_COMMITS }).accepted).toBe(true);
    expect(evaluateTreadmillBound({ ...ok, baseCommitsSince: TREADMILL_MAX_BASE_COMMITS + 1 }).accepted).toBe(false);
  });

  it('refuses without a marker for this head', () => {
    expect(evaluateTreadmillBound({ ...ok, marker: null }).accepted).toBe(false);
    expect(evaluateTreadmillBound({ ...ok, marker: marker({ pendingHeadSha: 'older' }) }).accepted).toBe(false);
  });

  it('refuses when a base commit touches a file the PR touches', () => {
    const r = evaluateTreadmillBound({ ...ok, baseFiles: ['apps/web/src/a.ts'] });
    expect(r.accepted).toBe(false);
  });

  it.each([
    ['migration on the base side', ['packages/core/drizzle/0100_x.sql'], ['apps/web/src/a.ts']],
    ['migration on the PR side', ['x/other.ts'], ['packages/core/drizzle/0100_x.sql']],
    ['schema on the PR side', ['x/other.ts'], ['packages/core/db/schema.ts']],
    ['lockfile on the base side', ['bun.lock'], ['apps/web/src/a.ts']],
    ['lockfile on the PR side', ['x/other.ts'], ['package-lock.json']],
  ])('refuses %s', (_n, baseFiles, prFiles) => {
    expect(evaluateTreadmillBound({ ...ok, baseFiles, prFiles }).accepted).toBe(false);
  });

  it('refuses when either side could not be enumerated', () => {
    expect(evaluateTreadmillBound({ ...ok, baseFiles: null }).accepted).toBe(false);
    expect(evaluateTreadmillBound({ ...ok, prFiles: null }).accepted).toBe(false);
  });
});

describe('resolveLandingMode', () => {
  it('defaults to shadow', () => {
    expect(resolveLandingMode(undefined)).toBe('shadow');
    expect(resolveLandingMode({} as any)).toBe('shadow');
    expect(resolveLandingMode({ landing: {} } as any)).toBe('shadow');
  });
  it('reads an explicit mode and ignores garbage', () => {
    expect(resolveLandingMode({ landing: { mode: 'off' } } as any)).toBe('off');
    expect(resolveLandingMode({ landing: { mode: 'enforce' } } as any)).toBe('enforce');
    expect(resolveLandingMode({ landing: { mode: 'turbo' } } as any)).toBe('shadow');
  });
});

// ── Happy path and idempotence ─────────────────────────────────────────────────

describe('landPr — merge', () => {
  it('merges an approved, green, fresh PR pinned to the live head and clears the marker', async () => {
    markerStore = marker({ pendingHeadSha: 'head1' });
    const out = await land();
    expect(out).toEqual({ kind: 'merged', sha: 'head1' });
    expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
    expect(mockMergePullRequest.mock.calls[0]).toEqual([7, 'buildd-ai/buildd', 42, 'squash', 'head1']);
    expect(mockClearMarker).toHaveBeenCalledWith('task-1');
    const [event] = landingEvents();
    expect(event.outcome).toBe('accepted');
    expect(event.detail.landingOutcome).toBe('merged');
    expect(event.detail.timeToLandMs).toBe(20 * 60 * 1000);
  });

  it('merges with the caller-chosen method (merge_pr), squash by default', async () => {
    await land({ door: 'merge_pr', mergeMethod: 'rebase' });
    expect(mockMergePullRequest.mock.calls[0]![3]).toBe('rebase');
  });

  it('is a no-op on a PR that already merged', async () => {
    gh.state = 'closed';
    gh.merged = true;
    const out = await land();
    expect(out).toEqual({ kind: 'merged', sha: 'merge-sha' });
    expect(mockMergePullRequest).not.toHaveBeenCalled();
    expect(landingEvents()).toHaveLength(0);
  });

  it('reports a closed, unmerged PR to a human without acting', async () => {
    gh.state = 'closed';
    const out = await land();
    expect(out).toMatchObject({ kind: 'needs_human', cause: 'pr_closed' });
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('treats mergeable_state unknown as "GitHub is still computing" and merges', async () => {
    gh.mergeableState = 'unknown';
    expect((await land()).kind).toBe('merged');
  });

  it('does not act on an event for a head that is no longer live', async () => {
    const out = await land({ eventHeadSha: 'old-head' });
    expect(out).toEqual({ kind: 'waiting_ci', headSha: 'head1' });
    expect(mockMergePullRequest).not.toHaveBeenCalled();
    expect(mockDispatchConflictRetry).not.toHaveBeenCalled();
    expect(landingEvents()).toHaveLength(0);
  });

  it('reports the refresh as in flight when a stale event arrives for a live marker', async () => {
    markerStore = marker({ pendingHeadSha: 'head1' });
    const out = await land({ eventHeadSha: 'old-head' });
    expect(out).toEqual({ kind: 'updating_branch', newHeadSha: 'head1' });
    expect(landingEvents()).toHaveLength(0);
  });

  it('turns an unreadable PR into an explicit outcome, never a throw', async () => {
    gh.failPr = true;
    const out = await land();
    expect(out).toMatchObject({ kind: 'needs_human', cause: 'github_unreadable' });
    expect(landingEvents()).toHaveLength(1);
  });
});

// ── Verdict × tier ─────────────────────────────────────────────────────────────

describe('landPr — review verdict', () => {
  it('always passes the carry-forward hint so a diff-unchanged head is approved (replay: base-merge push in the same minute)', async () => {
    verdict = 'carried';
    const out = await land();
    expect(out.kind).toBe('merged');
    expect(mockGuardReviewVerdict.mock.calls[0]![0]).toMatchObject({
      workspaceId: 'ws-1',
      prNumber: 42,
      headSha: 'head1',
      carryForward: { installationId: 7, repoFullName: 'buildd-ai/buildd', baseRef: 'dev' },
    });
  });

  it('never merges a diff-changing push: stale approval dispatches one re-review (replay: conflict resolution that changed the diff)', async () => {
    verdict = 'stale';
    const out = await land();
    expect(out).toEqual({ kind: 'needs_fix', fix: 're_review', taskId: 'fix-task-1', reason: expect.stringContaining('earlier commit') });
    expect(mockMergePullRequest).not.toHaveBeenCalled();
    expect(mockDispatchFix).toHaveBeenCalledTimes(1);
    expect(mockDispatchFix.mock.calls[0]![0]).toMatchObject({ kind: 're_review', prNumber: 42, headSha: 'head1' });
    const [event] = landingEvents();
    expect(event.detail).toMatchObject({ landingOutcome: 'needs_fix', prNumber: 42, headSha: 'head1' });
  });

  it.each(['changes_requested', 'escalated'] as const)('%s with no retry in flight is a human decision', async (v) => {
    verdict = v;
    const out = await land();
    expect(out).toMatchObject({ kind: 'needs_human', cause: 'blocking_verdict' });
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('changes_requested with a live reviewer retry names that task instead of paging', async () => {
    verdict = 'changes_requested';
    mockLiveRetry.mockImplementation(async () => 'retry-task-9');
    const out = await land();
    expect(out).toMatchObject({ kind: 'needs_fix', fix: 're_review', taskId: 'retry-task-9' });
  });

  it('waits while a reviewer is working, without paging', async () => {
    verdict = 'in_flight';
    const out = await land();
    expect(out).toEqual({ kind: 'waiting_ci', headSha: 'head1' });
    expect(landingEvents()[0].outcome).toBe('deferred');
  });

  it('a stale approval with no dispatcher wired still names the gap instead of going silent', async () => {
    verdict = 'stale';
    const out = await land({}, { ...deps(), dispatchFix: undefined });
    expect(out).toMatchObject({ kind: 'needs_fix', fix: 're_review' });
    expect((out as any).taskId).toBeUndefined();
    expect(landingEvents()[0].detail.fixDispatched).toBe(false);
  });

  it('a fix dispatcher that throws becomes needs_human, not a silent needs_fix', async () => {
    verdict = 'stale';
    mockDispatchFix.mockImplementation(async () => {
      throw new Error('queue down');
    });
    const out = await land();
    expect(out).toMatchObject({ kind: 'needs_human', cause: 'merge_failed' });
  });
});

describe('landPr — tier', () => {
  it('human tier stays in the human queue (no page cause)', async () => {
    const out = await land({ policy: humanTier });
    expect(out).toMatchObject({ kind: 'needs_human', cause: 'human_tier' });
    expect(mockMergePullRequest).not.toHaveBeenCalled();
    expect(landingEvents()[0].outcome).toBe('deferred');
  });

  it('a person on the dashboard is the human gate and may land a human-tier PR', async () => {
    const out = await land({ policy: humanTier, door: 'dashboard', actor: { kind: 'human', userId: 'u1' } });
    expect(out.kind).toBe('merged');
  });

  it('agent-review: a stored approve above the confidence bar merges', async () => {
    expect((await land({ policy: agentReview, door: 'merge_pr', actor: { kind: 'agent', workerId: 'w1' } })).kind).toBe('merged');
  });

  it('agent-review: no approval on file asks for a review', async () => {
    verdict = 'none';
    reviewStatus = { state: 'not_requested', verdict: null, confidence: null, merged: false };
    const out = await land({ policy: agentReview });
    expect(out).toMatchObject({ kind: 'needs_fix', fix: 're_review', taskId: 'fix-task-1' });
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('agent-review: an approve below the confidence bar is a human decision', async () => {
    reviewStatus = { state: 'approved', verdict: 'approve', confidence: 0.3, merged: false };
    const out = await land({ policy: agentReview });
    expect(out).toMatchObject({ kind: 'needs_human', cause: 'low_confidence' });
  });

  it('auto-threshold with no review requested merges on green (no reviewer was asked)', async () => {
    verdict = 'none';
    expect((await land()).kind).toBe('merged');
  });
});

// ── Safety rails ───────────────────────────────────────────────────────────────

describe('landPr — safety rails', () => {
  it('pending CI waits', async () => {
    gh.checkRuns = [{ name: 'build', status: 'in_progress', conclusion: null }];
    expect(await land()).toEqual({ kind: 'waiting_ci', headSha: 'head1' });
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('red CI is a CI fix, never a merge (replay: unrelated-flake red check)', async () => {
    gh.checkRuns = [{ name: 'build', status: 'completed', conclusion: 'failure' }];
    const out = await land();
    expect(out).toMatchObject({ kind: 'needs_fix', fix: 'ci_fix', taskId: 'fix-task-1' });
    expect(mockMergePullRequest).not.toHaveBeenCalled();
    expect(mockDispatchFix.mock.calls[0]![0]).toMatchObject({ kind: 'ci_fix' });
  });

  it('a protected path is a human decision', async () => {
    gh.prFiles = ['secrets/key.ts'];
    const out = await land({ policy: { tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: ['secrets/'] } } });
    expect(out).toMatchObject({ kind: 'needs_human', cause: 'deny_path' });
  });

  it('an oversize diff is a human decision', async () => {
    const out = await land({ policy: { tier: 'auto-threshold', threshold: { maxLines: 3, denyPaths: [] } } });
    expect(out).toMatchObject({ kind: 'needs_human', cause: 'size_cap' });
  });

  it('a conflicting PR dispatches the conflict agent (not update-branch)', async () => {
    gh.mergeableState = 'dirty';
    mockDispatchConflictRetry.mockImplementation(async () => ({ dispatched: true, taskId: 'conflict-task-1' }));
    const out = await land();
    expect(out).toMatchObject({ kind: 'needs_fix', fix: 'conflict', taskId: 'conflict-task-1' });
    expect(mockDispatchConflictRetry.mock.calls[0]![0].behindOnly).toBeFalsy();
  });

  it('branch protection is a human decision', async () => {
    gh.mergeableState = 'blocked';
    expect(await land()).toMatchObject({ kind: 'needs_human', cause: 'branch_protection' });
  });

  it('never merges red CI for any verdict, tier or actor', async () => {
    gh.checkRuns = [{ name: 'build', status: 'completed', conclusion: 'failure' }];
    const verdicts: Verdict[] = ['none', 'approved', 'carried', 'stale', 'in_flight'];
    for (const v of verdicts) {
      verdict = v;
      for (const policy of [autoThreshold, agentReview, humanTier]) {
        for (const actor of [{ kind: 'system' }, { kind: 'human', userId: 'u', override: { verdict: true, freshness: true, size: true } }] as const) {
          await land({ policy, actor: actor as any, door: actor.kind === 'human' ? 'dashboard' : 'check_suite' });
        }
      }
    }
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('a model-approve bound refusal falls back to the unbounded rule for a self-mergeable approval', async () => {
    // The bound needs build/test proof in the check runs; 'build' alone has none for `test`.
    const out = await land(
      { policy: agentReview, door: 'approve', bound: { protectedBranches: ['dev'] } },
    );
    expect(out.kind).toBe('merged');
    expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
  });
});

// ── Behind base ────────────────────────────────────────────────────────────────

describe('landPr — behind base is work with an owner', () => {
  beforeEach(() => {
    gh.behindBy = 1;
    mockDispatchConflictRetry.mockImplementation(async () => {
      gh.head = 'head2';
      gh.behindBy = 0;
      return { dispatched: true, branchUpdated: true };
    });
  });

  it('refreshes once against the live head, writes the marker, files no conflict task', async () => {
    const out = await land();
    expect(out).toEqual({ kind: 'updating_branch', newHeadSha: 'head2' });
    expect(mockDispatchConflictRetry).toHaveBeenCalledTimes(1);
    expect(mockDispatchConflictRetry.mock.calls[0]![0]).toMatchObject({
      behindOnly: true, headSha: 'head1', prNumber: 42, workerId: 'worker-1', taskId: 'task-1', workspaceId: 'ws-1',
    });
    expect(markerStore).toMatchObject({
      prNumber: 42, pendingHeadSha: 'head2', baseShaAtUpdate: 'base2', refreshCount: 1,
      firstApprovedGreenAt: new Date(NOW).toISOString(), lastOutcome: 'updating_branch',
    });
    expect(mockDispatchFix).not.toHaveBeenCalled();
    expect(mockMergePullRequest).not.toHaveBeenCalled();
    const [event] = landingEvents();
    expect(event).toMatchObject({ outcome: 'deferred', detail: { landingOutcome: 'updating_branch', prNumber: 42, headSha: 'head1' } });
    expect(outcomeOwner(out)).toEqual({ kind: 'marker', headSha: 'head2' });
  });

  it('replay: approval, same-minute base-merge push with unchanged diff, then green → carried, one refresh, merged', async () => {
    verdict = 'carried';
    // Event 1: the approve lands while the head is behind.
    const first = await land({ door: 'approve' });
    expect(first).toEqual({ kind: 'updating_branch', newHeadSha: 'head2' });
    // Event 2: green on the pushed head, base moved one unrelated commit since.
    gh.baseMovement = { ahead_by: 1, files: ['packages/other/x.ts'] };
    gh.behindBy = 1;
    mockDispatchConflictRetry.mockClear();
    const second = await land({ eventHeadSha: 'head2' });
    expect(second).toEqual({ kind: 'merged', sha: 'head2' });
    expect(mockDispatchConflictRetry).not.toHaveBeenCalled();
    expect(mockDispatchFix).not.toHaveBeenCalled();
    expect(mockMergePullRequest.mock.calls[0]).toEqual([7, 'buildd-ai/buildd', 42, 'squash', 'head2']);
    expect(markerStore).toBeNull();
  });

  it.each([
    ['base moved past N commits', { ahead_by: TREADMILL_MAX_BASE_COMMITS + 1, files: ['x/o.ts'] }],
    ['base touched a file the PR touches', { ahead_by: 1, files: ['apps/web/src/a.ts'] }],
    ['base touched a migration', { ahead_by: 1, files: ['packages/core/drizzle/0200_y.sql'] }],
  ])('refreshes again when %s', async (_n, movement) => {
    markerStore = marker({ pendingHeadSha: 'head1', refreshCount: 1 });
    gh.baseMovement = movement;
    const out = await land();
    expect(out.kind).toBe('updating_branch');
    expect(mockDispatchConflictRetry).toHaveBeenCalledTimes(1);
    expect(markerStore.refreshCount).toBe(2);
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('does not tolerate staleness on a head no refresh produced', async () => {
    markerStore = marker({ pendingHeadSha: 'some-earlier-head', refreshCount: 1 });
    gh.baseMovement = { ahead_by: 1, files: ['x/o.ts'] };
    expect((await land()).kind).toBe('updating_branch');
    expect(mockDispatchConflictRetry).toHaveBeenCalledTimes(1);
  });

  it('the refresh after R losses is needs_human(refresh_exhausted), with no further push', async () => {
    markerStore = marker({ pendingHeadSha: 'head1', refreshCount: TREADMILL_MAX_REFRESHES });
    gh.baseMovement = { ahead_by: TREADMILL_MAX_BASE_COMMITS + 1, files: [] };
    const out = await land();
    expect(out).toMatchObject({ kind: 'needs_human', cause: 'refresh_exhausted' });
    expect(mockDispatchConflictRetry).not.toHaveBeenCalled();
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('a lost marker race still reports the refresh as in flight', async () => {
    mockWriteMarker.mockImplementationOnce(async () => false);
    markerStore = null;
    const out = await land();
    expect(out).toEqual({ kind: 'updating_branch', newHeadSha: 'head2' });
  });

  it('GitHub reporting `behind` counts as behind even when the compare says zero', async () => {
    gh.behindBy = 0;
    gh.mergeableState = 'behind';
    expect((await land()).kind).toBe('updating_branch');
  });

  it('an unreadable freshness comparison fails closed into a wait', async () => {
    gh.failCompare = true;
    expect((await land()).kind).toBe('waiting_ci');
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('a behind PR with no owning task is an explicit human outcome', async () => {
    const out = await land({ owner: { taskId: null, workerId: null } });
    expect(out).toMatchObject({ kind: 'needs_human', cause: 'no_owner' });
    expect(mockDispatchConflictRetry).not.toHaveBeenCalled();
  });

  describe('every refresh result maps to an explicit outcome', () => {
    it('dedup hit (no dispatch, no flag) → needs_fix(conflict)', async () => {
      mockDispatchConflictRetry.mockImplementation(async () => ({ dispatched: false }));
      const out = await land();
      expect(out).toMatchObject({ kind: 'needs_fix', fix: 'conflict' });
      expect(landingEvents()).toHaveLength(1);
    });
    it('a live retry task → needs_fix(conflict) naming it', async () => {
      mockDispatchConflictRetry.mockImplementation(async () => ({ dispatched: false, inFlightTaskId: 'live-retry-1' }));
      expect(await land()).toMatchObject({ kind: 'needs_fix', fix: 'conflict', taskId: 'live-retry-1' });
    });
    it('an agent task filed because update-branch was refused → needs_fix(conflict)', async () => {
      mockDispatchConflictRetry.mockImplementation(async () => ({ dispatched: true, taskId: 'agent-retry-1' }));
      expect(await land()).toMatchObject({ kind: 'needs_fix', fix: 'conflict', taskId: 'agent-retry-1' });
    });
    it('exhausted → existing escalation + needs_human(fix_exhausted)', async () => {
      mockDispatchConflictRetry.mockImplementation(async () => ({ dispatched: false, exhausted: true }));
      expect(await land()).toMatchObject({ kind: 'needs_human', cause: 'fix_exhausted' });
      expect(mockEscalate).toHaveBeenCalledWith('task-1', 'buildd-ai/buildd', 42, 'head1');
    });
    it.each([
      ['superseded', { dispatched: false, superseded: true }, 'superseded'],
      ['dependencyBot', { dispatched: false, dependencyBot: true }, 'dependency_bot'],
      ['baseRewritten', { dispatched: false, baseRewritten: true }, 'base_rewritten'],
      ['disabled', { dispatched: false, disabled: true }, 'auto_resolve_disabled'],
    ])('%s → needs_human(%s)', async (_n, result, cause) => {
      mockDispatchConflictRetry.mockImplementation(async () => result);
      expect(await land()).toMatchObject({ kind: 'needs_human', cause });
    });
    // conflict-aware-orchestration §4: a refresh failure that is not a conflict
    // never reads as a conflict fix, and never spawns one.
    it.each([
      ['headChanged', { dispatched: false, headChanged: true }],
      ['refreshInFlight', { dispatched: false, refreshInFlight: true }],
      ['refreshDeferred', { dispatched: false, refreshDeferred: true, refreshFailure: 'rate_limit' }],
      ['semanticDeferred', { dispatched: false, semanticDeferred: true }],
      ['alreadyUpToDate', { dispatched: false, alreadyUpToDate: true }],
    ])('%s → waiting, not needs_fix(conflict)', async (_n, result) => {
      mockDispatchConflictRetry.mockImplementation(async () => result);
      const out = await land();
      expect(out.kind).toBe('waiting_ci');
      expect(mockEscalate).not.toHaveBeenCalled();
    });
    it.each([
      ['refreshExhausted', { dispatched: false, refreshExhausted: true, refreshFailure: 'auth' }, 'refresh_failed'],
      ['semanticUnverified', { dispatched: false, semanticUnverified: true }, 'semantic_unverified'],
    ])('%s → needs_human(%s), not fix_exhausted', async (_n, result, cause) => {
      mockDispatchConflictRetry.mockImplementation(async () => result);
      expect(await land()).toMatchObject({ kind: 'needs_human', cause });
      expect(mockEscalate).not.toHaveBeenCalled();
    });
    it('a throwing dispatch → needs_human, not an exception', async () => {
      mockDispatchConflictRetry.mockImplementation(async () => {
        throw new Error('db down');
      });
      expect(await land()).toMatchObject({ kind: 'needs_human', cause: 'merge_failed' });
    });
  });
});

// ── Merge API races ────────────────────────────────────────────────────────────

describe('landPr — merge call failures', () => {
  it('"base modified" is a behind-base refresh', async () => {
    mockMergePullRequest.mockImplementation(async () => ({ merged: false, message: 'Base branch was modified. Review and try the merge again.' }));
    mockDispatchConflictRetry.mockImplementation(async () => {
      gh.head = 'head2';
      return { dispatched: true, branchUpdated: true };
    });
    const out = await land();
    expect(out).toEqual({ kind: 'updating_branch', newHeadSha: 'head2' });
    expect(mockDispatchConflictRetry.mock.calls[0]![0].behindOnly).toBe(true);
  });

  it('"head modified" means a newer head exists; its own event re-drives', async () => {
    mockMergePullRequest.mockImplementation(async () => ({ merged: false, message: 'Head branch was modified. Review and try the merge again.' }));
    expect(await land()).toEqual({ kind: 'waiting_ci', headSha: 'head1' });
    expect(mockDispatchConflictRetry).not.toHaveBeenCalled();
  });

  it('a merge conflict race goes to the conflict agent', async () => {
    mockMergePullRequest.mockImplementation(async () => ({ merged: false, message: 'Pull Request is not mergeable: merge conflict' }));
    mockDispatchConflictRetry.mockImplementation(async () => ({ dispatched: true, taskId: 'c1' }));
    expect(await land()).toMatchObject({ kind: 'needs_fix', fix: 'conflict', taskId: 'c1' });
  });

  it('any other refusal is a human outcome with the message', async () => {
    mockMergePullRequest.mockImplementation(async () => ({ merged: false, message: 'Repository rule violations found' }));
    expect(await land()).toMatchObject({ kind: 'needs_human', cause: 'merge_failed', reason: expect.stringContaining('Repository rule violations') });
  });

  it('an indeterminate answer re-reads the PR and reports the merge if it went through', async () => {
    mockMergePullRequest.mockImplementation(async () => {
      gh.state = 'closed';
      gh.merged = true;
      return { merged: false, message: 'Could not reach GitHub', indeterminate: true };
    });
    expect(await land()).toEqual({ kind: 'merged', sha: 'merge-sha' });
  });

  it('an indeterminate answer where the PR is still open waits for the backstop', async () => {
    mockMergePullRequest.mockImplementation(async () => ({ merged: false, message: 'Could not reach GitHub', indeterminate: true }));
    expect(await land()).toEqual({ kind: 'waiting_ci', headSha: 'head1' });
  });
});

// ── Human override ─────────────────────────────────────────────────────────────

describe('landPr — human override', () => {
  const human = (override: any) => ({ kind: 'human' as const, userId: 'u1', override });

  it('a blocking verdict can be overridden and is recorded as a bypass', async () => {
    verdict = 'changes_requested';
    const out = await land({ door: 'dashboard', actor: human({ verdict: true }) });
    expect(out.kind).toBe('merged');
    const bypass = mockFireGateEvent.mock.calls.map((c) => c[0]).find((e: any) => e.gate === 'review_verdict');
    expect(bypass).toMatchObject({ outcome: 'bypassed', callerOrigin: 'dashboard' });
  });

  it('without the override flag a human is held to the verdict like anyone else', async () => {
    verdict = 'changes_requested';
    const out = await land({ door: 'dashboard', actor: human(undefined) });
    expect(out).toMatchObject({ kind: 'needs_human', cause: 'blocking_verdict' });
  });

  it('the size cap can be overridden', async () => {
    const out = await land({
      door: 'dashboard',
      actor: human({ size: true }),
      policy: { tier: 'auto-threshold', threshold: { maxLines: 3, denyPaths: [] } },
    });
    expect(out.kind).toBe('merged');
  });

  it('the freshness bound can be overridden and is recorded as a bypass', async () => {
    gh.behindBy = 2;
    const out = await land({ door: 'dashboard', actor: human({ freshness: true }) });
    expect(out.kind).toBe('merged');
    expect(mockDispatchConflictRetry).not.toHaveBeenCalled();
    const bypass = mockFireGateEvent.mock.calls.map((c) => c[0]).find((e: any) => e.gate === 'merge_base_freshness');
    expect(bypass).toMatchObject({ outcome: 'bypassed' });
  });

  it('red CI and a deny path cannot be overridden', async () => {
    const all = human({ verdict: true, size: true, freshness: true });
    gh.checkRuns = [{ name: 'build', status: 'completed', conclusion: 'failure' }];
    expect((await land({ door: 'dashboard', actor: all })).kind).toBe('needs_fix');
    gh.checkRuns = [{ name: 'build', status: 'completed', conclusion: 'success' }];
    gh.prFiles = ['secrets/key.ts'];
    const out = await land({
      door: 'dashboard',
      actor: all,
      policy: { tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: ['secrets/'] } },
    });
    expect(out).toMatchObject({ kind: 'needs_human', cause: 'deny_path' });
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });
});

// ── Shadow mode ────────────────────────────────────────────────────────────────

describe('landPr — shadow mode', () => {
  it('computes and records the outcome but acts on nothing (would-merge)', async () => {
    const out = await land({ mode: 'shadow' });
    expect(out).toEqual({ kind: 'merged', sha: 'head1' });
    expect(mockMergePullRequest).not.toHaveBeenCalled();
    expect(mockClearMarker).not.toHaveBeenCalled();
    const [event] = landingEvents();
    expect(event).toMatchObject({ outcome: 'warned', detail: { shadowOutcome: 'merged', mode: 'shadow', prNumber: 42, headSha: 'head1' } });
  });

  it('would-refresh: no push, no marker, no dispatch', async () => {
    gh.behindBy = 1;
    const out = await land({ mode: 'shadow' });
    expect(out).toMatchObject({ kind: 'updating_branch' });
    expect(mockDispatchConflictRetry).not.toHaveBeenCalled();
    expect(mockWriteMarker).not.toHaveBeenCalled();
    expect(landingEvents()[0].detail.shadowOutcome).toBe('updating_branch');
  });

  it('would-dispatch-fix: no fix task is created', async () => {
    verdict = 'stale';
    const out = await land({ mode: 'shadow' });
    expect(out).toMatchObject({ kind: 'needs_fix', fix: 're_review' });
    expect(mockDispatchFix).not.toHaveBeenCalled();
    expect(mockEscalate).not.toHaveBeenCalled();
  });

  it('would-escalate: the exhaustion page is not sent', async () => {
    gh.behindBy = 1;
    mockDispatchConflictRetry.mockImplementation(async () => ({ dispatched: false, exhausted: true }));
    markerStore = marker({ refreshCount: 0, pendingHeadSha: 'x' });
    // shadow never dispatches, so exhaustion cannot even be observed — it must not escalate either.
    await land({ mode: 'shadow' });
    expect(mockEscalate).not.toHaveBeenCalled();
  });

  it('would-carry-forward: the approval is evaluated but never recorded on the review task', async () => {
    verdict = 'carried';
    const out = await land({ mode: 'shadow' });
    expect(out).toEqual({ kind: 'merged', sha: 'head1' });
    const p = mockGuardReviewVerdict.mock.calls[0][0];
    expect(p.carryForward).toBeTruthy();
    expect(typeof p.deps?.carryForward).toBe('function');
    await p.deps.carryForward({ installationId: 7, repoFullName: 'r', workspaceId: 'ws-1', prNumber: 42, baseRef: 'dev', headSha: 'head1' });
    const record = mockCarryForward.mock.calls[0][0].deps?.record;
    expect(typeof record).toBe('function');
    // the dry-run recorder touches nothing
    await expect(record({ reviewTaskId: 'review-1', headSha: 'head1' })).resolves.toBeUndefined();
  });

  it('enforce keeps the real carry-forward (it records the equivalent head)', async () => {
    verdict = 'carried';
    await land({ mode: 'enforce' });
    expect(mockGuardReviewVerdict.mock.calls[0][0].deps?.carryForward).toBeUndefined();
  });
});

describe('landPr — fails open on an unexpected error', () => {
  for (const mode of ['shadow', 'enforce', 'off'] as const) {
    it(`${mode}: a throwing dependency resolves to needs_human without merging`, async () => {
      mockGuardReviewVerdict.mockImplementationOnce(async () => { throw new Error('db down'); });
      const out = await land({ mode });
      expect(out).toMatchObject({ kind: 'needs_human', cause: 'landing_error' });
      expect(mockMergePullRequest).not.toHaveBeenCalled();
      expect(mockDispatchConflictRetry).not.toHaveBeenCalled();
      expect(landingEvents()).toHaveLength(mode === 'off' ? 0 : 1);
      if (mode === 'shadow') expect(landingEvents()[0]).toMatchObject({ outcome: 'warned', detail: { shadowOutcome: 'needs_human' } });
    });
  }

  it('a throwing ledger write cannot fail the landing either', async () => {
    mockFireGateEvent.mockImplementationOnce(() => { throw new Error('ledger down'); });
    await expect(land({ mode: 'shadow' })).resolves.toEqual({ kind: 'merged', sha: 'head1' });
  });
});

// ── Exactly-one-event invariant ────────────────────────────────────────────────

describe('landPr — every non-merged outcome writes exactly one landing event', () => {
  const scenarios: Array<[string, () => void, Partial<LandPrInput>?]> = [
    ['waiting_ci: pending', () => { gh.checkRuns = [{ name: 'build', status: 'queued', conclusion: null }]; }],
    ['needs_fix: ci', () => { gh.checkRuns = [{ name: 'build', status: 'completed', conclusion: 'failure' }]; }],
    ['needs_fix: re_review', () => { verdict = 'stale'; }],
    ['needs_human: blocking', () => { verdict = 'changes_requested'; }],
    ['needs_human: human tier', () => {}, { policy: humanTier }],
    ['needs_human: blocked', () => { gh.mergeableState = 'blocked'; }],
    ['updating_branch', () => { gh.behindBy = 1; mockDispatchConflictRetry.mockImplementation(async () => ({ dispatched: true, branchUpdated: true })); }],
    ['needs_fix: dirty', () => { gh.mergeableState = 'dirty'; mockDispatchConflictRetry.mockImplementation(async () => ({ dispatched: true, taskId: 't' })); }],
  ];

  it.each(scenarios)('%s', async (_n, arrange, over) => {
    arrange();
    const out = await land(over ?? {});
    expect(out.kind).not.toBe('merged');
    const events = landingEvents();
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ landingOutcome: out.kind, prNumber: 42, headSha: 'head1' });
    expect(typeof events[0].reason).toBe('string');
    expect(outcomeOwner(out)).toBeTruthy();
  });
});

describe('outcomeOwner', () => {
  it('names who is responsible for every outcome kind', () => {
    const cases: Array<[LandingOutcome, unknown]> = [
      [{ kind: 'updating_branch', newHeadSha: 'h' }, { kind: 'marker', headSha: 'h' }],
      [{ kind: 'waiting_ci', headSha: 'h' }, { kind: 'checks', headSha: 'h' }],
      [{ kind: 'needs_fix', reason: 'r', fix: 'ci_fix', taskId: 't' }, { kind: 'task', taskId: 't' }],
      [{ kind: 'needs_fix', reason: 'r', fix: 'ci_fix' }, { kind: 'unassigned_fix', fix: 'ci_fix' }],
      [{ kind: 'needs_human', reason: 'r', cause: 'deny_path' }, { kind: 'human', cause: 'deny_path' }],
    ];
    for (const [o, want] of cases) expect(outcomeOwner(o)).toEqual(want);
    expect(outcomeOwner({ kind: 'merged', sha: 's' })).toBeNull();
  });
});

describe('landPr — alert hook', () => {
  const alertMock = mock(async (_i: any) => {});
  beforeEach(() => alertMock.mockClear());

  it('hands the outcome, live head and PR title to the alert in enforce', async () => {
    gh.prFiles = ['secrets/key.ts'];
    const policy: MergePolicy = { tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: ['secrets/'] } };
    const out = await land({ policy }, { ...deps(), alert: alertMock });
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0]![0]).toMatchObject({
      workspaceId: 'ws-1',
      prNumber: 42,
      headSha: 'head1',
      prTitle: 'Add the thing',
      taskId: 'task-1',
      outcome: out,
    });
  });

  it('does not page from shadow or off', async () => {
    gh.checkRuns = [{ name: 'build', status: 'completed', conclusion: 'failure' }];
    await land({ mode: 'shadow' }, { ...deps(), alert: alertMock });
    await land({ mode: 'off' }, { ...deps(), alert: alertMock });
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('an alert that throws never changes the landing outcome', async () => {
    gh.checkRuns = [{ name: 'build', status: 'completed', conclusion: 'failure' }];
    const out = await land({}, { ...deps(), alert: async () => { throw new Error('pushover down'); } });
    expect(out).toMatchObject({ kind: 'needs_fix', fix: 'ci_fix' });
  });
});

// ── Surface merge ordering (conflict-aware-orchestration.md §3) ──────────────
describe('landPr — surface ordering', () => {
  const blocked = { blocks: true, kind: 'ordering', reason: 'waiting for PR #41 to close first: both change Drizzle migrations', counterpartPrNumber: 41, surface: 'Drizzle migrations' };

  beforeEach(() => {
    mockCheckSurfaceOrder = mock(async () => ({ blocks: false, slot: null }));
    mockMergeInSurfaceSlot = mock(async (_v: any, merge: () => Promise<any>) => ({ result: await merge() }));
  });

  it('a later surface PR waits before any rail, refresh or merge, with its counterpart on the ledger row', async () => {
    mockCheckSurfaceOrder = mock(async () => blocked);
    const outcome = await land({ gitConfig: { surfaceOrdering: 'enforce' } as any });
    expect(outcome.kind).toBe('waiting_ci');
    expect(mockMergePullRequest).not.toHaveBeenCalled();
    expect(mockDispatchConflictRetry).not.toHaveBeenCalled();
    expect(mockGuardReviewVerdict).not.toHaveBeenCalled();
    const row = landingEvents().at(-1) as any;
    expect(row.detail).toMatchObject({ waitingOn: 'surface_order', counterpartPrNumber: 41, surface: 'Drizzle migrations' });
    expect(mockCheckSurfaceOrder.mock.calls[0][0]).toMatchObject({ prNumber: 42, headSha: 'head1', door: 'check_suite', observeOnly: false });
  });

  it('shadow landing asks in observe-only mode and never reserves', async () => {
    await land({ mode: 'shadow', gitConfig: { surfaceOrdering: 'enforce' } as any });
    expect(mockCheckSurfaceOrder.mock.calls[0][0].observeOnly).toBe(true);
    expect(mockMergeInSurfaceSlot).not.toHaveBeenCalled();
  });

  it('a refused merge slot is a wait, not a merge', async () => {
    mockMergeInSurfaceSlot = mock(async () => ({ refused: 'PR #40 is merging on Drizzle migrations right now' }));
    const outcome = await land();
    expect(outcome.kind).toBe('waiting_ci');
    expect(mockMergePullRequest).not.toHaveBeenCalled();
    expect((landingEvents().at(-1) as any).detail).toMatchObject({ waitingOn: 'surface_slot' });
  });

  it('default: merges through the slot exactly as before', async () => {
    const outcome = await land();
    expect(outcome.kind).toBe('merged');
    expect(mockMergeInSurfaceSlot).toHaveBeenCalledTimes(1);
    expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
  });
});

// ── Post-refresh semantic hold (conflict-aware-orchestration.md §4) ─────────

describe('landPr — post-refresh semantic hold', () => {
  afterEach(() => { mockCheckBaseRefreshHold = mock(async (_i: any) => ({ blocks: false }) as any); });

  it('passes the workspace gitConfig through to the hold', async () => {
    const gitConfig = { semanticRefresh: 'enforce' } as any;
    await land({ gitConfig });
    expect(mockCheckBaseRefreshHold).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1', gitConfig }));
  });

  it('a re-check still in progress waits, and nothing merges', async () => {
    mockCheckBaseRefreshHold = mock(async () => ({ blocks: true, needsPerson: false, reason: 'semantic hold (rechecking): x' }) as any);
    const out = await land({ gitConfig: { semanticRefresh: 'enforce' } as any });
    expect(out.kind).toBe('waiting_ci');
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('an exhausted or same-symbol hold needs a person', async () => {
    mockCheckBaseRefreshHold = mock(async () => ({ blocks: true, needsPerson: true, reason: 'semantic hold (needs a person): y' }) as any);
    const out = await land({ gitConfig: { semanticRefresh: 'enforce' } as any });
    expect(out).toMatchObject({ kind: 'needs_human', cause: 'semantic_unverified' });
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });
});
