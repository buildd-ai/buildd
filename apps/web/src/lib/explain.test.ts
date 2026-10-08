import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ─── Fixtures the mocked DB serves ────────────────────────────────────────────

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let missionRow: Row | null = null;
/** Multi-mission fixture for workspace fan-out tests; takes precedence over `missionRow` when set. */
let missionRows: Row[] = [];
let taskRows: Row[] = [];
let workerRows: Row[] = [];
let completionDecision: Row = { ok: true, code: 'ok', reason: 'clear' };
let workStateResult: Row | null = null;

const mockTasksFindMany = mock(async (args: Row) => {
  // The parentTaskId query (attempts) is distinguishable by its where marker.
  const where = args?.where ?? {};
  if (where.field === 'parentTaskId') {
    return where.type === 'inArray'
      ? taskRows.filter(t => (where.value as string[]).includes(t.parentTaskId))
      : taskRows.filter(t => t.parentTaskId === where.value);
  }
  if (where.field === 'id' && where.type === 'inArray') {
    return taskRows.filter(t => (where.value as string[]).includes(t.id));
  }
  if (where.field === 'missionId') {
    return taskRows.filter(t => t.missionId === where.value);
  }
  return taskRows;
});

const mockTasksFindFirst = mock(async (args: Row) => {
  const where = args?.where ?? {};
  return taskRows.find(t => t.id === where.value) ?? undefined;
});

const mockMissionsFindFirst = mock(async (args: Row) => {
  const where = args?.where ?? {};
  if (missionRows.length > 0) return missionRows.find(m => m.id === where.value) ?? undefined;
  return missionRow ?? undefined;
});
const mockMissionsFindMany = mock(async () =>
  missionRows.length > 0 ? missionRows : (missionRow ? [missionRow] : []),
);
const mockWorkersFindMany = mock(async () => workerRows);
let gateEventRows: Row[] = [];
const mockGateEventsFindMany = mock(async () => gateEventRows);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst, findMany: mockMissionsFindMany },
      workspaces: { findFirst: mock(async () => ({ id: 'ws-1', teamId: 'team-1', accessMode: 'open', gitConfig: { executor: 'cloud' } })) },
      tasks: { findFirst: mockTasksFindFirst, findMany: mockTasksFindMany },
      workers: { findMany: mockWorkersFindMany },
      gateEvents: { findMany: mockGateEventsFindMany },
    },
  },
}));

let latestWake: Row | null = null;
const mockLatestDispatchForTask = mock(async (_id: string) => latestWake);
mock.module('@buildd/core/dispatch-outbox', () => ({ latestDispatchForTask: mockLatestDispatchForTask }));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id' },
  missions: { id: 'id', workspaceId: 'workspaceId', status: 'status' },
  tasks: { id: 'id', missionId: 'missionId', parentTaskId: 'parentTaskId', workspaceId: 'workspaceId', status: 'status' },
  workers: { id: 'id', workspaceId: 'workspaceId', prBaseRef: 'prBaseRef', mergedAt: 'mergedAt', startedAt: 'startedAt' },
  gateEvents: { taskId: 'taskId', occurredAt: 'occurredAt' },
}));

mock.module('drizzle-orm', () => ({
  and: (...c: Row[]) => ({ type: 'and', c }),
  eq: (field: string, value: unknown) => ({ type: 'eq', field, value }),
  gt: (field: string, value: unknown) => ({ type: 'gt', field, value }),
  ne: (field: string, value: unknown) => ({ type: 'ne', field, value }),
  inArray: (field: string, value: unknown) => ({ type: 'inArray', field, value }),
  isNotNull: (field: string) => ({ type: 'isNotNull', field }),
  desc: (field: string) => ({ type: 'desc', field }),
}));

// Tracks in-flight overlap so the fan-out concurrency test can observe that
// multiple missions' `canCompleteMission` calls are in flight at once, rather
// than asserting on wall-clock time (flaky under CI scheduling jitter).
let inFlightCanCompleteMission = 0;
let maxInFlightCanCompleteMission = 0;
const mockCanCompleteMission = mock(async () => {
  inFlightCanCompleteMission++;
  maxInFlightCanCompleteMission = Math.max(maxInFlightCanCompleteMission, inFlightCanCompleteMission);
  await new Promise(resolve => setTimeout(resolve, 5));
  inFlightCanCompleteMission--;
  return completionDecision;
});
mock.module('@/lib/mission-completion', () => ({ canCompleteMission: mockCanCompleteMission }));

const mockEvaluateMissionWorkState = mock(async () => workStateResult);
mock.module('@/lib/mission-pr', () => ({ evaluateMissionWorkState: mockEvaluateMissionWorkState }));

let browserHeartbeats: Row[] | null = [];
mock.module('@/lib/runner-heartbeats', () => ({ loadBrowserRunnerHeartbeats: mock(async () => browserHeartbeats) }));

// Imported AFTER the mocks.
import { explainMission, explainTask, explainPr, explainWorkspace, historyPrStateOf, kernelUnmergedPr } from './explain';
import { summarizeMissionForCard, type MissionCardRow } from './mission-card-view';

const ACTOR = { userId: 'user-1' };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function task(over: Partial<Row> = {}): Row {
  return {
    id: 'task-1',
    title: 'Wire the route',
    status: 'completed',
    mode: 'execution',
    kind: 'engineering',
    taskClass: 'work',
    parentTaskId: null,
    workspaceId: 'ws-1',
    missionId: 'mission-1',
    creationSource: null,
    category: null,
    pathManifest: null,
    context: null,
    startAt: null,
    loopConfig: null,
    loopState: null,
    result: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    dependsOn: null,
    workers: [],
    ...over,
  };
}

