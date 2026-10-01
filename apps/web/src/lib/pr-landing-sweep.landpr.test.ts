import { beforeEach, describe, expect, it, mock } from 'bun:test';

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

import { landPr, type LandPrInput } from './pr-landing';
import { runLandingSweep, dueMember, type LandingSweepDeps, type LandingTarget, type PrRef } from './pr-landing-sweep';

// The sweep drives the REAL landing function here, against the same fake
// GitHub the landing tests use: what these cases pin is that the safety
// properties hold end to end, not just in the sweep's own bookkeeping.

const REF: PrRef = { workspaceId: 'ws-1', prNumber: 42 };
const target: LandingTarget = {
  workspaceId: 'ws-1',
  prNumber: 42,
  installationId: 7,
  repoFullName: 'buildd-ai/buildd',
  policyFor: () => ({ tier: 'auto-threshold', threshold: { maxLines: 800, denyPaths: [] } }),
  owner: { taskId: 'task-1', workerId: 'worker-1' },
  mission: null,
  releaseConfig: null,
};

let dueStore: Map<string, number>;
let afterPeek: (() => void) | null;
const landInputs: LandPrInput[] = [];

const deps = (): LandingSweepDeps => ({
  listFloor: async () => [REF],
  listDue: async () => [],
  resolveTarget: async () => ({ ok: true, target }),
  peek: async () => {
    const seen = { state: gh.merged ? ('merged' as const) : gh.state === 'open' ? ('open' as const) : ('closed' as const), draft: false, headSha: gh.head, baseRef: gh.baseRef };
    afterPeek?.();
    return seen;
  },
  readMarker: async () => (markerStore && markerStore.prNumber === 42 ? markerStore : null),
  land: async (input) => {
    landInputs.push(input);
    return landPr(input, { dispatchFix: mockDispatchFix, escalateConflictExhaustion: mockEscalate, findLiveReviewerRetry: mockLiveRetry });
  },
  markDue: async (m, at) => void dueStore.set(m, at),
  clearDue: async (ms) => void ms.forEach((m) => dueStore.delete(m)),
  reseedDue: async (entries) => {
    dueStore = new Map(entries.map((e) => [e.member, e.dueAtMs]));
  },
  sleep: async () => {},
  now: () => Date.now(),
});

const mockDispatchFix = mock(async (_i: any): Promise<{ taskId?: string } | null> => ({ taskId: 'fix-task-1' }));
const mockEscalate = mock(async (..._a: any[]) => {});
const mockLiveRetry = mock(async (..._a: any[]): Promise<string | null> => null);

beforeEach(() => {
  gh = freshGh();
  verdict = 'approved';
  reviewStatus = { state: 'approved', verdict: 'approve', confidence: 0.9, merged: false };
  markerStore = null;
  dueStore = new Map();
  afterPeek = null;
  landInputs.length = 0;
  mockFindFirst = mock(() => null as any);
  for (const m of [mockGithubApi, mockMergePullRequest, mockDispatchConflictRetry, mockFireGateEvent, mockWriteMarker, mockClearMarker, mockDispatchFix, mockEscalate, mockLiveRetry]) m.mockClear();
  mockMergePullRequest.mockImplementation(async () => {
    gh.merged = true;
    gh.state = 'closed';
    return { merged: true, message: 'merged' };
  });
  mockDispatchConflictRetry.mockImplementation(async () => ({ dispatched: false }));
});

describe('sweep over the real landing function', () => {
  it('merges an approved, green PR once, pinned to the head the sweep read', async () => {
    const res = await runLandingSweep({ source: 'floor' }, deps());
    expect(res.merged).toBe(1);
    expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
    expect(mockMergePullRequest.mock.calls[0]).toEqual([7, 'buildd-ai/buildd', 42, 'squash', 'head1']);
    expect(landInputs[0]).toMatchObject({ door: 'sweep', mode: 'enforce', eventHeadSha: 'head1' });
  });

  it('two consecutive runs make one merge call', async () => {
    const d = deps();
    await runLandingSweep({ source: 'floor' }, d);
    const second = await runLandingSweep({ source: 'floor' }, d);
    expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
    expect(second.skipped.merged).toBe(1);
    expect(landInputs).toHaveLength(1);
  });

  it('a head that moved between the sweep reading it and acting is skipped safely', async () => {
    afterPeek = () => {
      gh.head = 'head2';
    };
    const res = await runLandingSweep({ source: 'floor' }, deps());
    expect(mockMergePullRequest).not.toHaveBeenCalled();
    expect(mockDispatchConflictRetry).not.toHaveBeenCalled();
    expect(mockDispatchFix).not.toHaveBeenCalled();
    expect(res.headMoved).toBe(1);
    expect(res.waitingCi).toBe(1);
    // Still on the queue: the new head gets looked at again.
    expect(dueStore.has(dueMember(REF))).toBe(true);
  });

  it('the next run lands the new head, merging exactly once overall', async () => {
    afterPeek = () => {
      gh.head = 'head2';
    };
    const d = deps();
    await runLandingSweep({ source: 'floor' }, d);
    afterPeek = null;
    await runLandingSweep({ source: 'floor' }, d);
    expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
    expect(mockMergePullRequest.mock.calls[0][4]).toBe('head2');
  });

  it('a PR whose refresh is within its budget triggers no second refresh', async () => {
    gh.behindBy = 2;
    markerStore = {
      prNumber: 42,
      pendingHeadSha: 'head1',
      baseShaAtUpdate: 'base1',
      refreshCount: 1,
      firstApprovedGreenAt: new Date().toISOString(),
      lastOutcome: 'updating_branch',
      updatedAt: new Date().toISOString(),
    };
    const res = await runLandingSweep({ source: 'floor' }, deps());
    expect(landInputs).toHaveLength(0);
    expect(res.skipped.refresh_pending).toBe(1);
    expect(mockMergePullRequest).not.toHaveBeenCalled();
    expect(mockWriteMarker).not.toHaveBeenCalled();
  });
});
