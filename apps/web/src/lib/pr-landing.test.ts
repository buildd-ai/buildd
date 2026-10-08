import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// ── Mocks ──────────────────────────────────────────────────────────────────────
// A fake GitHub answers by path, so the real `evaluateAutoMergeSafety` runs its
// rails against it: a row that merges did so because every rail passed.

// Workflow kernel landing (lib/workflow/landing.ts; real-SQL cases in
// apps/web/tests/db/workflow-matrix.test.ts S10/S15/S20). Default: no kernel
// delivery, so every legacy merge case below runs unchanged.
const mockLandThroughKernel = mock(async (..._a: any[]): Promise<any> => null);
const mockKernelLandingView = mock(async (..._a: any[]): Promise<any> => null);
mock.module('@/lib/workflow/landing', () => ({
  landThroughKernel: mockLandThroughKernel,
  kernelLandingView: mockKernelLandingView,
  staleLandingVersion: async () => null,
}));
mock.module('@/lib/notify', () => ({ notifyTeamOf: async () => {} }));
mock.module('@/lib/pushover', () => ({ notifyOperator: mock(() => undefined) }));

type Gh = {
  state: string;
  merged: boolean;
  head: string;
  baseRef: string;
  mergeableState: string;
  checkRuns: Array<{ name: string; status: string; conclusion: string | null; completed_at?: string }>;
  behindBy: number;
  baseTip: string;
  prFiles: string[];
  baseMovement: { ahead_by: number; files: string[] };
  failPr?: boolean;
  failCompare?: boolean;
  headRef?: string;
  /** Other PRs a verdict may name: number → { state, merged }. */
  siblings?: Record<number, { state: string; merged: boolean }>;
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
  const sibling = /\/pulls\/(\d+)$/.exec(path);
  if (sibling && sibling[1] !== '42') {
    const s = gh.siblings?.[Number(sibling[1])];
    if (!s) throw new Error('not found');
    return { state: s.state, merged: s.merged };
  }
  if (/\/pulls\/42$/.test(path)) {
    if (gh.failPr) throw new Error('boom');
    return {
      state: gh.state,
      title: 'Add the thing',
      merged: gh.merged,
      merge_commit_sha: gh.merged ? 'merge-sha' : null,
      mergeable_state: gh.mergeableState,
      head: { sha: gh.head, ref: gh.headRef ?? 'buildd/task' },
      base: { ref: gh.baseRef },
    };
  }
  const base = encodeURIComponent(gh.baseRef);
  if (path.includes(`/compare/${base}...`)) {
    if (gh.failCompare) throw new Error('compare down');
    return { behind_by: gh.behindBy };
  }
  if (path.endsWith(`...${base}`)) {
    return {
      ahead_by: gh.baseMovement.ahead_by,
      files: gh.baseMovement.files.map((filename) => ({ filename })),
    };
  }
  if (path.endsWith(`/commits/${base}`)) return { sha: gh.baseTip };
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
  claimReviewRevalidation: async () => true,
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
  summarizeChecks,
  approvedGreenAt,
  latestCheckCompletion,
  TREADMILL_MAX_BASE_COMMITS,
  TREADMILL_MAX_REFRESHES,
  TREADMILL_EXHAUSTED_MAX_BASE_COMMITS,
  refreshCycleCount,
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
const mockReadApprovedAt = mock(async (..._a: any[]): Promise<number | null> => null);
// One fresh review per head and basis; tests flip it to model a second pass.
const claimed = new Set<string>();
const mockClaimRevalidation = mock(async (_taskId: string, key: string) => {
  if (claimed.has(key)) return false;
  claimed.add(key);
  return true;
});

const deps = (): LandPrDeps => ({
  dispatchFix: mockDispatchFix,
  escalateConflictExhaustion: mockEscalate,
  findLiveReviewerRetry: mockLiveRetry,
  readApprovedAt: mockReadApprovedAt,
  claimReviewRevalidation: mockClaimRevalidation,
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
    mockFireGateEvent, mockWriteMarker, mockClearMarker, mockDispatchFix, mockEscalate, mockLiveRetry, mockCarryForward, mockReadApprovedAt,
  ]) {
    m.mockClear();
  }
  mockMergePullRequest.mockImplementation(async () => ({ merged: true, message: 'merged' }));
  mockDispatchConflictRetry.mockImplementation(async () => ({ dispatched: false }));
  mockDispatchFix.mockImplementation(async () => ({ taskId: 'fix-task-1' }));
  mockLiveRetry.mockImplementation(async () => null);
  mockReadApprovedAt.mockImplementation(async () => null);
  mockClaimRevalidation.mockClear();
  claimed.clear();
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

// ── Kernel-owned PR (workflow-state-kernel.md §14 Slice C) ────────────────────

describe('landPr — kernel-owned PR (T15/T16)', () => {
  const k = (o: Record<string, unknown>) => ({ merged: false, reason: 'x', message: 'm', mergeCommitSha: null, current: { state: 'APPROVED', version: 3, head: 'head1', round: 1 }, result: null, ...o });
  const kernelDeps = (answer: Record<string, unknown>) => {
    const calls: any[] = [];
    return { calls, d: { ...deps(), landThroughKernel: async (i: any) => { calls.push(i); return k(answer) as any; } } };
  };

  it('every rail runs as before, then the kernel merges: no direct GitHub merge, no mission finalize here', async () => {
    const { calls, d } = kernelDeps({ merged: true, outcome: 'merged', mergeCommitSha: 'M1' });
    const out = await land({ door: 'merge_pr', mergeMethod: 'rebase', actor: { kind: 'agent', workerId: 'w-1' }, expectedVersion: 3 }, d);
    expect(out).toEqual({ kind: 'merged', sha: 'M1' });
    expect(mockMergePullRequest).not.toHaveBeenCalled();
    expect(calls).toEqual([expect.objectContaining({
      workspaceId: 'ws-1', installationId: 7, repoFullName: 'buildd-ai/buildd', prNumber: 42, headSha: 'head1',
      door: 'land_pr:merge_pr', actor: 'agent:w-1', mergeMethod: 'rebase', expectedVersion: 3,
    })]);
    expect(calls[0].override).toBeUndefined();
    expect(landingEvents()[0].detail.landingOutcome).toBe('merged');
  });

  it("a person's verdict override reaches the kernel as a recorded override", async () => {
    const { calls, d } = kernelDeps({ merged: true, outcome: 'merged' });
    await land({ door: 'dashboard', actor: { kind: 'human', userId: 'u-1', override: { verdict: true } } }, d);
    expect(calls[0]).toMatchObject({ actor: 'human:u-1', override: { reason: expect.any(String) } });
  });

  it('a refresh the kernel queued is updating_branch; a conflict is the kernel\'s fix; a refusal goes to a person; anything else waits', async () => {
    expect(await land({}, kernelDeps({ outcome: 'behind' }).d)).toEqual({ kind: 'updating_branch', newHeadSha: 'head1' });
    expect(await land({}, kernelDeps({ outcome: 'conflict', message: 'conflict' }).d)).toMatchObject({ kind: 'needs_fix', fix: 'conflict' });
    expect(await land({}, kernelDeps({ outcome: 'refused', message: 'Required status check' }).d)).toMatchObject({ kind: 'needs_human', cause: 'merge_failed', reason: 'Required status check' });
    for (const outcome of ['landing', 'stale', 'rejected', 'not_merged']) {
      expect(await land({}, kernelDeps({ outcome }).d)).toMatchObject({ kind: 'waiting_ci', headSha: 'head1' });
    }
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  // Task 57e1d5b8 (incident #2574): on a kernel PR the legacy reviewer-row gate does not
  // decide. A composition- or human-approved delivery has no reviewer row at all.
  describe('the review gate is the delivery, not the legacy reviewer row', () => {
    const view = (state: string, head = 'head1') => async () => ({ deliveryId: 'd1', current: { state, version: 3, head, round: 1 } });

    it('an APPROVED delivery lands through T15 even when the legacy row blocks or is missing', async () => {
      verdict = 'changes_requested';
      reviewStatus = null;
      const { calls, d } = kernelDeps({ merged: true, outcome: 'merged', mergeCommitSha: 'M1' });
      const out = await land({ policy: agentReview }, { ...d, kernelLandingView: view('APPROVED') });
      expect(out).toEqual({ kind: 'merged', sha: 'M1' });
      expect(mockGuardReviewVerdict).not.toHaveBeenCalled();
      expect(mockReadPrReviewStatus).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
      expect(mockDispatchFix).not.toHaveBeenCalled();
    });

    it.each(['AWAITING_REVIEW', 'CHANGES_REQUESTED', 'ESCALATED', 'FIXING', 'LANDING'])('a delivery in %s waits for the kernel: no merge call, no re-review, no refresh', async (state) => {
      verdict = 'approved';
      const { calls, d } = kernelDeps({ merged: true, outcome: 'merged' });
      const out = await land({ policy: agentReview }, { ...d, kernelLandingView: view(state) });
      expect(out).toMatchObject({ kind: 'waiting_ci', headSha: 'head1' });
      expect(calls).toHaveLength(0);
      expect(mockGuardReviewVerdict).not.toHaveBeenCalled();
      expect(mockDispatchFix).not.toHaveBeenCalled();
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('a head the kernel has not observed yet waits', async () => {
      const { calls, d } = kernelDeps({ merged: true, outcome: 'merged' });
      const out = await land({}, { ...d, kernelLandingView: view('APPROVED', 'older') });
      expect(out).toMatchObject({ kind: 'waiting_ci' });
      expect(calls).toHaveLength(0);
    });

    it("a person's verdict override from a review state still reaches T15, which records it", async () => {
      const { calls, d } = kernelDeps({ merged: true, outcome: 'merged' });
      const out = await land({ door: 'dashboard', actor: { kind: 'human', userId: 'u-1', override: { verdict: true } } }, { ...d, kernelLandingView: view('ESCALATED') });
      expect(out).toMatchObject({ kind: 'merged' });
      expect(calls[0]).toMatchObject({ override: { reason: expect.any(String) } });
      expect(mockGuardReviewVerdict).not.toHaveBeenCalled();
    });

    it('a PR with no kernel delivery still runs the legacy review gate', async () => {
      verdict = 'changes_requested';
      const out = await land({}, { ...deps(), kernelLandingView: async () => null, landThroughKernel: async () => null });
      expect(mockGuardReviewVerdict).toHaveBeenCalledTimes(1);
      expect(out.kind).not.toBe('merged');
    });
  });

  it('a PR the kernel does not own merges directly, as before', async () => {
    const out = await land({}, { ...deps(), landThroughKernel: async () => null });
    expect(out).toEqual({ kind: 'merged', sha: 'head1' });
    expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
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

describe('landPr — time to land clock', () => {
  const at = (iso: string) => Date.parse(iso);

  it('starts at the later of approval and the last check finishing when there is no marker', async () => {
    mockReadApprovedAt.mockImplementation(async () => at('2030-01-01T00:30:00.000Z'));
    gh.checkRuns = [
      { name: 'build', status: 'completed', conclusion: 'success', completed_at: '2030-01-01T00:20:00.000Z' },
      { name: 'lint', status: 'completed', conclusion: 'success', completed_at: '2030-01-01T00:45:00.000Z' },
    ];
    await land();
    const [event] = landingEvents();
    expect(event.detail.timeToLandMs).toBe(15 * 60 * 1000);
    expect(event.detail.timeToLandUnmeasured).toBeUndefined();
    expect(event.detail.approvedGreenAt).toBe('2030-01-01T00:45:00.000Z');
  });

  it('measures from whichever half is known', async () => {
    mockReadApprovedAt.mockImplementation(async () => at('2030-01-01T00:30:00.000Z'));
    await land();
    expect(landingEvents()[0].detail.timeToLandMs).toBe(30 * 60 * 1000);
  });

  it('takes the earlier of the marker clock and the derived clock', async () => {
    markerStore = marker({ firstApprovedGreenAt: '2030-01-01T00:10:00.000Z' });
    mockReadApprovedAt.mockImplementation(async () => at('2030-01-01T00:40:00.000Z'));
    await land();
    expect(landingEvents()[0].detail.timeToLandMs).toBe(50 * 60 * 1000);
  });

  it('marks the landing unmeasured, not zero, when no start can be derived', async () => {
    await land();
    const [event] = landingEvents();
    expect(event.outcome).toBe('accepted');
    expect(event.detail.timeToLandMs).toBeUndefined();
    expect(event.detail.timeToLandUnmeasured).toBe(true);
  });

  it('survives a failing approval read as unknown', async () => {
    mockReadApprovedAt.mockImplementation(async () => { throw new Error('db down'); });
    const out = await land();
    expect(out.kind).toBe('merged');
    expect(landingEvents()[0].detail.timeToLandUnmeasured).toBe(true);
  });

  it('stamps approvedGreenAt on a non-merged row once approved and green, so a stuck PR is countable', async () => {
    mockReadApprovedAt.mockImplementation(async () => at('2030-01-01T00:30:00.000Z'));
    gh.behindBy = 3;
    gh.baseMovement = { ahead_by: 3, files: ['apps/web/src/other.ts'] };
    await land();
    const [event] = landingEvents();
    expect(event.detail.landingOutcome).not.toBe('merged');
    expect(event.detail.approvedGreenAt).toBe('2030-01-01T00:30:00.000Z');
  });

  it('does not stamp approvedGreenAt on a PR that is not green', async () => {
    mockReadApprovedAt.mockImplementation(async () => at('2030-01-01T00:30:00.000Z'));
    gh.checkRuns = [{ name: 'build', status: 'completed', conclusion: 'failure' }];
    await land();
    expect(landingEvents()[0].detail.approvedGreenAt).toBeUndefined();
  });
});

describe('approvedGreenAt / latestCheckCompletion', () => {
  it('takes the later of two known times, the known one of one, null of none', () => {
    expect(approvedGreenAt(10, 20)).toBe(20);
    expect(approvedGreenAt(30, 20)).toBe(30);
    expect(approvedGreenAt(10, null)).toBe(10);
    expect(approvedGreenAt(null, 20)).toBe(20);
    expect(approvedGreenAt(null, null)).toBeNull();
  });

  it('reads the newest completed_at and tolerates missing or junk values', () => {
    expect(latestCheckCompletion(undefined)).toBeNull();
    expect(latestCheckCompletion([])).toBeNull();
    expect(
      latestCheckCompletion([
        { name: 'a', status: 'completed', conclusion: 'success', completed_at: '2030-01-01T00:00:00.000Z' },
        { name: 'b', status: 'completed', conclusion: 'success', completed_at: 'junk' },
        { name: 'c', status: 'completed', conclusion: 'success' },
      ] as any),
    ).toBe(Date.parse('2030-01-01T00:00:00.000Z'));
  });
});

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

  it('a stale approval with no dispatchFix wired sends a reviewer through the shared re-review dispatcher', async () => {
    verdict = 'stale';
    const reReview = mock(async (_i: any) => ({ outcome: 'dispatched', reviewTaskId: 'review-new', plan: 'delta' }) as any);
    const out = await land({ policy: agentReview }, { ...deps(), dispatchFix: undefined, dispatchStaleApprovalReReview: reReview });
    expect(out).toMatchObject({ kind: 'needs_fix', fix: 're_review', taskId: 'review-new' });
    expect(reReview).toHaveBeenCalledTimes(1);
    expect(reReview.mock.calls[0]![0]).toMatchObject({
      workspaceId: 'ws-1', installationId: 7, repoFullName: 'buildd-ai/buildd', prNumber: 42,
      headSha: 'head1', baseRef: 'dev', taskId: 'task-1', workerId: 'worker-1', policy: agentReview,
    });
    expect(landingEvents()[0].detail.fixDispatched).toBe(true);
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('a reviewer already on the PR is named, not stacked', async () => {
    verdict = 'stale';
    const reReview = mock(async (_i: any) => ({ outcome: 'already_reviewing', reviewTaskId: 'review-live' }) as any);
    const out = await land({}, { ...deps(), dispatchFix: undefined, dispatchStaleApprovalReReview: reReview });
    expect(out).toMatchObject({ kind: 'needs_fix', fix: 're_review', taskId: 'review-live' });
  });

  it('a stale approval the dispatcher could not act on still names the gap instead of going silent', async () => {
    verdict = 'stale';
    const reReview = mock(async (_i: any) => ({ outcome: 'skipped', reason: 'no reviewer role in this workspace' }) as any);
    const out = await land({}, { ...deps(), dispatchFix: undefined, dispatchStaleApprovalReReview: reReview });
    expect(out).toMatchObject({ kind: 'needs_fix', fix: 're_review' });
    expect((out as any).taskId).toBeUndefined();
    expect(landingEvents()[0].detail).toMatchObject({ fixDispatched: false, fixSkipped: 'no reviewer role in this workspace' });
  });

  it('shadow never sends a reviewer', async () => {
    verdict = 'stale';
    const reReview = mock(async (_i: any) => ({ outcome: 'dispatched', reviewTaskId: 'review-new', plan: 'delta' }) as any);
    await land({ mode: 'shadow' }, { ...deps(), dispatchFix: undefined, dispatchStaleApprovalReReview: reReview });
    expect(reReview).not.toHaveBeenCalled();
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

// ── Stale blocking verdicts ────────────────────────────────────────────────────

describe('landPr — a blocking verdict is revalidated before it can strand a PR', () => {
  const escalatedAt = (reviewHeadSha: string | null, escalationReason: string, kind: 'escalated' | 'changes_requested' = 'escalated') => {
    mockGuardReviewVerdict.mockImplementationOnce(async () => ({
      blocks: true, kind, state: kind, reviewTaskId: 'review-3', reviewHeadSha,
      reason: kind === 'escalated' ? 'the reviewer escalated this PR to a human' : 'changes requested', clearedBy: 'a human decides',
    }));
    reviewStatus = {
      state: kind, verdict: kind === 'escalated' ? 'escalate' : 'request-changes', confidence: 0.9, merged: false,
      reviewHeadSha, reviewEquivalentHeadShas: [], escalationReason, feedback: null, summary: null,
    };
  };

  // Replay of PR #3571: escalated over a migration-number collision; the author
  // then pushed a regenerated, non-colliding migration and the old verdict stayed attached.
  it('replay #3571: an escalation given on an earlier head gets a fresh review of the live head, never a merge', async () => {
    escalatedAt('head0', 'migration number collision: 0240_a.sql collides with an open PR\'s 0240_b.sql');
    const out = await land();
    expect(out).toMatchObject({ kind: 'needs_fix', fix: 're_review', taskId: 'fix-task-1' });
    expect((out as any).reason).toContain('given on head0 and the head is now head1');
    expect((out as any).reason).toContain('Next: a fresh review of head1 was requested');
    expect(mockDispatchFix.mock.calls[0]![0]).toMatchObject({ kind: 're_review', headSha: 'head1', prNumber: 42 });
    expect(mockClaimRevalidation).toHaveBeenCalledWith('task-1', 'head1:head_moved');
    expect(mockMergePullRequest).not.toHaveBeenCalled();
    expect(landingEvents()[0].detail).toMatchObject({ staleVerdict: 'head_moved', fixDispatched: true });
  });

  // Replay of PR #3502: escalated because PR #3499 was open and colliding; #3499 has since merged.
  it('replay #3502: an escalation on the live head citing a sibling PR that has since merged gets a fresh review', async () => {
    escalatedAt('head1', 'Migration collides with open PR #3499 (0239_x.sql); one of them must renumber.');
    gh.siblings = { 3499: { state: 'closed', merged: true } };
    const out = await land();
    expect(out).toMatchObject({ kind: 'needs_fix', fix: 're_review', taskId: 'fix-task-1' });
    expect((out as any).reason).toContain('PR #3499 is now merged');
    expect(mockClaimRevalidation).toHaveBeenCalledWith('task-1', 'head1:external_state');
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('the same escalation while the sibling PR is still open stands: a person decides, no review is sent', async () => {
    escalatedAt('head1', 'Migration collides with open PR #3499 (0239_x.sql); one of them must renumber.');
    gh.siblings = { 3499: { state: 'open', merged: false } };
    const out = await land();
    expect(out).toMatchObject({ kind: 'needs_human', cause: 'blocking_verdict' });
    expect((out as any).reason).toContain('Next:');
    expect(mockDispatchFix).not.toHaveBeenCalled();
  });

  it('an unreadable sibling PR is not proof the verdict is stale', async () => {
    escalatedAt('head1', 'conflicts with PR #3499');
    gh.siblings = {};
    expect(await land()).toMatchObject({ kind: 'needs_human', cause: 'blocking_verdict' });
    expect(mockDispatchFix).not.toHaveBeenCalled();
  });

  it('a genuine finding on the live head with nothing mutable in it stays a human decision', async () => {
    escalatedAt('head1', 'The new endpoint skips the workspace ownership check before reading secrets.');
    const out = await land();
    expect(out).toMatchObject({ kind: 'needs_human', cause: 'blocking_verdict' });
    expect(mockDispatchFix).not.toHaveBeenCalled();
    expect(mockClaimRevalidation).not.toHaveBeenCalled();
  });

  it('a verdict that blocks again after its one fresh review goes to a person, not round again', async () => {
    escalatedAt('head1', 'Migration collides with open PR #3499.');
    gh.siblings = { 3499: { state: 'closed', merged: true } };
    await land();
    escalatedAt('head1', 'Migration collides with open PR #3499.');
    const second = await land();
    expect(second).toMatchObject({ kind: 'needs_human', cause: 'blocking_verdict' });
    expect((second as any).reason).toContain('fresh review was already requested');
    expect(mockDispatchFix).toHaveBeenCalledTimes(1);
  });

  it('a request-changes on an earlier head with no retry alive also gets a fresh review', async () => {
    escalatedAt('head0', 'Add a test for the empty case.', 'changes_requested');
    expect(await land()).toMatchObject({ kind: 'needs_fix', fix: 're_review', taskId: 'fix-task-1' });
  });

  it('red CI still wins over a stale verdict: no review, a CI fix', async () => {
    // The verdict gate is never reached, so it is driven by `verdict`, not a queued mock.
    verdict = 'escalated';
    reviewStatus = { state: 'escalated', verdict: 'escalate', merged: false, reviewHeadSha: 'head0', escalationReason: 'migration number collision' };
    gh.checkRuns = [{ name: 'build', status: 'completed', conclusion: 'failure' }];
    expect(await land()).toMatchObject({ kind: 'needs_fix', fix: 'ci_fix' });
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('shadow observes the stale verdict without claiming or dispatching', async () => {
    escalatedAt('head0', 'migration number collision');
    const out = await land({ mode: 'shadow' });
    expect(out).toMatchObject({ kind: 'needs_fix', fix: 're_review' });
    expect(mockDispatchFix).not.toHaveBeenCalled();
    expect(mockClaimRevalidation).not.toHaveBeenCalled();
  });
});

describe('refreshCycleCount', () => {
  const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
  it('counts the refreshes of the cycle that produced this head', () => {
    expect(refreshCycleCount(marker({ refreshCount: 2, updatedAt: at(1) }) as any, 'head1', NOW)).toBe(2);
  });
  it('is zero with no marker or for a head the platform did not produce', () => {
    expect(refreshCycleCount(null, 'head1', NOW)).toBe(0);
    expect(refreshCycleCount(marker({ pendingHeadSha: 'other', refreshCount: 3 }) as any, 'head1', NOW)).toBe(0);
  });
  it('a spent cycle stays spent until it cools down, then resets', () => {
    expect(refreshCycleCount(marker({ refreshCount: TREADMILL_MAX_REFRESHES, updatedAt: at(59) }) as any, 'head1', NOW)).toBe(TREADMILL_MAX_REFRESHES);
    expect(refreshCycleCount(marker({ refreshCount: TREADMILL_MAX_REFRESHES, updatedAt: at(60) }) as any, 'head1', NOW)).toBe(0);
    // An unstamped spent marker cannot prove it cooled down.
    expect(refreshCycleCount(marker({ refreshCount: TREADMILL_MAX_REFRESHES }) as any, 'head1', NOW)).toBe(TREADMILL_MAX_REFRESHES);
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

  describe('mission-branch strategy and the size cap', () => {
    // The tier applies once, at the mission-to-trunk PR. A task PR into its own
    // mission's integration branch skips the cap here too, or switching the
    // landing function to enforce would put the cap straight back.
    const MISSION_BRANCH = 'mission/example-slug-0a1b2c3d';
    const mission = { workingBranch: MISSION_BRANCH, integrationBranchEnabled: true };
    const tinyCap: MergePolicy = { tier: 'auto-threshold', threshold: { maxLines: 3, denyPaths: [] } };

    it("lands an oversize task PR into its own mission's integration branch", async () => {
      gh.baseRef = MISSION_BRANCH;
      const out = await land({ policy: tinyCap, mission });
      expect(out).toMatchObject({ kind: 'merged' });
      expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
    });

    it("holds an oversize PR into another mission's integration branch", async () => {
      gh.baseRef = 'mission/other-slug-4e5f6a7b';
      const out = await land({ policy: tinyCap, mission });
      expect(out).toMatchObject({ kind: 'needs_human', cause: 'size_cap' });
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });

    it('holds an oversize task PR into trunk even when its task has a mission', async () => {
      const out = await land({ policy: tinyCap, mission });
      expect(out).toMatchObject({ kind: 'needs_human', cause: 'size_cap' });
    });

    it('holds an oversize mission-to-trunk PR', async () => {
      gh.headRef = MISSION_BRANCH;
      const out = await land({ policy: tinyCap, mission });
      expect(out).toMatchObject({ kind: 'needs_human', cause: 'size_cap' });
      expect(mockMergePullRequest).not.toHaveBeenCalled();
    });
  });

  it('a conflicting PR dispatches the conflict agent (not update-branch)', async () => {
    gh.mergeableState = 'dirty';
    mockDispatchConflictRetry.mockImplementation(async () => ({ dispatched: true, taskId: 'conflict-task-1' }));
    const out = await land();
    expect(out).toMatchObject({ kind: 'needs_fix', fix: 'conflict', taskId: 'conflict-task-1' });
    expect(mockDispatchConflictRetry.mock.calls[0]![0].behindOnly).toBeFalsy();
  });

  it('a stale dirty flag that merged cleanly is a branch update, not a conflict fix', async () => {
    gh.mergeableState = 'dirty';
    mockDispatchConflictRetry.mockImplementation(async () => ({ dispatched: true, branchUpdated: true, conflictFalsePositive: true }));
    const out = await land();
    expect(out).toMatchObject({ kind: 'updating_branch' });
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

// ── Convergence holes seen live (PR shapes, not hypotheticals) ─────────────────

describe('landPr — a ready PR is never stranded waiting on a person who is not needed', () => {
  // The sweep wires no dispatchFix: what it gets is landPr's own default.
  const sweepDeps = (send: LandPrDeps['dispatchStaleApprovalReReview']): LandPrDeps => {
    const { dispatchFix: _omit, ...rest } = deps();
    return { ...rest, dispatchStaleApprovalReReview: send };
  };

  it('#3654 shape: green, mergeable, never reviewed — the workspace reviewer is requested, once', async () => {
    verdict = 'none';
    reviewStatus = { state: 'not_requested', verdict: null, confidence: null, merged: false };
    const send = mock(async (_i: any): Promise<any> => ({ outcome: 'dispatched', reviewTaskId: 'review-new', plan: 'full' }));
    const out = await land({ policy: agentReview, door: 'sweep', eventHeadSha: 'head1' }, sweepDeps(send));
    expect(out).toMatchObject({ kind: 'needs_fix', fix: 're_review', taskId: 'review-new' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ prNumber: 42, headSha: 'head1', firstReview: true, policy: agentReview });
    expect(mockMergePullRequest).not.toHaveBeenCalled();

    // The next sweep sees the queued reviewer and waits — no second request.
    verdict = 'in_flight';
    reviewStatus = { state: 'queued', verdict: null, confidence: null, merged: false };
    const again = await land({ policy: agentReview, door: 'sweep' }, sweepDeps(send));
    expect(again.kind).toBe('waiting_ci');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a never-reviewed PR with red CI is not sent to review', async () => {
    verdict = 'none';
    reviewStatus = { state: 'not_requested', verdict: null, confidence: null, merged: false };
    gh.checkRuns = [{ name: 'build', status: 'completed', conclusion: 'failure' }];
    const send = mock(async (_i: any): Promise<any> => ({ outcome: 'dispatched', reviewTaskId: 'r', plan: 'full' }));
    const out = await land({ policy: agentReview, door: 'sweep' }, sweepDeps(send));
    expect(out).toMatchObject({ kind: 'needs_fix', fix: 'ci_fix' });
    expect(send).not.toHaveBeenCalled();
  });

  it('#3502 shape: escalated earlier, CI green, now DIRTY — one conflict repair keyed to the live base', async () => {
    verdict = 'escalated';
    reviewStatus = { state: 'escalated', verdict: 'escalate', confidence: 0.5, merged: false };
    gh.mergeableState = 'dirty';
    gh.baseTip = 'base-now';
    mockDispatchConflictRetry.mockImplementation(async () => ({ dispatched: true, taskId: 'conflict-task-9' }));
    const out = await land({ policy: agentReview, door: 'sweep' });
    expect(out).toMatchObject({ kind: 'needs_fix', fix: 'conflict', taskId: 'conflict-task-9' });
    expect(mockDispatchConflictRetry).toHaveBeenCalledTimes(1);
    expect(mockDispatchConflictRetry.mock.calls[0]![0]).toMatchObject({ prNumber: 42, headSha: 'head1', baseSha: 'base-now' });
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('#3673 shape: approved, DIRTY and red — the conflict is repaired first, and it never merges', async () => {
    gh.mergeableState = 'dirty';
    gh.checkRuns = [{ name: 'Visual QA', status: 'completed', conclusion: 'failure' }];
    mockDispatchConflictRetry.mockImplementation(async () => ({ dispatched: true, taskId: 'conflict-task-3' }));
    const out = await land({ policy: agentReview, door: 'sweep' });
    expect(out).toMatchObject({ kind: 'needs_fix', fix: 'conflict', taskId: 'conflict-task-3' });
    expect(mockDispatchFix).not.toHaveBeenCalled();
    expect(mockMergePullRequest).not.toHaveBeenCalled();
    expect(landingEvents().at(-1)!.detail).toMatchObject({ alsoRefused: 'ci' });
  });

  it('a dirty PR on a deny path gets its repair, and the deny path still blocks the merge', async () => {
    gh.mergeableState = 'dirty';
    gh.prFiles = ['secrets/key.ts'];
    const policy: MergePolicy = { tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: ['secrets/'] } };
    mockDispatchConflictRetry.mockImplementation(async () => ({ dispatched: true, taskId: 'c' }));
    expect(await land({ policy })).toMatchObject({ kind: 'needs_fix', fix: 'conflict' });
    gh.mergeableState = 'clean';
    expect(await land({ policy })).toMatchObject({ kind: 'needs_human', cause: 'deny_path' });
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('a repair already in flight is reported as the owner, not filed twice', async () => {
    gh.mergeableState = 'dirty';
    mockDispatchConflictRetry.mockImplementation(async () => ({ dispatched: false, inFlightTaskId: 'live-fix' }));
    expect(await land()).toMatchObject({ kind: 'needs_fix', fix: 'conflict', taskId: 'live-fix' });
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

  // Replay of PR #3582: approved, CI green, mergeable, and parked for good as
  // needs_human(refresh_exhausted) after the base moved three times. A busy base
  // in unrelated files is not a reason a clean PR cannot land.
  it('replay #3582: a spent cycle on a busy base in unrelated files lands the refreshed head', async () => {
    markerStore = marker({ pendingHeadSha: 'head1', refreshCount: TREADMILL_MAX_REFRESHES, updatedAt: new Date(NOW - 5 * 60_000).toISOString() });
    gh.baseMovement = { ahead_by: TREADMILL_MAX_BASE_COMMITS + 4, files: ['packages/other/x.ts', 'docs/y.md'] };
    const out = await land();
    expect(out).toEqual({ kind: 'merged', sha: 'head1' });
    expect(mockDispatchConflictRetry).not.toHaveBeenCalled();
    const merged = landingEvents().find((e: any) => e.detail.landingOutcome === 'merged');
    expect(merged.detail).toMatchObject({ freshnessRule: 'spent_cycle', timeToLandMs: 20 * 60_000 });
  });

  it('a spent cycle where the base keeps changing the same files is refresh_unsafe, says what happens next, and pushes nothing', async () => {
    markerStore = marker({ pendingHeadSha: 'head1', refreshCount: TREADMILL_MAX_REFRESHES, updatedAt: new Date(NOW - 5 * 60_000).toISOString() });
    gh.baseMovement = { ahead_by: 2, files: ['apps/web/src/a.ts'] };
    const out = await land();
    expect(out).toMatchObject({ kind: 'needs_human', cause: 'refresh_unsafe' });
    expect((out as any).reason).toContain('Next: landing starts a new refresh cycle');
    expect(mockDispatchConflictRetry).not.toHaveBeenCalled();
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('a spent cycle on a migration-touching base is unsafe, not merely busy', async () => {
    markerStore = marker({ pendingHeadSha: 'head1', refreshCount: TREADMILL_MAX_REFRESHES, updatedAt: new Date(NOW).toISOString() });
    gh.baseMovement = { ahead_by: 1, files: ['packages/core/drizzle/0241_x.sql'] };
    expect(await land()).toMatchObject({ kind: 'needs_human', cause: 'refresh_unsafe' });
  });

  it('a spent cycle whose gap is past the wider bound is refresh_exhausted with a next step, and pushes nothing', async () => {
    markerStore = marker({ pendingHeadSha: 'head1', refreshCount: TREADMILL_MAX_REFRESHES, updatedAt: new Date(NOW).toISOString() });
    gh.baseMovement = { ahead_by: TREADMILL_EXHAUSTED_MAX_BASE_COMMITS + 1, files: ['x/o.ts'] };
    const out = await land();
    expect(out).toMatchObject({ kind: 'needs_human', cause: 'refresh_exhausted' });
    expect((out as any).reason).toContain('Next:');
    expect(mockDispatchConflictRetry).not.toHaveBeenCalled();
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('a spent cycle that has cooled down starts a new one: refreshes again, CAS against the stored count', async () => {
    markerStore = marker({ pendingHeadSha: 'head1', refreshCount: TREADMILL_MAX_REFRESHES, updatedAt: new Date(NOW - 61 * 60_000).toISOString() });
    gh.baseMovement = { ahead_by: TREADMILL_EXHAUSTED_MAX_BASE_COMMITS + 1, files: ['x/o.ts'] };
    const out = await land();
    expect(out).toEqual({ kind: 'updating_branch', newHeadSha: 'head2' });
    expect(mockWriteMarker.mock.calls[0]![2]).toBe(TREADMILL_MAX_REFRESHES);
    expect(markerStore).toMatchObject({ refreshCount: 1, pendingHeadSha: 'head2', firstApprovedGreenAt: '2030-01-01T00:40:00.000Z' });
  });

  it('a push nobody in landing made starts a new cycle even after a spent one', async () => {
    markerStore = marker({ pendingHeadSha: 'refreshed-earlier', refreshCount: TREADMILL_MAX_REFRESHES, updatedAt: new Date(NOW).toISOString() });
    gh.baseMovement = { ahead_by: 1, files: ['x/o.ts'] };
    expect(await land()).toEqual({ kind: 'updating_branch', newHeadSha: 'head2' });
    expect(markerStore.refreshCount).toBe(1);
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
  it('"head branch is out of date" (strict branch protection) is a behind-base refresh, not merge_failed', async () => {
    mockMergePullRequest.mockImplementation(async () => ({ merged: false, message: 'Head branch is out of date. Update the branch first.' }));
    mockDispatchConflictRetry.mockImplementation(async () => {
      gh.head = 'head2';
      return { dispatched: true, branchUpdated: true };
    });
    expect(await land()).toEqual({ kind: 'updating_branch', newHeadSha: 'head2' });
  });

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

describe('summarizeChecks', () => {
  const run = (status: string, conclusion: string | null) => ({ name: 'c', status, conclusion });
  it('is red on any failure, pending on anything unfinished, green only when every run passed', () => {
    expect(summarizeChecks(undefined)).toBeNull();
    expect(summarizeChecks([])).toBeNull();
    expect(summarizeChecks([run('completed', 'success'), run('in_progress', null)])).toBe('pending');
    expect(summarizeChecks([run('completed', 'failure'), run('in_progress', null)])).toBe('red');
    expect(summarizeChecks([run('completed', 'success'), run('completed', 'skipped')])).toBe('green');
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

  it('hands the live check state and the outcome reason, so a page never claims green on a running head', async () => {
    gh.checkRuns = [{ name: 'build', status: 'in_progress', conclusion: null }];
    const out = await land({}, { ...deps(), alert: alertMock });
    expect(out.kind).toBe('waiting_ci');
    const sent = alertMock.mock.calls[0]![0];
    expect(sent.checks).toBe('pending');
    expect(typeof sent.outcomeReason).toBe('string');
    expect(sent.outcomeReason.length).toBeGreaterThan(0);
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
