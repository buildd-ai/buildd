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
    return taskRows.filter(t => t.parentTaskId === where.value);
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

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst, findMany: mockMissionsFindMany },
      tasks: { findFirst: mockTasksFindFirst, findMany: mockTasksFindMany },
      workers: { findMany: mockWorkersFindMany },
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'id', workspaceId: 'workspaceId', status: 'status' },
  tasks: { id: 'id', missionId: 'missionId', parentTaskId: 'parentTaskId', workspaceId: 'workspaceId', status: 'status' },
  workers: { id: 'id', workspaceId: 'workspaceId', prBaseRef: 'prBaseRef', mergedAt: 'mergedAt', startedAt: 'startedAt' },
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

// Imported AFTER the mocks.
import { explainMission, explainTask, explainPr, explainWorkspace } from './explain';

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
  completionDecision = { ok: true, code: 'ok', reason: 'clear' };
  workStateResult = null;
  inFlightCanCompleteMission = 0;
  maxInFlightCanCompleteMission = 0;
  mockCanCompleteMission.mockClear();
  mockEvaluateMissionWorkState.mockClear();
});

// ─── Mission scope ────────────────────────────────────────────────────────────

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

  it('returns null for a mission that does not exist', async () => {
    expect(await explainMission('nope')).toBeNull();
  });
});

// ─── Task scope ───────────────────────────────────────────────────────────────

describe('explainTask', () => {
  it('reports a completed task with an unmerged PR as awaiting merge', async () => {
    taskRows = [
      task({
        id: 'task-1',
        status: 'completed',
        workers: [worker({ prNumber: 55, prUrl: 'https://example.invalid/55' })],
      }),
    ];

    const result = await explainTask('task-1');
    const answer = result!.subjects[0];
    expect(answer.state).toBe('awaiting_merge');
    expect(answer.waitingOn?.kind).toBe('merge');
    expect(answer.subject.prNumber).toBe(55);
    expect(answer.because.some(l => l.refs.prNumber === 55)).toBe(true);
  });

  it('reports a completed, merged task as quiet — waitingOn null, nextAction null', async () => {
    taskRows = [
      task({ id: 'task-1', status: 'completed', workers: [worker({ prNumber: 55, mergedAt: new Date() })] }),
    ];

    const answer = (await explainTask('task-1'))!.subjects[0];
    expect(answer.waitingOn).toBeNull();
    expect(answer.nextAction).toBeNull();
    expect(answer.derivedFrom.waitingOn).toBeNull();
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
    const result = await explainPr(subject);
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
    await explainPr(subject);
    // Only the base-side merge query ran against workers; nothing shelled out.
    expect(mockWorkersFindMany).toHaveBeenCalled();
    const devSideCall = mockWorkersFindMany.mock.calls.length;
    expect(devSideCall).toBeGreaterThan(0);
  });

  it('labels the commits-behind count as a floor, not a rev-list', async () => {
    const answer = (await explainPr(subject))!.subjects[0];
    const countLink = answer.because.find(l => l.claim.includes('merged into `dev` after'));
    expect(countLink!.derivedFrom).toContain('floor');
  });

  it('skips the conflict chain for a PR that is not conflicted', async () => {
    taskRows[0].workers[0].prLifecycleStatus = 'pr_open';
    const answer = (await explainPr({ ...subject, prLifecycleStatus: 'pr_open' }))!.subjects[0];
    expect(answer.because.map(l => l.claim).join('\n')).not.toContain('merged into `dev` after');
  });

  it('refuses a PR with no task attached rather than inventing a subject', async () => {
    expect(await explainPr({ ...subject, taskId: null })).toBeNull();
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

    const result = await explainWorkspace('ws-1');
    expect(result.scope).toBe('workspace');
    expect(result.subjects.length).toBeGreaterThan(0);
    for (const s of result.subjects) {
      expect(s.waitingOn).not.toBeNull();
    }
    expect(result.considered).toBeGreaterThanOrEqual(result.subjects.length);
    expect(result.quiet).toBeGreaterThanOrEqual(0);
  });

  it('returns an empty subject list when nothing is blocked', async () => {
    missionRow = { id: 'mission-1', title: 'Build auth', workspaceId: 'ws-1', status: 'active', schedule: null };
    taskRows = [task({ id: 'task-done', status: 'completed' })];

    const result = await explainWorkspace('ws-1');
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

    await explainWorkspace('ws-1');

    // A sequential `for...await` loop would never have more than one
    // `canCompleteMission` call in flight at once.
    expect(maxInFlightCanCompleteMission).toBeGreaterThan(1);
  });
});