function worker(over: Partial<Row> = {}): Row {
  return {
    id: 'worker-1',
    status: 'completed',
    prNumber: null,
    prUrl: null,
    branch: null,
    prBaseRef: null,
    prLifecycleStatus: null,
    mergedAt: null,
    observedTouches: null,
    error: null,
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

beforeEach(() => {
  missionRow = null;
  missionRows = [];
  taskRows = [];
  workerRows = [];
  gateEventRows = [];
  completionDecision = { ok: true, code: 'ok', reason: 'clear' };
  workStateResult = null;
  inFlightCanCompleteMission = 0;
  maxInFlightCanCompleteMission = 0;
  mockCanCompleteMission.mockClear();
  mockEvaluateMissionWorkState.mockClear();
});

// ─── Mission scope ────────────────────────────────────────────────────────────

// History nodes read the shared derivePrDisplayState (lib/pr-presentation.ts).
describe('historyPrStateOf', () => {
  const w = (prLifecycleStatus: string | null, mergedAt: Date | null = null) =>
    ({ prNumber: 7, prLifecycleStatus, mergedAt }) as Parameters<typeof historyPrStateOf>[0];
  it('no PR reads none', () => {
    expect(historyPrStateOf(undefined)).toBe('none');
  });
  it('a merged lifecycle reads merged even before mergedAt is stamped', () => {
    expect(historyPrStateOf(w('merged'))).toBe('merged');
  });
  it('red CI is reported, not folded into open', () => {
    expect(historyPrStateOf(w('ci_failed'))).toBe('ci_failed');
  });
  it('conflict, closed and unresolvable keep their meaning', () => {
    expect(historyPrStateOf(w('conflict'))).toBe('conflict');
    expect(historyPrStateOf(w('closed'))).toBe('closed');
    expect(historyPrStateOf(w('unresolvable'))).toBe('closed');
    expect(historyPrStateOf(w('ci_green'))).toBe('open');
  });
  // §17.5 (Slice E): a task that owns a kernel-owned delivery reads the delivery.
  it('a kernel-owned delivery wins over the worker columns', () => {
    expect(historyPrStateOf(w('merged'), { prState: 'ci_failed', prNumber: 7 })).toBe('ci_failed');
    expect(historyPrStateOf(w('ci_failed'), { prState: 'merged', prNumber: 7 })).toBe('merged');
    expect(historyPrStateOf(undefined, { prState: 'awaiting_ci', prNumber: 7 })).toBe('open');
  });
});

describe('kernelUnmergedPr (§17.5: explain\'s state chain reads the delivery)', () => {
  const task = { id: 't1', title: 'feat: x', status: 'completed' };
  it('a live delivery is unmerged; a settled one is not', () => {
    expect(kernelUnmergedPr(task, { prUrl: 'u' }, { state: 'AWAITING_REVIEW', prNumber: 7 })).toEqual([{ taskId: 't1', title: 'feat: x', prNumber: 7, prUrl: 'u' }]);
    for (const state of ['MERGED', 'SUPERSEDED', 'ABANDONED', 'FAILED'] as const) {
      expect(kernelUnmergedPr(task, { prUrl: 'u' }, { state, prNumber: 7 })).toEqual([]);
    }
  });
  it('closed with no edge is closed-unsuperseded, whatever the worker column says', () => {
    expect(kernelUnmergedPr(task, { prUrl: 'u' }, { state: 'CLOSED_UNMERGED', prNumber: 7 })[0]).toMatchObject({ closedUnsuperseded: true });
  });
  it('a failed owner attempt whose PR is live still holds the PR open (S35)', () => {
    expect(kernelUnmergedPr({ ...task, status: 'failed' }, undefined, { state: 'REPAIRING', prNumber: 7 })).toHaveLength(1);
  });
});

describe('explainMission', () => {
  it('never spends a token: the completion gate is asked read-only', async () => {
    missionRow = { id: 'mission-1', title: 'Build auth', workspaceId: 'ws-1', status: 'active', schedule: null };
    taskRows = [task({ status: 'completed' })];

    await explainMission('mission-1');

    expect(mockCanCompleteMission).toHaveBeenCalledTimes(1);
    // evaluateCriteria: false — the default PULLS a verdict, which dispatches
    // verification tasks. A read must not.
    const [, opts] = mockCanCompleteMission.mock.calls[0] as unknown as [string, Row];
    expect(opts.evaluateCriteria).toBe(false);
  });

  // A dependency in another mission is not in the mission's own task rows. It
  // is loaded by id, so a met one is never cited as the thing being waited on.
  describe('out-of-mission dependencies', () => {
    const pendingDependent = () =>
      task({ id: 'task-b', status: 'pending', title: 'Second', dependsOn: ['foreign'] });
    beforeEach(() => {
      completionDecision = {
        ok: false, code: 'pending_deliverables', reason: '1 task(s) still open (1 pending)',
        pendingDeliverables: 1, pendingByStatus: { pending: 1 }, awaitingMergeDetails: [],
      };
    });

    it('a met out-of-mission dependency is not cited as waitingOn', async () => {
      missionRow = { id: 'mission-1', title: 'Build auth', workspaceId: 'ws-1', status: 'active', schedule: null };
      taskRows = [
        pendingDependent(),
        task({ id: 'foreign', missionId: 'mission-other', status: 'completed', workers: [] }),
      ];

      const answer = (await explainMission('mission-1'))!.subjects[0];
      const cited = (answer.waitingOn as { taskIds?: string[] } | null)?.taskIds ?? [];
      expect(cited).not.toContain('foreign');
      expect(cited).toContain('task-b');
    });

    it('an unmet out-of-mission dependency is cited', async () => {
      missionRow = { id: 'mission-1', title: 'Build auth', workspaceId: 'ws-1', status: 'active', schedule: null };
      taskRows = [
        pendingDependent(),
        task({ id: 'foreign', missionId: 'mission-other', status: 'in_progress', workers: [] }),
      ];

      const answer = (await explainMission('mission-1'))!.subjects[0];
      expect((answer.waitingOn as { taskIds?: string[] } | null)?.taskIds).toEqual(['foreign']);
    });

    it('a dependency id with no row anywhere is cited: the claim gate blocks on it', async () => {
      missionRow = { id: 'mission-1', title: 'Build auth', workspaceId: 'ws-1', status: 'active', schedule: null };
      taskRows = [pendingDependent()];

      const answer = (await explainMission('mission-1'))!.subjects[0];
      expect((answer.waitingOn as { taskIds?: string[] } | null)?.taskIds).toEqual(['foreign']);
    });
  });

  it('answers with state, waitingOn, because, history, nextAction and derivedFrom', async () => {
    missionRow = { id: 'mission-1', title: 'Build auth', workspaceId: 'ws-1', status: 'active', schedule: null };
    taskRows = [
      task({ id: 'task-open', status: 'pending', title: 'Write the migration' }),
      task({ id: 'task-done', status: 'completed', title: 'Wire the route' }),
    ];
    completionDecision = {
      ok: false,
      code: 'pending_deliverables',
      reason: '1 task(s) still open (1 pending)',
      pendingDeliverables: 1,
      pendingByStatus: { pending: 1 },
      awaitingMergeDetails: [],
    };

    const result = await explainMission('mission-1');
    expect(result).not.toBeNull();
    const answer = result!.subjects[0];

    expect(answer.subject.scope).toBe('mission');
    expect(answer.state).toBe('blocked');
    expect(answer.waitingOn?.kind).toBe('task');
    expect(answer.because.length).toBeGreaterThan(0);
    expect(answer.because.map(l => l.order)).toEqual(answer.because.map((_, i) => i + 1));
    expect(answer.nextAction).toBeTruthy();

    // Every field says where it came from.
    expect(answer.derivedFrom.state).toBeTruthy();
    expect(answer.derivedFrom.waitingOn).toBeTruthy();
    expect(answer.derivedFrom.because.length).toBeGreaterThan(0);
    expect(answer.derivedFrom.history).toContain('attachAttempts');
    expect(answer.derivedFrom.nextAction).toBeTruthy();

    // The header chip rides on the same answer as the panel, so the two
    // cannot disagree: a blocked mission never reads AUTO/RUNNING up top.
    // (Open work with no live worker: the view names it 'stalled' → STALLED.)
    expect(answer.displayState).toBe('stalled');
    expect(answer.chip.label).toBe('STALLED');
    expect(['AUTO', 'RUNNING']).not.toContain(answer.chip.label);
  });

  // Regression: a running mission's panel said "Task X is in_progress with no
  // live worker" for the task a worker was running. Liveness is per row.
  it('never says "no live worker" about a task a worker is running', async () => {
    missionRow = { id: 'mission-1', title: 'Build auth', workspaceId: 'ws-1', status: 'active', schedule: null };
    taskRows = [
      task({ id: 'task-live', status: 'in_progress', title: 'Build the page', workers: [worker({ id: 'w-live', status: 'running' })] }),
      task({ id: 'task-orphan', status: 'in_progress', title: 'Write the docs', workers: [worker({ id: 'w-dead', status: 'failed' })] }),
    ];
    completionDecision = {
      ok: false,
      code: 'pending_deliverables',
      reason: '2 task(s) still open (2 in_progress)',
      pendingDeliverables: 2,
      pendingByStatus: { in_progress: 2 },
      awaitingMergeDetails: [],
    };

    const answer = (await explainMission('mission-1'))!.subjects[0];
    const live = answer.because.find(l => l.refs.taskId === 'task-live');
    const orphan = answer.because.find(l => l.refs.taskId === 'task-orphan');
    expect(live?.claim).toBeDefined();
    expect(live!.claim).not.toContain('no live worker');
    expect(orphan?.claim).toBe('Task "Write the docs" is in_progress with no live worker.');
    // The situation block prints because[0]: the orphan, not the running task.
    expect(answer.because[0].refs.taskId).toBe('task-orphan');
  });

  it('collapses attempts under their parent rather than listing them as siblings', async () => {
    missionRow = { id: 'mission-1', title: 'Build auth', workspaceId: 'ws-1', status: 'active', schedule: null };
    taskRows = [
      task({ id: 'parent', title: 'Wire the route' }),
      task({ id: 'retry-1', title: '[CI Retry #1] Wire the route', taskClass: 'attempt', parentTaskId: 'parent', createdAt: new Date('2026-01-02T00:00:00.000Z') }),
      task({ id: 'retry-2', title: '[reviewer] Wire the route', taskClass: 'attempt', parentTaskId: 'parent', createdAt: new Date('2026-01-03T00:00:00.000Z') }),
    ];

    const result = await explainMission('mission-1');
    const history = result!.subjects[0].history;

    expect(history).toHaveLength(1);
    expect(history[0].taskId).toBe('parent');
    expect(history[0].attempts.map(a => a.taskId)).toEqual(['retry-1', 'retry-2']);
  });

  it('reads the criteria gate from the same n/N the card does (one progress definition)', async () => {
    // A cancelled task re-created under the same title folds into its survivor
    // (D1): the card counts 1/1 — completion attempted, the gate is refused.
    // The detail page must not count 1/2 and call the same gate merely failing.
    missionRow = {
      id: 'mission-1', title: 'Build auth', workspaceId: 'ws-1', status: 'active', isHeld: false, schedule: null,
      goalCriteria: [{ type: 'custom', label: 'login works' }],
      goalCriteriaState: { overall: 'fail', criteria: [{ verdict: 'fail', type: 'custom', label: 'login works' }] },
    };
    taskRows = [
      task({ id: 'first', status: 'cancelled', title: 'Wire the route', createdAt: new Date('2026-01-01T00:00:00.000Z') }),
      task({ id: 'again', status: 'completed', title: 'Wire the route', createdAt: new Date('2026-01-02T00:00:00.000Z') }),
    ];

    const answer = (await explainMission('mission-1'))!.subjects[0];
    const card = summarizeMissionForCard({ ...missionRow, tasks: taskRows } as MissionCardRow);
    const criterionTone = (w: { kind: string; tone?: string } | null | undefined) =>
      w && w.kind === 'criterion_failing' ? w.tone : null;
    expect(criterionTone(card.state.waitingOn)).toBe('error');
    expect(criterionTone(answer.waitingOn as any)).toBe(criterionTone(card.state.waitingOn)); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it('returns null for a mission that does not exist', async () => {
    expect(await explainMission('nope')).toBeNull();
  });

  // Friction dbaadf34: `explain` kept citing "the claim loop deferred a task
  // 24 times in a row" for a task that had since completed. `gate_events`
  // never gets a "cleared" row when a task finally dispatches, so age alone
  // (the freshness window `loadMissionClaimDeferrals` applies) cannot tell a
  // resolved streak from a live one — the task's current status can.
  describe('claim-loop deferrals', () => {
    function deferralRow(over: Partial<Row> = {}): Row {
      return {
        taskId: 'task-1',
        reason: 'oauth_parallelism',
        occurredAt: new Date(),
        detail: {
          consecutiveDeferrals: 24,
          firstDeferredAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        },
        ...over,
      };
    }

    it('drops the warning once the deferred task has left pending', async () => {
      missionRow = { id: 'mission-1', title: 'Build auth', workspaceId: 'ws-1', status: 'active', schedule: null };
      taskRows = [task({ id: 'task-1', status: 'completed', title: 'OAuth parallelism' })];
      gateEventRows = [deferralRow()];

      const answer = (await explainMission('mission-1'))!.subjects[0];
      expect(answer.outstanding.some(o => o.kind === 'claim_deferral')).toBe(false);
      expect(answer.situation.headline).not.toContain('times in a row');
    });

    it('still reports the warning while the deferred task is pending', async () => {
      missionRow = { id: 'mission-1', title: 'Build auth', workspaceId: 'ws-1', status: 'active', schedule: null };
      taskRows = [task({ id: 'task-1', status: 'pending', title: 'OAuth parallelism' })];
      gateEventRows = [deferralRow()];

      const answer = (await explainMission('mission-1'))!.subjects[0];
      expect(answer.outstanding.some(o => o.kind === 'claim_deferral')).toBe(true);
    });
  });
});

// ─── Task scope ───────────────────────────────────────────────────────────────

describe('explainTask', () => {
  // executor='local' (task 09ed6675): a queued task in a local mission is the
  // person's session's to claim — never "stalled, dispatch a worker".
  it('a pending task in a local mission is waiting for a local session to claim it', async () => {
    missionRow = { id: 'mission-1', executor: 'local', isHeld: false };
    taskRows = [task({ id: 'task-1', status: 'pending' })];
    const answer = (await explainTask('task-1', ACTOR))!.subjects[0];
    expect(answer.chip.label).toBe('LOCAL');
    expect(answer.situation.headline).toBe('Waiting for a local session to claim the open task.');
    expect(answer.situation.headline).not.toMatch(/stall/i);
    expect(answer.situation.nextAction ?? '').toContain('claim_task');
    expect(answer.situation.nextAction ?? '').not.toMatch(/Dispatch a worker/);
    expect(answer.because.map(l => l.claim).join(' ')).toContain('waiting for a local session to claim it');
    expect(answer.because.map(l => l.claim).join(' ')).not.toContain('no live worker');
  });

  it('the same pending task in a runner mission still reads as a stall', async () => {
    missionRow = { id: 'mission-1', executor: 'runner', isHeld: false };
    taskRows = [task({ id: 'task-1', status: 'pending' })];
    const answer = (await explainTask('task-1', ACTOR))!.subjects[0];
    expect(answer.chip.label).not.toBe('LOCAL');
    expect(answer.situation.headline).not.toContain('local session');
  });

  // A cloud container that died under the runner is requeued on the infra
  // retry budget (pending, startAt = now + backoff). It must read as an
  // automatic retry with a time, not as a stall or a failure to retry by hand.
  it('a task in its infra-retry backoff reads as an automatic retry, not a stall or a failure', async () => {
    missionRow = { id: 'mission-1', executor: 'runner', isHeld: false };
    const retryAt = new Date(Date.now() + 5 * 60_000);
    taskRows = [task({ id: 'task-1', status: 'pending', context: { infraRetryCount: 1 }, startAt: retryAt })];
    const answer = (await explainTask('task-1', ACTOR))!.subjects[0];
    expect(answer.situation.headline).toMatch(/infrastructure failure, automatic retry scheduled/);
    expect(answer.situation.headline).not.toMatch(/stall|failed/i);
    expect(answer.situation.nextAction ?? '').toContain(retryAt.toISOString());
    expect(answer.situation.nextAction ?? '').not.toMatch(/retry the task/i);
  });

  it('a pending task whose latest wake failed says so in because[], with the outbox id', async () => {
    missionRow = { id: 'mission-1', executor: 'runner', isHeld: false };
    taskRows = [task({ id: 'task-1', status: 'pending' })];
    latestWake = { id: 'outbox-9', status: 'failed', cause: 'task.created', transport: 'dispatch', attempt_count: 5, not_before: new Date(Date.now() - 3600_000).toISOString(), last_error: 'http_500' };
    try {
      const answer = (await explainTask('task-1', ACTOR))!.subjects[0];
      const wake = answer.because.find(l => l.refs.outboxId === 'outbox-9');
      expect(wake?.claim).toContain('failed after 5 attempts');
      // Before the closing conclusion, and numbered in order.
      expect(answer.because[answer.because.length - 1].refs.outboxId).toBeUndefined();
      expect(answer.because.map(l => l.order)).toEqual(answer.because.map((_, i) => i + 1));
    } finally {
      latestWake = null;
    }
  });

  it('a task held on a soft overlap names who holds what and the hold/start verdict', async () => {
    missionRow = { id: 'mission-1', executor: 'runner', isHeld: false };
    taskRows = [
      task({
        id: 'task-1', status: 'pending', pathManifest: ['scripts/'],
        pathDeclaration: { declared: ['scripts/'], source: 'creation', snapshotAt: 'x', overlapPolicy: 'v2', softOverlaps: [{ taskId: 'holder-1', paths: [], kind: 'prefix' }] },
      }),
      task({ id: 'holder-1', status: 'in_progress', title: 'Rewrite the test runner', pathManifest: ['scripts/run-unit-tests.ts'], missionId: 'mission-x' }),
    ];
    gateEventRows = [{
      taskId: 'task-1', gate: 'claim_loop_deferral', outcome: 'deferred', reason: 'soft_overlap',
      occurredAt: new Date('2026-01-03T00:00:00.000Z'),
      detail: { holderTaskId: 'holder-1', paths: ['scripts', 'scripts/run-unit-tests.ts'], verdict: 'HOLD', overlapKind: 'prefix', consecutiveDeferrals: 4 },
    }];
    try {
      const answer = (await explainTask('task-1', ACTOR))!.subjects[0];
      expect(answer.coordination?.holds).toEqual([expect.objectContaining({
        edge: 'soft_overlap', holderTaskId: 'holder-1', holderTitle: 'Rewrite the test runner', verdict: 'HOLD',
        paths: ['scripts', 'scripts/run-unit-tests.ts'],
      })]);
      const link = answer.because.find(l => l.refs.taskId === 'holder-1');
      expect(link?.claim).toContain('Rewrite the test runner');
      expect(link?.claim).toContain('HOLD');
      expect(answer.gateHistory[0].holder).toMatchObject({ holderTaskId: 'holder-1', verdict: 'HOLD' });
      expect(answer.because.map(l => l.order)).toEqual(answer.because.map((_, i) => i + 1));
    } finally {
      gateEventRows = [];
    }
  });

  it('a task held on a live path lease names the lease holder', async () => {
    missionRow = { id: 'mission-1', executor: 'runner', isHeld: false };
    taskRows = [
      task({ id: 'task-1', status: 'pending', pathManifest: ['apps/web/src/lib/x.ts'] }),
      task({ id: 'lease-1', status: 'in_progress', title: 'Lease holder', pathManifest: ['apps/web/src/lib/x.ts'], missionId: 'mission-x' }),
    ];
    gateEventRows = [{
      taskId: 'task-1', gate: 'claim_loop_deferral', outcome: 'deferred', reason: 'path_overlap',
      occurredAt: new Date('2026-01-03T00:00:00.000Z'), detail: { blockingTaskId: 'lease-1', prNumber: null, prUrl: null },
    }];
    try {
      const answer = (await explainTask('task-1', ACTOR))!.subjects[0];
      expect(answer.coordination?.holds[0]).toMatchObject({ edge: 'path_lease', holderTaskId: 'lease-1', paths: ['apps/web/src/lib/x.ts'] });
      expect(answer.because.some(l => l.claim.includes('live path lease held by task lease-1'))).toBe(true);
    } finally {
      gateEventRows = [];
    }
  });

  it('a task that is not pending never reads its wake', async () => {
    taskRows = [task({ id: 'task-1', status: 'completed' })];
    mockLatestDispatchForTask.mockClear();
    await explainTask('task-1', ACTOR);
    expect(mockLatestDispatchForTask).not.toHaveBeenCalled();
  });

  it('an unreadable wake leaves the chain as it was', async () => {
    missionRow = { id: 'mission-1', executor: 'runner', isHeld: false };
    taskRows = [task({ id: 'task-1', status: 'pending' })];
    mockLatestDispatchForTask.mockImplementationOnce(async () => { throw new Error('db'); });
    const answer = (await explainTask('task-1', ACTOR))!.subjects[0];
    expect(answer.because.some(l => l.refs.outboxId)).toBe(false);
  });

  it('a held local mission is not read as local (held wins)', async () => {
    missionRow = { id: 'mission-1', executor: 'local', isHeld: true };
    taskRows = [task({ id: 'task-1', status: 'pending' })];
    const answer = (await explainTask('task-1', ACTOR))!.subjects[0];
    expect(answer.chip.label).not.toBe('LOCAL');
  });

  it('reports a completed task with an unmerged PR as awaiting merge', async () => {
    taskRows = [
      task({
        id: 'task-1',
        status: 'completed',
        workers: [worker({ prNumber: 55, prUrl: 'https://example.invalid/55' })],
      }),
    ];

    const result = await explainTask('task-1', ACTOR);
    const answer = result!.subjects[0];
    expect(answer.state).toBe('awaiting_merge');
    expect(answer.waitingOn?.kind).toBe('merge');
    expect(answer.subject.prNumber).toBe(55);
    expect(answer.because.some(l => l.refs.prNumber === 55)).toBe(true);
  });

  // Friction 1dd98bb2: a PR closed months ago on GitHub read as "waiting on
  // you to merge 1 open PR #N" — a false headline, since GitHub will not let
  // a closed PR merge. The remedy is record_pr_supersession or investigation,
  // never a merge click.
  it('reports a completed task whose PR closed unmerged as pr_closed_unmerged, never as an open merge', async () => {
    taskRows = [
      task({
        id: 'task-1',
        status: 'completed',
        workers: [worker({ prNumber: 34, prUrl: 'https://example.invalid/34', prLifecycleStatus: 'closed' })],
      }),
    ];

    const result = await explainTask('task-1', ACTOR);
    const answer = result!.subjects[0];
    expect(answer.state).toBe('awaiting_merge');
    expect(answer.waitingOn?.kind).toBe('pr_closed_unmerged');
    expect(answer.situation.headline).toContain('closed without merging');
    expect(answer.situation.headline).not.toContain('open PR');
    expect(answer.situation.headline).not.toContain('ready to merge');
    expect(answer.nextAction).toContain('record_pr_supersession');
    expect(answer.because.some(l => l.claim.includes('record_pr_supersession'))).toBe(true);
  });

  // A request-changes review queued a builder-after-review attempt. The PR is
  // still open and unmerged, but the owner has nothing to merge yet — the next
  // push is the platform's. "Waiting on you to merge" here is the false headline.
  it('a queued fix attempt outranks awaiting_merge and names the iteration', async () => {
    taskRows = [
      task({
        id: 'task-1',
        status: 'completed',
        workers: [worker({ prNumber: 55, prUrl: 'https://example.invalid/55' })],
      }),
      task({
        id: 'fix-1',
        title: '[builder · after review #1] Wire the route',
        status: 'pending',
        taskClass: 'attempt',
        parentTaskId: 'task-1',
        context: { iteration: 1, maxIterations: 3 },
        workers: [],
      }),
    ];

    const answer = (await explainTask('task-1', ACTOR))!.subjects[0];
    expect(answer.state).not.toBe('awaiting_merge');
    expect(answer.state).toBe('waiting');
    expect(answer.waitingOn?.kind).toBe('task');
    expect(answer.waitingOn && 'attempt' in answer.waitingOn && answer.waitingOn.attempt).toEqual({
      iteration: 1, maxIterations: 3, claimed: false,
    });
    expect(answer.situation.headline).toContain('fix 1 of 3');
    expect(answer.situation.headline).toContain('queued');
    expect(answer.situation.headline).not.toContain('merge');
    expect(answer.outstanding.some(o => o.kind === 'merge')).toBe(false);
    expect(answer.because.some(l => l.refs.taskId === 'fix-1')).toBe(true);
  });

  it('a claimed fix attempt reads as running on fix N, still not awaiting merge', async () => {
    taskRows = [
      task({
        id: 'task-1',
        status: 'completed',
        workers: [worker({ prNumber: 55, prUrl: 'https://example.invalid/55' })],
      }),
      task({
        id: 'fix-1',
        status: 'in_progress',
        taskClass: 'attempt',
        parentTaskId: 'task-1',
        context: { iteration: 2, maxIterations: 3 },
        workers: [worker({ id: 'worker-fix', status: 'running' })],
      }),
    ];

    const answer = (await explainTask('task-1', ACTOR))!.subjects[0];
    expect(answer.state).toBe('running');
    expect(answer.situation.headline).toContain('fix 2 of 3 (in progress)');
    expect(answer.situation.headline).not.toContain('merge');
  });

  it('a finished fix attempt hands the task back to awaiting_merge', async () => {
    taskRows = [
      task({
        id: 'task-1',
        status: 'completed',
        workers: [worker({ prNumber: 55, prUrl: 'https://example.invalid/55' })],
      }),
      task({ id: 'fix-1', status: 'completed', taskClass: 'attempt', parentTaskId: 'task-1', context: { iteration: 1, maxIterations: 3 } }),
    ];

    const answer = (await explainTask('task-1', ACTOR))!.subjects[0];
    expect(answer.state).toBe('awaiting_merge');
  });

  it('reports a completed, merged task as quiet — waitingOn null, nextAction null', async () => {
    taskRows = [
      task({ id: 'task-1', status: 'completed', workers: [worker({ prNumber: 55, mergedAt: new Date() })] }),
    ];

    const answer = (await explainTask('task-1', ACTOR))!.subjects[0];
    expect(answer.waitingOn).toBeNull();
    expect(answer.nextAction).toBeNull();
    expect(answer.derivedFrom.waitingOn).toBeNull();
  });

  // The claim flips a Claude task to Codex in memory; without this the only
  // trace was a log line, and explain could not say why the backend changed.
  it('says why the claim ran the task on another backend', async () => {
    taskRows = [task({
      id: 'task-1', status: 'in_progress', backend: 'claude',
      context: { backendRouting: { backend: 'codex', from: 'claude', reason: 'claude_seat_exhausted' } },
    })];
    const answer = (await explainTask('task-1', ACTOR))!.subjects[0];
    expect(answer.backendRouting?.summary).toBe('routed to Codex by budget failover (Claude seat exhausted)');
    expect(answer.backendRouting?.backend).toBe('codex');
    expect(answer.derivedFrom.backendRouting).toBe('tasks.context.backendRouting');
  });

  it('leaves backendRouting off when nothing moved the task', async () => {
    taskRows = [task({ id: 'task-1', status: 'pending' })];
    const answer = (await explainTask('task-1', ACTOR))!.subjects[0];
    expect(answer.backendRouting).toBeUndefined();
  });
});

// ─── PR scope: the dirty mission PR ───────────────────────────────────────────

describe('explainPr — a dirty mission PR', () => {
  const openedAt = new Date('2026-01-01T00:00:00.000Z');

  beforeEach(() => {
    taskRows = [
      task({
        id: 'task-mission-pr',
        title: 'Mission PR: Build auth',
        status: 'completed',
        taskClass: 'bookkeeping',
        pathManifest: ['apps/web/src/lib/mission-helpers.ts', 'packages/core/db/schema.ts'],
        workers: [
          worker({
            id: 'worker-mine',
            prNumber: 101,
            branch: 'mission/build-auth',
            prBaseRef: 'dev',
            prLifecycleStatus: 'conflict',
            observedTouches: ['apps/web/src/lib/mission-helpers.ts'],
          }),
        ],
      }),
      // The dev-side task whose merge is the cause.
      task({
        id: 'task-theirs',
        title: 'Collapse the state chips',
        status: 'completed',
        pathManifest: ['apps/web/src/lib/mission-helpers.ts'],
      }),
    ];
    workerRows = [
      {
        id: 'worker-theirs',
        taskId: 'task-theirs',
        prNumber: 98,
        branch: 'buildd/collapse-chips',
        mergedAt: new Date('2026-01-01T12:00:00.000Z'),
        lastCommitSha: '0123456789abcdef0123',
        observedTouches: ['apps/web/src/lib/mission-helpers.ts'],
      },
    ];
  });

  const subject = {
    id: 'worker-mine',
    taskId: 'task-mission-pr',
    workspaceId: 'ws-1',
    prNumber: 101,
    prUrl: 'https://example.invalid/101',
    branch: 'mission/build-auth',
    prBaseRef: 'dev',
    prLifecycleStatus: 'conflict',
    conflictDetectedAt: new Date('2026-01-02T00:00:00.000Z'),
    prOpenedBaseSha: 'abcdef0123456789abcd',
    mergedAt: null,
    observedTouches: ['apps/web/src/lib/mission-helpers.ts'],
    createdAt: openedAt,
  };

  it('returns a populated because[] naming the conflicting path and the dev-side PR', async () => {
    const result = await explainPr(subject, ACTOR);
    const answer = result!.subjects[0];

    expect(answer.because.length).toBeGreaterThan(1);
    const claims = answer.because.map(l => l.claim).join('\n');

    // commits-behind-base
    expect(claims).toContain('1 PR(s) merged into `dev` after PR #101 opened');
    // the conflicting paths
    expect(claims).toContain('apps/web/src/lib/mission-helpers.ts');
    // the dev-side PR / commits that touch them
    expect(claims).toContain('PR #98');

    const devSide = answer.because.find(l => l.refs.prNumber === 98);
    expect(devSide).toBeDefined();
    expect(devSide!.refs.commitSha).toBe('0123456789abcdef0123');
    expect(devSide!.refs.paths).toEqual(['apps/web/src/lib/mission-helpers.ts']);

    // Chain stays contiguously ordered after the conflict links are prepended.
    expect(answer.because.map(l => l.order)).toEqual(answer.because.map((_, i) => i + 1));
  });

  it('derives the touch set from stored rows — no merge attempt, no GitHub call', async () => {
    await explainPr(subject, ACTOR);
    // Only the base-side merge query ran against workers; nothing shelled out.
    expect(mockWorkersFindMany).toHaveBeenCalled();
    const devSideCall = mockWorkersFindMany.mock.calls.length;
    expect(devSideCall).toBeGreaterThan(0);
  });

  it('labels the commits-behind count as a floor, not a rev-list', async () => {
    const answer = (await explainPr(subject, ACTOR))!.subjects[0];
    const countLink = answer.because.find(l => l.claim.includes('merged into `dev` after'));
    expect(countLink!.derivedFrom).toContain('floor');
  });

  it('skips the conflict chain for a PR that is not conflicted', async () => {
    taskRows[0].workers[0].prLifecycleStatus = 'pr_open';
    const answer = (await explainPr({ ...subject, prLifecycleStatus: 'pr_open' }, ACTOR))!.subjects[0];
    expect(answer.because.map(l => l.claim).join('\n')).not.toContain('merged into `dev` after');
  });

  it('carries the owning task\'s gate history so a stalled PR shows why', async () => {
    gateEventRows = [
      {
        taskId: 'task-mission-pr',
        gate: 'merge_base_freshness',
        outcome: 'rejected',
        reason: 'behind_base',
        occurredAt: new Date('2026-01-03T00:00:00.000Z'),
        detail: null,
      },
    ];
    const answer = (await explainPr(subject, ACTOR))!.subjects[0];
    expect(answer.gateHistory).toHaveLength(1);
    expect(answer.gateHistory[0].gate).toBe('merge_base_freshness');
    expect(answer.derivedFrom.gateHistory).toBe('gate_events.taskId');
  });

  it('refuses a PR with no task attached rather than inventing a subject', async () => {
    expect(await explainPr({ ...subject, taskId: null }, ACTOR)).toBeNull();
  });
});

// ─── Workspace scope ──────────────────────────────────────────────────────────

describe('explainWorkspace', () => {
  it('returns only the gated subjects, and reports how many were quiet', async () => {
    missionRow = { id: 'mission-1', title: 'Build auth', workspaceId: 'ws-1', status: 'active', schedule: null };
    taskRows = [task({ id: 'task-open', status: 'pending', title: 'Write the migration' })];
    completionDecision = {
      ok: false,
      code: 'pending_deliverables',
      reason: '1 open',
      pendingDeliverables: 1,
      pendingByStatus: { pending: 1 },
      awaitingMergeDetails: [],
    };

    const result = await explainWorkspace('ws-1', ACTOR);
    expect(result.scope).toBe('workspace');
    expect(result.subjects.length).toBeGreaterThan(0);
    for (const s of result.subjects) {
      expect(s.waitingOn).not.toBeNull();
    }
    expect(result.considered).toBeGreaterThanOrEqual(result.subjects.length);
    expect(result.quiet).toBeGreaterThanOrEqual(0);
  });

  it('caps the active-missions scan so the fan-out cannot be unbounded', async () => {
    missionRow = { id: 'mission-1', title: 'Build auth', workspaceId: 'ws-1', status: 'active', schedule: null };
    taskRows = [];

    await explainWorkspace('ws-1', ACTOR);

    // The only findMany caller on `missions` — explainMission's own dependency
    // lookup goes through findFirst. A missing limit here means a workspace
    // with hundreds of active missions fans out one explainMission() call
    // (several queries each) per mission before the subject-ranking cut ever
    // applies, unbounded by the same 200-row cap the tasks query below has.
    const [args] = mockMissionsFindMany.mock.calls.at(-1) as unknown as [Row];
    expect(args.limit).toBe(200);
  });

  it('returns an empty subject list when nothing is blocked', async () => {
    missionRow = { id: 'mission-1', title: 'Build auth', workspaceId: 'ws-1', status: 'active', schedule: null };
    taskRows = [task({ id: 'task-done', status: 'completed' })];

    const result = await explainWorkspace('ws-1', ACTOR);
    expect(result.subjects).toEqual([]);
    expect(result.quiet).toBe(result.considered);
  });

  it('fans out across missions concurrently rather than one at a time', async () => {
    missionRows = Array.from({ length: 5 }, (_, i) => ({
      id: `mission-${i}`,
      title: `Mission ${i}`,
      workspaceId: 'ws-1',
      status: 'active',
      schedule: null,
    }));
    taskRows = missionRows.map((m, i) =>
      task({ id: `task-${i}`, missionId: m.id, status: 'completed' }),
    );

    await explainWorkspace('ws-1', ACTOR);

    // A sequential `for...await` loop would never have more than one
    // `canCompleteMission` call in flight at once.
    expect(maxInFlightCanCompleteMission).toBeGreaterThan(1);
  });

  // Friction 1dd98bb2: closed-unmerged PRs from months ago ranked ahead of a
  // genuinely open PR from today, burying the live ask under dead ones. Titles
  // are chosen so alphabetical tie-break would put the closed one FIRST if the
  // rank were not fixed — the ordering below can only hold if the two now
  // carry different ranks.
  it('ranks a live open PR above a PR that closed without merging, not below it', async () => {
    taskRows = [
      task({
        id: 'task-old-closed', missionId: null, title: 'Ancient task',
        workers: [worker({ id: 'w-old', prNumber: 34, prUrl: 'https://example.invalid/34', prLifecycleStatus: 'closed' })],
      }),
      task({
        id: 'task-new-open', missionId: null, title: 'Zebra task',
        workers: [worker({ id: 'w-new', prNumber: 900, prUrl: 'https://example.invalid/900' })],
      }),
    ];

    const result = await explainWorkspace('ws-1', ACTOR);
    const openIdx = result.subjects.findIndex(s => s.subject.taskId === 'task-new-open');
    const closedIdx = result.subjects.findIndex(s => s.subject.taskId === 'task-old-closed');
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(closedIdx).toBeGreaterThanOrEqual(0);
    expect(openIdx).toBeLessThan(closedIdx);
    expect(result.subjects[openIdx].waitingOn?.kind).toBe('merge');
    expect(result.subjects[closedIdx].waitingOn?.kind).toBe('pr_closed_unmerged');
  });
});

// ─── Fix-attempt lineage ──────────────────────────────────────────────────────

describe('explain — fix-attempt lineage', () => {
  // T opened PR 10. Its CI fix could not resume the branch and opened PR 11 on
  // a new branch; that attempt was itself fixed by a third task.
  const evidence = {
    errorClass: 'test_failure',
    keyLines: ['(fail) billing > rounds up', 'error: expected 2 received 3', 'line 3', 'line 4'],
    diff: { files: 0, added: 0, removed: 0 },
    links: {},
    keyLinesSource: 'traces',
    capturedAt: '2026-01-02T00:00:00.000Z',
  };

  beforeEach(() => {
    taskRows = [
      task({
        id: 'root', title: 'Fix rounding', status: 'completed', missionId: null,
        workers: [worker({ id: 'w-root', prNumber: 10, prLifecycleStatus: 'ci_failed' })],
      }),
      task({
        id: 'fix-1', title: '[CI] Fix rounding', taskClass: 'attempt', parentTaskId: 'root', status: 'failed', missionId: null,
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
        result: { error: 'boom', evidence, mismatch: [{ kind: 'last_command_failed', detail: 'bun run test exited 1' }] },
        context: { rootTaskId: 'root', lineagePrNumbers: [10] },
        workers: [worker({ id: 'w-fix-1', prNumber: 11, prLifecycleStatus: 'ci_failed' })],
      }),
      task({
        id: 'fix-2', title: '[CI] Fix rounding #2', taskClass: 'attempt', parentTaskId: 'fix-1', status: 'completed', missionId: null,
        createdAt: new Date('2026-01-03T00:00:00.000Z'),
        workers: [worker({ id: 'w-fix-2', prNumber: 11 })],
      }),
    ];
  });

  const prSubject = (over: Record<string, unknown> = {}) => ({
    id: 'w-fix-1', taskId: 'fix-1', workspaceId: 'ws-1', prNumber: 11, prUrl: null, branch: 'b',
    prBaseRef: 'dev', prLifecycleStatus: 'ci_failed', conflictDetectedAt: null, prOpenedBaseSha: null,
    mergedAt: null, observedTouches: null, createdAt: new Date('2026-01-02T00:00:00.000Z'), ...over,
  });

  it('explain on the new-branch PR returns the predecessor PR and every attempt with its outcome', async () => {
    const answer = (await explainPr(prSubject(), ACTOR))!.subjects[0];
    expect(answer.history.map(h => h.taskId)).toEqual(['root']);
    const root = answer.history[0];
    expect(root.prNumber).toBe(10);
    expect(root.attempts.map(a => a.taskId)).toEqual(['fix-1']);
    const fix1 = root.attempts[0];
    expect(fix1.prNumber).toBe(11);
    expect(fix1.status).toBe('failed');
    expect(fix1.attempts.map(a => a.taskId)).toEqual(['fix-2']);
  });

  it('carries each attempt\'s errorClass, first key lines and mismatch', async () => {
    const fix1 = (await explainPr(prSubject(), ACTOR))!.subjects[0].history[0].attempts[0];
    expect(fix1.evidence?.errorClass).toBe('test_failure');
    expect(fix1.evidence?.keyLines).toEqual(['(fail) billing > rounds up', 'error: expected 2 received 3', 'line 3']);
    expect(fix1.mismatch?.[0].kind).toBe('last_command_failed');
  });

  it('answers the same history from the root task and from a nested attempt', async () => {
    const fromRoot = (await explainTask('root', ACTOR))!.subjects[0].history;
    const fromNested = (await explainTask('fix-2', ACTOR))!.subjects[0].history;
    expect(fromNested).toEqual(fromRoot);
    expect(fromRoot[0].attempts[0].attempts[0].taskId).toBe('fix-2');
  });

  it('omits evidence and mismatch on a clean attempt', async () => {
    const fix2 = (await explainTask('root', ACTOR))!.subjects[0].history[0].attempts[0].attempts[0];
    expect('evidence' in fix2).toBe(false);
    expect('mismatch' in fix2).toBe(false);
  });
});


describe('visual task browser claimability explanation', () => {
  it('names missing browser capability instead of silently leaving a queued visual task', async () => {
    browserHeartbeats = [];
    taskRows = [task({ status: 'pending', roleSlug: 'visual-auditor' })];
    const answer = (await explainTask('task-1', ACTOR))!.subjects[0];
    expect(answer.because.map(l => l.claim).join(' ')).toContain('browser capability');
  });
  it('does not invent a missing browser when the capability read failed', async () => {
    browserHeartbeats = null;
    taskRows = [task({ status: 'pending', roleSlug: 'visual-auditor' })];
    const answer = (await explainTask('task-1', ACTOR))!.subjects[0];
    expect(answer.because.map(l => l.claim).join(' ')).not.toContain('missing browser capability');
    browserHeartbeats = [];
  });
});
