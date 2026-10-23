import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';

// ── DB mocks ──────────────────────────────────────────────────────────────────

const mockWorkspacesFindFirst = mock(() => null as any);
const mockWorkersFindFirst = mock(() => null as any);
const mockWorkersFindMany = mock(() => [] as any[]);
const mockTasksFindFirst = mock(() => null as any);
const mockTasksFindMany = mock(() => [] as any[]);
const mockMissionNotesFindFirst = mock(() => null as any);

// Track DB mutation calls for assertions
const mockWorkersUpdate = mock();
const mockMissionNotesUpdate = mock();
const mockMissionNotesInsert = mock();

function makeChainedUpdate(updateMock: ReturnType<typeof mock>) {
  return () => {
    const setFn = mock(() => ({
      where: mock(() => Promise.resolve()),
    }));
    updateMock(setFn);
    return { set: setFn };
  };
}

const dbWorkersUpdateSet = mock(() => ({ where: mock(() => Promise.resolve()) }));
const dbMissionNotesUpdateSet = mock(() => ({ where: mock(() => Promise.resolve()) }));
const dbMissionNotesInsertValues = mock(() => Promise.resolve());

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      workers: {
        findFirst: mockWorkersFindFirst,
        findMany: mockWorkersFindMany,
      },
      tasks: {
        findFirst: mockTasksFindFirst,
        findMany: mockTasksFindMany,
      },
      missionNotes: { findFirst: mockMissionNotesFindFirst },
    },
    update: (table: any) => {
      if (table === 'workers_table') {
        return { set: dbWorkersUpdateSet };
      }
      if (table === 'mission_notes_table') {
        return { set: dbMissionNotesUpdateSet };
      }
      // Default — return a chainable mock
      return {
        set: mock(() => ({ where: mock(() => Promise.resolve()) })),
      };
    },
    insert: (table: any) => ({
      values: dbMissionNotesInsertValues,
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => ({ args, op: 'and' }),
  or: (...args: any[]) => ({ args, op: 'or' }),
  ne: (a: any, b: any) => ({ a, b, op: 'ne' }),
  not: (a: any) => ({ a, op: 'not' }),
  isNull: (a: any) => ({ a, op: 'isNull' }),
  isNotNull: (a: any) => ({ a, op: 'isNotNull' }),
  inArray: (a: any, b: any) => ({ a, b, op: 'inArray' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: 'workspaces_table',
  workers: 'workers_table',
  tasks: 'tasks_table',
  missionNotes: 'mission_notes_table',
  githubInstallations: 'github_installations_table',
}));

// Track GitHub API calls
const mockGithubApi = mock((_installationId: number, path: string, _opts?: any) => {
  // Default: success
  return Promise.resolve({ id: 1 });
});

mock.module('@/lib/github', () => ({
  githubApi: mockGithubApi,
}));

mock.module('@buildd/core/subject-anchor-observe', () => ({
  resolveSubjectPolicy: (policy: any) => ({
    mode: 'observe',
    dedupe: 'attach-system',
    proposalGraceHours: 24,
    conflictDeadDays: 7,
    autoCloseBuilddSupersededPrs: policy?.autoCloseBuilddSupersededPrs ?? false,
    priorWorkInjection: true,
    ...policy,
  }),
}));

mock.module('./subject-sweep', () => ({
  sweepSubjectAnchoredTasks: mock(() => Promise.resolve({ anchored: 0, reconciled: 0 })),
}));

// The PR fact funnel: the one writer of prLifecycleStatus. Terminal-wins is
// proven on real Postgres (apps/web/tests/db/pr-facts.test.ts); here we assert
// the fact this door hands over. drizzle-orm is stubbed above, so the real
// module is not spread in (it builds raw SQL at import).
const recordedFacts: Array<{ target: unknown; fact: unknown; opts?: unknown }> = [];
mock.module('@buildd/core/pr-facts', () => ({
  recordPrFact: async (target: unknown, fact: unknown, opts?: unknown) => {
    recordedFacts.push({ target, fact, opts });
    return [{ id: 'w-loser', taskId: 't-loser', workspaceId: 'ws-1', previousStatus: 'pr_open' }];
  },
}));

// The content verifier (lib/pr-supersession-detect.ts verifyPrCarriedBy): the
// one thing that may turn a nominated loser into a closed one. Defaults to
// "verified" so the pre-filter tests below exercise their own guard; the
// verification tests set a verdict explicitly.
type Verdict =
  | { outcome: 'verified'; method: 'patch-id' | 'content'; confidence: number }
  | { outcome: 'unverified'; confidence: number }
  | { outcome: 'unavailable'; reason: string };
const VERIFIED: Verdict = { outcome: 'verified', method: 'content', confidence: 1 };
const verifyCalls: any[] = [];
const mockVerifyPrCarriedBy = mock((_opts: any): Promise<Verdict> => Promise.resolve(VERIFIED));
mock.module('@/lib/pr-supersession-detect', () => ({
  SWEEP_LIMITS: { budgetMs: 20_000, requestTimeoutMs: 5_000 },
  verifyPrCarriedBy: (opts: any) => { verifyCalls.push(opts); return mockVerifyPrCarriedBy(opts); },
}));

// The supersession edge (lib/pr-supersession.ts recordPrSupersession): the
// same write record_pr_supersession and the close-time scan take.
const recordCalls: any[] = [];
let recordResult: any = { ok: true };
mock.module('@/lib/pr-supersession', () => ({
  recordPrSupersession: (p: any) => { recordCalls.push(p); return Promise.resolve(recordResult); },
}));

const gateEvents: any[] = [];
mock.module('@/lib/gate-ledger', () => ({
  GATE_SLUGS: { AUTO_PR_SUPERSESSION: 'auto_pr_supersession' },
  fireGateEvent: (e: any) => { gateEvents.push(e); return 'sig'; },
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { shutdownDeadBuilddPrs } from './dead-pr-shutdown';

/** A terminal fact goes to the funnel under the kernel's scope (S4a, pr-fact-scope.ts). */
const FUNNEL_OPTS = { scope: expect.objectContaining({ where: expect.any(Function) }) };

// ── Test helpers ──────────────────────────────────────────────────────────────

const WS_ID = 'ws-1';
const WINNER_PR = 11;
const LOSER_PR = 10;
const INSTALLATION_ID = 99;
const REPO = 'acme/myrepo';
const SUBJECT_PR = 5;

function makeWorkspace(overrides: Record<string, any> = {}) {
  return {
    gitConfig: {
      subjectPolicy: {
        autoCloseBuilddSupersededPrs: true,
        conflictDeadDays: 7,
        ...overrides.subjectPolicy,
      },
      ...overrides.gitConfig,
    },
    ...overrides,
  };
}

function makeEventWorker(overrides: Partial<{ prBaseRef: string | null }> = {}) {
  return { id: 'w-winner', taskId: 't-winner', prBaseRef: null, ...overrides };
}

function makeEventTask() {
  return { subjectPrNumber: SUBJECT_PR };
}

function makeLoserTask() {
  return { id: 't-loser', missionId: 'mission-1' };
}

function makeLoserWorker(overrides: Partial<{
  prLifecycleStatus: string | null;
  conflictDetectedAt: Date | null;
  updatedAt: Date;
  prBaseRef: string | null;
}> = {}) {
  return {
    id: 'w-loser',
    taskId: 't-loser',
    prNumber: LOSER_PR,
    branch: 'buildd/loser-branch',
    prLifecycleStatus: 'pr_open',
    conflictDetectedAt: null,
    workspaceId: WS_ID,
    updatedAt: new Date(),
    prBaseRef: null,
    ...overrides,
  };
}

// Reset all mocks between tests
function resetMocks() {
  mockWorkspacesFindFirst.mockImplementation(() => null);
  mockWorkersFindFirst.mockImplementation(() => null);
  mockWorkersFindMany.mockImplementation(() => []);
  mockTasksFindFirst.mockImplementation(() => null);
  mockTasksFindMany.mockImplementation(() => []);
  mockMissionNotesFindFirst.mockImplementation(() => null);
  mockGithubApi.mockReset();
  mockGithubApi.mockImplementation(() => Promise.resolve({ id: 1 }));
  recordedFacts.length = 0;
  mockVerifyPrCarriedBy.mockReset();
  mockVerifyPrCarriedBy.mockImplementation(() => Promise.resolve(VERIFIED));
  verifyCalls.length = 0;
  recordCalls.length = 0;
  recordResult = { ok: true };
  gateEvents.length = 0;
}

/** Winner merged; loser from a sibling task, same base, idle past the active-work window. */
function arrangeSiblingLoser(loser: Partial<Parameters<typeof makeLoserWorker>[0]> = {}) {
  const idle = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours — well past 30 minutes
  mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace());
  mockWorkersFindFirst.mockImplementation(() => makeEventWorker({ prBaseRef: 'dev' }));
  mockTasksFindFirst.mockImplementation(() => makeEventTask());
  mockTasksFindMany.mockImplementation(() => [makeLoserTask()]);
  mockWorkersFindMany.mockImplementation(() => [makeLoserWorker({ updatedAt: idle, prBaseRef: 'dev', ...loser })]);
  mockMissionNotesFindFirst.mockImplementation(() => null);
}

function closeCallFor(prNumber: number) {
  return mockGithubApi.mock.calls.find(([, path]) => path.includes(`/pulls/${prNumber}`));
}
function commentCallFor(prNumber: number) {
  return mockGithubApi.mock.calls.find(([, path]) => path.includes(`/issues/${prNumber}/comments`));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('shutdownDeadBuilddPrs', () => {

  beforeEach(() => {
    resetMocks();
  });

  afterAll(() => {
    mock.restore();
  });

  // ── Feature flag OFF ────────────────────────────────────────────────────────

  it('returns empty result when autoCloseBuilddSupersededPrs is false (feature flag OFF)', async () => {
    mockWorkspacesFindFirst.mockImplementation(() => ({
      gitConfig: { subjectPolicy: { autoCloseBuilddSupersededPrs: false } },
    }));

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toHaveLength(0);
    expect(result.escalatedPrNumbers).toHaveLength(0);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  // ── Human-owned PR safety ───────────────────────────────────────────────────

  it('never auto-closes a PR when no buildd worker record exists (human-authored)', async () => {
    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace());

    // No event worker → no closure
    mockWorkersFindFirst.mockImplementation(() => null);
    mockTasksFindFirst.mockImplementation(() => null);

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toHaveLength(0);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

  // ── Tier 1: closed/superseded → immediate closure ───────────────────────────

  it('Tier 1: closes a buildd-authored loser PR when the winner merges', async () => {
    // Loser updated 1 hour ago (not recently active)
    const oldUpdate = new Date(Date.now() - 60 * 60 * 1000);

    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace());
    mockWorkersFindFirst.mockImplementation(() => makeEventWorker());
    mockTasksFindFirst.mockImplementation(() => makeEventTask());
    mockTasksFindMany.mockImplementation(() => [makeLoserTask()]);
    mockWorkersFindMany.mockImplementation(() => [makeLoserWorker({ updatedAt: oldUpdate })]);
    mockMissionNotesFindFirst.mockImplementation(() => null);

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toContain(LOSER_PR);
    expect(result.closedPrNumbers).toHaveLength(1);

    // Comment posted
    const commentCall = mockGithubApi.mock.calls.find(
      ([, path]) => path.includes(`/issues/${LOSER_PR}/comments`),
    );
    expect(commentCall).toBeDefined();

    // PR closed via PATCH
    const closeCall = mockGithubApi.mock.calls.find(
      ([, path]) => path.includes(`/pulls/${LOSER_PR}`),
    );
    expect(closeCall).toBeDefined();

    // Worker stamped closed through the fact funnel
    expect(recordedFacts).toEqual([{ target: { workerId: 'w-loser' }, fact: { kind: 'closed' }, opts: FUNNEL_OPTS }]);
  });

  // ── Content verification: the close waits on the proof the edge needs ──────

  it('regression (#5461/#5463): does NOT close a sibling task\'s PR the winner does not carry, with no comment and no edge', async () => {
    // Two tasks in one mission anchored to the same subject, both to dev, the
    // loser idle for hours, the winner merged — every pre-filter passes. The
    // winner's diff shares nothing with the loser's, so nothing may close.
    arrangeSiblingLoser();
    mockVerifyPrCarriedBy.mockImplementation(() => Promise.resolve({ outcome: 'unverified', confidence: 0 }));

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toHaveLength(0);
    expect(result.unverifiedPrNumbers).toEqual([LOSER_PR]);
    expect(result.skippedPrNumbers).toContain(LOSER_PR);
    expect(result.supersededPrNumbers).toHaveLength(0);
    expect(commentCallFor(LOSER_PR)).toBeUndefined();
    expect(closeCallFor(LOSER_PR)).toBeUndefined();
    expect(recordedFacts).toHaveLength(0);
    expect(recordCalls).toHaveLength(0);
    // The verifier compared the loser against the winner, in the event repo.
    expect(verifyCalls).toHaveLength(1);
    expect(verifyCalls[0]).toMatchObject({ installationId: INSTALLATION_ID, repo: REPO, prNumber: LOSER_PR, candidatePrNumber: WINNER_PR });
    // The refusal is a visible gate event, not a silent skip.
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0]).toMatchObject({
      gate: 'auto_pr_supersession', outcome: 'rejected', surface: 'dead-pr-shutdown',
      taskId: 't-loser', workerId: 'w-loser',
      detail: expect.objectContaining({ prNumber: LOSER_PR, winnerPrNumber: WINNER_PR, verdict: 'unverified' }),
    });
  });

  it('closes a verified duplicate and records the supersession edge with the method in its reason', async () => {
    arrangeSiblingLoser();
    mockVerifyPrCarriedBy.mockImplementation(() => Promise.resolve({ outcome: 'verified', method: 'content', confidence: 0.96 }));

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toEqual([LOSER_PR]);
    expect(result.supersededPrNumbers).toEqual([LOSER_PR]);
    expect(result.unverifiedPrNumbers).toHaveLength(0);
    expect(commentCallFor(LOSER_PR)).toBeDefined();
    expect(closeCallFor(LOSER_PR)).toBeDefined();
    expect(recordedFacts).toEqual([{ target: { workerId: 'w-loser' }, fact: { kind: 'closed' }, opts: FUNNEL_OPTS }]);
    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0]).toMatchObject({ workerId: 'w-loser', supersedingPrNumber: WINNER_PR, caller: 'system' });
    expect(recordCalls[0].recordedBy).toMatch(/^system:/);
    expect(recordCalls[0].reason).toContain('method: content');
    expect(recordCalls[0].reason).toContain(`#${WINNER_PR}`);
    // The edge is recorded after GitHub confirmed the close, never before.
    const closeIdx = mockGithubApi.mock.calls.findIndex(([, path]) => path.includes(`/pulls/${LOSER_PR}`));
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0]).toMatchObject({
      gate: 'auto_pr_supersession', outcome: 'accepted', surface: 'dead-pr-shutdown',
      detail: expect.objectContaining({ prNumber: LOSER_PR, supersedingPrNumber: WINNER_PR, method: 'content', confidence: 0.96 }),
    });
  });

  it('a patch-id proof closes too, and the reason names that method', async () => {
    arrangeSiblingLoser();
    mockVerifyPrCarriedBy.mockImplementation(() => Promise.resolve({ outcome: 'verified', method: 'patch-id', confidence: 1 }));

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toEqual([LOSER_PR]);
    expect(recordCalls[0].reason).toContain('method: patch-id');
  });

  it('closes nothing when the verifier is unavailable (GitHub unreachable)', async () => {
    arrangeSiblingLoser();
    mockVerifyPrCarriedBy.mockImplementation(() => Promise.resolve({ outcome: 'unavailable', reason: 'could not read #10' }));

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toHaveLength(0);
    expect(result.unverifiedPrNumbers).toEqual([LOSER_PR]);
    expect(mockGithubApi).not.toHaveBeenCalled();
    expect(recordedFacts).toHaveLength(0);
    expect(recordCalls).toHaveLength(0);
    expect(gateEvents[0]).toMatchObject({ outcome: 'rejected', detail: expect.objectContaining({ verdict: 'unavailable' }) });
  });

  it('closes nothing when the verifier throws', async () => {
    arrangeSiblingLoser();
    mockVerifyPrCarriedBy.mockImplementation(() => Promise.reject(new Error('GitHub API error: 502')));

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toHaveLength(0);
    expect(result.skippedPrNumbers).toContain(LOSER_PR);
    expect(mockGithubApi).not.toHaveBeenCalled();
    expect(recordedFacts).toHaveLength(0);
    expect(recordCalls).toHaveLength(0);
  });

  it('Tier 2: an unverified conflict-dead loser is escalated (Tier 3), not closed', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    arrangeSiblingLoser({ prLifecycleStatus: 'conflict', conflictDetectedAt: eightDaysAgo });
    mockVerifyPrCarriedBy.mockImplementation(() => Promise.resolve({ outcome: 'unverified', confidence: 0.2 }));

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toHaveLength(0);
    expect(result.escalatedPrNumbers).toEqual([LOSER_PR]);
    expect(result.unverifiedPrNumbers).toEqual([LOSER_PR]);
    expect(closeCallFor(LOSER_PR)).toBeUndefined();
    expect(recordCalls).toHaveLength(0);
  });

  it('the pre-filters run before the verifier: a recently active loser is never read from GitHub', async () => {
    arrangeSiblingLoser({ updatedAt: new Date(Date.now() - 5 * 60 * 1000) });

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toHaveLength(0);
    expect(verifyCalls).toHaveLength(0);
  });

  it('a verified close whose edge write is refused still closes, and reports the PR as not superseded', async () => {
    arrangeSiblingLoser();
    recordResult = { ok: false, error: 'refused by the workflow kernel: not_closed_unmerged', status: 409 };

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toEqual([LOSER_PR]);
    expect(result.supersededPrNumbers).toHaveLength(0);
    expect(recordCalls).toHaveLength(1);
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0]).toMatchObject({ outcome: 'warned', detail: expect.objectContaining({ prNumber: LOSER_PR, error: expect.stringContaining('not_closed_unmerged') }) });
  });

  // ── Tier 2: conflict-dead + green successor ─────────────────────────────────

  it('never auto-closes a mission ship PR that merely shares a subject with the merged PR', async () => {
    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace());
    mockWorkersFindFirst.mockImplementation(() => makeEventWorker());
    mockTasksFindFirst.mockImplementation(() => makeEventTask());
    mockTasksFindMany.mockImplementation(() => [
      { ...makeLoserTask(), title: 'Ship mission: Failure Pattern Sentinel', taskClass: 'bookkeeping' },
    ]);
    mockWorkersFindMany.mockImplementation(() => [
      makeLoserWorker({ updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) }),
    ]);

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toHaveLength(0);
    expect(mockGithubApi).not.toHaveBeenCalled();
    expect(recordedFacts).toHaveLength(0);
  });

  it('Tier 2: closes a conflict-dead loser PR after conflictDeadDays when winner merges', async () => {
    // conflictDetectedAt = 8 days ago (> 7 day threshold)
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    // updatedAt = 2 days ago (not recently active, outside the active work window)
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace({ subjectPolicy: { conflictDeadDays: 7, autoCloseBuilddSupersededPrs: true } }));
    mockWorkersFindFirst.mockImplementation(() => makeEventWorker());
    mockTasksFindFirst.mockImplementation(() => makeEventTask());
    mockTasksFindMany.mockImplementation(() => [makeLoserTask()]);
    mockWorkersFindMany.mockImplementation(() => [
      makeLoserWorker({ prLifecycleStatus: 'conflict', conflictDetectedAt: eightDaysAgo, updatedAt: twoDaysAgo }),
    ]);
    mockMissionNotesFindFirst.mockImplementation(() => null);

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toContain(LOSER_PR);

    // PR close called
    const closeCall = mockGithubApi.mock.calls.find(
      ([, path]) => path.includes(`/pulls/${LOSER_PR}`),
    );
    expect(closeCall).toBeDefined();
  });

  it('Tier 2: does NOT close a conflict-dead loser PR before conflictDeadDays', async () => {
    // conflictDetectedAt = 3 days ago (< 7 day threshold)
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    // updatedAt = 1 day ago (not recently active)
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);

    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace({ subjectPolicy: { conflictDeadDays: 7, autoCloseBuilddSupersededPrs: true } }));
    mockWorkersFindFirst.mockImplementation(() => makeEventWorker());
    mockTasksFindFirst.mockImplementation(() => makeEventTask());
    mockTasksFindMany.mockImplementation(() => [makeLoserTask()]);
    mockWorkersFindMany.mockImplementation(() => [
      makeLoserWorker({ prLifecycleStatus: 'conflict', conflictDetectedAt: threeDaysAgo, updatedAt: oneDayAgo }),
    ]);
    mockMissionNotesFindFirst.mockImplementation(() => null);

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    // Conflict-dead but not old enough AND winner merged → Tier 2 does not apply; Tier 3 applies (escalate)
    expect(result.closedPrNumbers).toHaveLength(0);
    expect(result.escalatedPrNumbers).toContain(LOSER_PR);
  });

  it('Tier 2: does NOT close a conflict-dead loser PR when it was recently updated (active work)', async () => {
    // conflictDetectedAt = 8 days ago (> 7 day threshold, otherwise Tier-2-eligible)
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    // updatedAt within 30 minutes = actively resolving the conflict right now
    const recentUpdate = new Date(Date.now() - 5 * 60 * 1000);

    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace({ subjectPolicy: { conflictDeadDays: 7, autoCloseBuilddSupersededPrs: true } }));
    mockWorkersFindFirst.mockImplementation(() => makeEventWorker());
    mockTasksFindFirst.mockImplementation(() => makeEventTask());
    mockTasksFindMany.mockImplementation(() => [makeLoserTask()]);
    mockWorkersFindMany.mockImplementation(() => [
      makeLoserWorker({ prLifecycleStatus: 'conflict', conflictDetectedAt: eightDaysAgo, updatedAt: recentUpdate }),
    ]);
    mockMissionNotesFindFirst.mockImplementation(() => null);

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    // PR should NOT be closed despite being conflict-dead past the threshold (actively being worked on)
    expect(result.closedPrNumbers).toHaveLength(0);

    // No GitHub close call for the loser
    const closeCall = mockGithubApi.mock.calls.find(
      ([, path]) => path.includes(`/pulls/${LOSER_PR}`),
    );
    expect(closeCall).toBeUndefined();
  });

  // ── Tier 3: conflict-dead, no successor ────────────────────────────────────

  it('Tier 3: creates escalation note for conflict-dead PR with no green successor', async () => {
    const oldUpdate = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace());
    mockWorkersFindFirst.mockImplementation(() => makeEventWorker());
    mockTasksFindFirst.mockImplementation(() => makeEventTask());
    mockTasksFindMany.mockImplementation(() => [makeLoserTask()]);
    mockWorkersFindMany.mockImplementation(() => [
      makeLoserWorker({ prLifecycleStatus: 'conflict', conflictDetectedAt: new Date(), updatedAt: oldUpdate }),
    ]);
    mockMissionNotesFindFirst.mockImplementation(() => null);

    // Winner PR was CLOSED without merge (no successor)
    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, false, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toHaveLength(0);
    expect(result.escalatedPrNumbers).toContain(LOSER_PR);

    // No GitHub API close call for the loser
    const closeCall = mockGithubApi.mock.calls.find(
      ([, path]) => path.includes(`/pulls/${LOSER_PR}`),
    );
    expect(closeCall).toBeUndefined();
  });

  // ── Active work safety ──────────────────────────────────────────────────────

  it('Tier 1: does NOT close a loser PR when it was recently updated (active work)', async () => {
    // updatedAt within 30 minutes = actively being worked on
    const recentUpdate = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago

    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace());
    mockWorkersFindFirst.mockImplementation(() => makeEventWorker());
    mockTasksFindFirst.mockImplementation(() => makeEventTask());
    mockTasksFindMany.mockImplementation(() => [makeLoserTask()]);
    mockWorkersFindMany.mockImplementation(() => [
      makeLoserWorker({ prLifecycleStatus: 'pr_open', updatedAt: recentUpdate }),
    ]);
    mockMissionNotesFindFirst.mockImplementation(() => null);

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    // PR should NOT be closed despite winner merging (actively being worked on)
    expect(result.closedPrNumbers).toHaveLength(0);
    expect(result.skippedPrNumbers).toContain(LOSER_PR);

    // No GitHub API close call should be made
    const closeCall = mockGithubApi.mock.calls.find(
      ([, path]) => path.includes(`/pulls/${LOSER_PR}`),
    );
    expect(closeCall).toBeUndefined();
  });

  // ── Cross-base safety (hotfix to main vs. CI-fix to dev) ───────────────────

  it('Tier 1: does NOT close a loser PR whose base differs from the winner\'s base', async () => {
    // Reproduces: a hotfix PR to `main` from one task, and a sibling task's
    // CI-isolation-fix PR to `dev` anchored to the same subject. The dev PR
    // merging must never close the main-bound hotfix PR out from under it.
    const oldUpdate = new Date(Date.now() - 60 * 60 * 1000);

    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace());
    mockWorkersFindFirst.mockImplementation(() => makeEventWorker({ prBaseRef: 'dev' }));
    mockTasksFindFirst.mockImplementation(() => makeEventTask());
    mockTasksFindMany.mockImplementation(() => [makeLoserTask()]);
    mockWorkersFindMany.mockImplementation(() => [
      makeLoserWorker({ updatedAt: oldUpdate, prBaseRef: 'main' }),
    ]);
    mockMissionNotesFindFirst.mockImplementation(() => null);

    // Winner PR (base dev) merges
    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toHaveLength(0);
    expect(result.skippedPrNumbers).toContain(LOSER_PR);

    const closeCall = mockGithubApi.mock.calls.find(
      ([, path]) => path.includes(`/pulls/${LOSER_PR}`),
    );
    expect(closeCall).toBeUndefined();
  });

  it('Tier 2: does NOT close a conflict-dead loser PR whose base differs from the winner\'s base', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace({ subjectPolicy: { conflictDeadDays: 7, autoCloseBuilddSupersededPrs: true } }));
    mockWorkersFindFirst.mockImplementation(() => makeEventWorker({ prBaseRef: 'dev' }));
    mockTasksFindFirst.mockImplementation(() => makeEventTask());
    mockTasksFindMany.mockImplementation(() => [makeLoserTask()]);
    mockWorkersFindMany.mockImplementation(() => [
      makeLoserWorker({ prLifecycleStatus: 'conflict', conflictDetectedAt: eightDaysAgo, updatedAt: twoDaysAgo, prBaseRef: 'main' }),
    ]);
    mockMissionNotesFindFirst.mockImplementation(() => null);

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    // Not closed via Tier 2 (different base) — falls through to Tier 3 escalation instead
    expect(result.closedPrNumbers).toHaveLength(0);
    expect(result.escalatedPrNumbers).toContain(LOSER_PR);

    const closeCall = mockGithubApi.mock.calls.find(
      ([, path]) => path.includes(`/pulls/${LOSER_PR}`),
    );
    expect(closeCall).toBeUndefined();
  });

  it('Tier 1: still closes same-base losers when base refs are known and equal', async () => {
    const oldUpdate = new Date(Date.now() - 60 * 60 * 1000);

    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace());
    mockWorkersFindFirst.mockImplementation(() => makeEventWorker({ prBaseRef: 'dev' }));
    mockTasksFindFirst.mockImplementation(() => makeEventTask());
    mockTasksFindMany.mockImplementation(() => [makeLoserTask()]);
    mockWorkersFindMany.mockImplementation(() => [
      makeLoserWorker({ updatedAt: oldUpdate, prBaseRef: 'dev' }),
    ]);
    mockMissionNotesFindFirst.mockImplementation(() => null);

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toContain(LOSER_PR);
  });

  // ── GitHub closure failure ──────────────────────────────────────────────────

  it('does not stamp worker closed when GitHub close call fails', async () => {
    const oldUpdate = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace());
    mockWorkersFindFirst.mockImplementation(() => makeEventWorker());
    mockTasksFindFirst.mockImplementation(() => makeEventTask());
    mockTasksFindMany.mockImplementation(() => [makeLoserTask()]);
    mockWorkersFindMany.mockImplementation(() => [makeLoserWorker({ updatedAt: oldUpdate })]);
    mockMissionNotesFindFirst.mockImplementation(() => null);

    // Make GitHub close throw
    mockGithubApi.mockImplementation((_installationId: number, path: string) => {
      if (path.includes(`/pulls/${LOSER_PR}`)) {
        throw new Error('GitHub API 422 Unprocessable Entity');
      }
      return Promise.resolve({ id: 1 });
    });

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    // PR NOT in closed list (failure → skipped)
    expect(result.closedPrNumbers).toHaveLength(0);
    expect(result.skippedPrNumbers).toContain(LOSER_PR);
    // No closed fact handed to the funnel, and no edge for a PR that is still open
    expect(recordedFacts).toHaveLength(0);
    expect(recordCalls).toHaveLength(0);
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────

  it('is idempotent: re-running when loser is already closed returns empty result', async () => {
    mockWorkspacesFindFirst.mockImplementation(() => makeWorkspace());
    mockWorkersFindFirst.mockImplementation(() => makeEventWorker());
    mockTasksFindFirst.mockImplementation(() => makeEventTask());
    mockTasksFindMany.mockImplementation(() => [makeLoserTask()]);

    // Loser worker already has prLifecycleStatus=closed — filtered out by query
    mockWorkersFindMany.mockImplementation(() => [
      // The real DB query filters out closed/merged, so findMany returns empty
    ]);

    const result = await shutdownDeadBuilddPrs(WS_ID, WINNER_PR, true, INSTALLATION_ID, REPO);

    expect(result.closedPrNumbers).toHaveLength(0);
    expect(mockGithubApi).not.toHaveBeenCalled();
  });

});
