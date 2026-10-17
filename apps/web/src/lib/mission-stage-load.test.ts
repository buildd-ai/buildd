import { describe, expect, it, mock, beforeEach } from 'bun:test';

// Predicate builders record their arguments, so the test asserts each read's
// scope (CLAUDE.md: a mocked db hides WHERE scoping unless the predicates are
// observable).
mock.module('drizzle-orm', () => ({
  and: (...args: any[]) => ({ type: 'and', args }),
  inArray: (field: any, values: any[]) => ({ type: 'inArray', field, values }),
  isNotNull: (field: any) => ({ type: 'isNotNull', field }),
}));
mock.module('@buildd/core/db/relational-sql', () => ({ sqlWhere: (expr: any) => expr, sqlExtras: (extras: any) => extras }));
// The narrowed SQL itself is rendered and pinned in mission-stage-sql.test.ts;
// here only that the loader uses it.
mock.module('./mission-stage-sql', () => ({ stageContextSql: 'STAGE_CONTEXT_SQL', stageWorkersPredicate: () => 'STAGE_WORKERS_PREDICATE' }));
mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'missions.id', workspaceId: 'missions.workspaceId' },
  tasks: { missionId: 'tasks.missionId', workspaceId: 'tasks.workspaceId' },
  workers: new Proxy({}, { get: (_t, k) => `workers.${String(k)}` }),
}));

let missionRows: any[] = [];
let taskRows: any[] = [];
let workerRows: any[] = [];
const missionsFindMany = mock(async (_q: any) => missionRows);
const tasksFindMany = mock(async (_q: any) => taskRows);
const selectCalls: Array<{ table: any; where: any }> = [];
mock.module('@buildd/core/db', () => ({
  db: {
    query: { missions: { findMany: missionsFindMany }, tasks: { findMany: tasksFindMany } },
    select: () => {
      const call = { table: null as any, where: null as any };
      selectCalls.push(call);
      const chain: any = {
        from: (t: any) => { call.table = t; return chain; },
        where: (w: any) => { call.where = w; return Promise.resolve(workerRows); },
      };
      return chain;
    },
  },
}));

// The page's own loads, by id: each records what it was asked for and answers from the test.
let deliveries = new Map<string, any>();
let depRows = new Map<string, any>();
let released = new Map<string, any[]>();
const mockDeliveries = mock(async (_ids: string[]) => deliveries);
const mockDepRows = mock(async (_ids: readonly string[]) => depRows);
const mockReleased = mock(async (_m: readonly string[], _w: readonly string[]) => released);
let mockViews: Map<string, unknown> = new Map();
mock.module('./workflow/delivery-view', () => ({ getOwnerDeliveryDisplays: mockDeliveries, getDeliveryViewsForTasks: async () => mockViews }));
mock.module('./dependency-rows', () => ({ loadDependencyRows: mockDepRows }));
mock.module('./mission-board-waiting', () => ({ loadMissionsReleasedEdges: mockReleased }));

const { loadMissionStages } = await import('./mission-stage-load');
const { buildMissionBoard, toBoardTaskInput } = await import('./mission-board');
const { overviewProgress } = await import('./mission-overview');

const ws = { name: 'buildd', gitConfig: { defaultBranch: 'dev' }, releaseConfig: null };
const mission = (over: any = {}) => ({
  id: 'm1', status: 'active', isHeld: false, integrationBranchEnabled: false, workingBranch: null,
  goalCriteria: [{ type: 'command', command: 'bun run test', label: 'Unit tests pass' }], goalCriteriaState: null,
  mergePolicy: null, releasedAt: null, workspace: ws, ...over,
});
const task = (over: any = {}) => ({
  id: 't1', missionId: 'm1', title: 'Build it', status: 'completed', taskClass: 'work', kind: 'engineering',
  mode: 'execution', category: 'feature', roleSlug: 'builder', stageContext: null, ...over,
});

beforeEach(() => {
  missionsFindMany.mockClear();
  tasksFindMany.mockClear();
  selectCalls.length = 0;
  missionRows = [];
  taskRows = [];
  workerRows = [];
  deliveries = new Map();
  mockViews = new Map();
  depRows = new Map();
  released = new Map();
  mockDeliveries.mockClear();
  mockDepRows.mockClear();
  mockReleased.mockClear();
});

describe('loadMissionStages', () => {
  it('scopes every read to the listed missions and the caller\'s workspaces', async () => {
    missionRows = [mission()];
    taskRows = [task()];
    await loadMissionStages(['m1', 'm2'], ['ws-1']);

    const mq = missionsFindMany.mock.calls[0][0];
    expect(mq.where).toEqual({ type: 'and', args: [
      { type: 'inArray', field: 'missions.id', values: ['m1', 'm2'] },
      { type: 'inArray', field: 'missions.workspaceId', values: ['ws-1'] },
    ] });
    const tq = tasksFindMany.mock.calls[0][0];
    expect(tq.where).toEqual({ type: 'and', args: [
      { type: 'inArray', field: 'tasks.missionId', values: ['m1', 'm2'] },
      { type: 'inArray', field: 'tasks.workspaceId', values: ['ws-1'] },
    ] });
    // Workers: only the tasks those scoped reads returned, narrowed to the newest
    // few per task plus every PR-bearing one.
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0].where).toEqual({ type: 'and', args: [
      { type: 'inArray', field: 'workers.taskId', values: ['t1'] },
      'STAGE_WORKERS_PREDICATE',
    ] });
  });

  it('never reads the whole task context: only the projected keys the stage reads', async () => {
    missionRows = [mission()];
    taskRows = [task()];
    await loadMissionStages(['m1'], ['ws-1']);
    const tq = tasksFindMany.mock.calls[0][0];
    expect(tq.columns.context).toBeUndefined();
    expect(tq.extras).toEqual({ stageContext: 'STAGE_CONTEXT_SQL' });
  });

  it('the projected context still decides what a task is for: a trunk refresh never counts toward the build', async () => {
    missionRows = [mission({ goalCriteria: [] })];
    const merged = { prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: '2026-10-14T10:00:00.000Z', prLifecycleStatus: 'merged' };
    taskRows = [
      task({ id: 't1' }),
      task({ id: 'r1', title: 'Bring the branch up to date', status: 'in_progress', stageContext: { refreshTrunk: 'dev' } }),
    ];
    workerRows = [{ taskId: 't1', ...merged }];
    const stage = (await loadMissionStages(['m1'], ['ws-1'])).get('m1');
    expect(stage?.waitingOn).not.toBe('1 of 2 landed');
  });

  it('is a fixed number of reads however many missions are listed (no N+1)', async () => {
    missionRows = [mission({ id: 'a' }), mission({ id: 'b' }), mission({ id: 'c' })];
    taskRows = [task({ id: 'ta', missionId: 'a' }), task({ id: 'tb', missionId: 'b' }), task({ id: 'tc', missionId: 'c' })];
    const stages = await loadMissionStages(['a', 'b', 'c'], ['ws-1']);
    expect(missionsFindMany).toHaveBeenCalledTimes(1);
    expect(tasksFindMany).toHaveBeenCalledTimes(1);
    expect(selectCalls).toHaveLength(1);
    // The page's own loads: one each for every mission together (no dependency to load here).
    expect(mockDeliveries).toHaveBeenCalledTimes(1);
    expect(mockReleased).toHaveBeenCalledTimes(1);
    expect(mockDepRows).not.toHaveBeenCalled();
    expect([...stages.keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  it('AC-7 through the loader: build done and criteria pending is verifying', async () => {
    missionRows = [mission()];
    taskRows = [task({ id: 't1' }), task({ id: 't2' })];
    workerRows = [{ taskId: 't1', prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: '2026-10-14T10:00:00.000Z', prLifecycleStatus: 'merged' }];
    const stages = await loadMissionStages(['m1'], ['ws-1']);
    expect(stages.get('m1')).toMatchObject({ step: 'verifying', waitingOn: 'Unit tests pass: not checked' });
  });

  it('a direct mission whose audit completed (pass or findings) is verifying, not delivered, until the mission completes', async () => {
    const merged = { prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: '2026-10-14T10:00:00.000Z', prLifecycleStatus: 'merged' };
    const rows = [task({ id: 't1' }), task({ id: 'a1', title: '[surface audit] check the screens', roleSlug: 'visual-auditor', createdAt: '2026-10-14T11:00:00.000Z' })];
    missionRows = [mission({ goalCriteria: [] })];
    taskRows = rows;
    workerRows = [{ taskId: 't1', ...merged }];
    expect((await loadMissionStages(['m1'], ['ws-1'])).get('m1')).toMatchObject({ step: 'verifying', waitingOn: 'see the mission page' });
    expect(tasksFindMany.mock.calls[0][0].columns.createdAt).toBe(true);

    missionRows = [mission({ goalCriteria: [], status: 'completed' })];
    expect((await loadMissionStages(['m1'], ['ws-1'])).get('m1')).toMatchObject({ step: 'delivered', waitingOn: null });
  });

  it('an unmerged PR keeps the build open', async () => {
    missionRows = [mission()];
    taskRows = [task({ id: 't1' })];
    workerRows = [{ taskId: 't1', prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: null, prLifecycleStatus: 'pr_open' }];
    expect((await loadMissionStages(['m1'], ['ws-1'])).get('m1')).toMatchObject({ step: 'building', waitingOn: '0 of 1 landed' });
  });

  it('a kernel-owned delivery that merged its PR lands the task over an open worker row', async () => {
    missionRows = [mission()];
    taskRows = [task({ id: 't1' })];
    workerRows = [{ taskId: 't1', prUrl: 'https://github.com/o/r/pull/1', prNumber: 1, mergedAt: null, prLifecycleStatus: 'pr_open' }];
    mockViews = new Map([['t1', { ownerTaskId: 't1', prNumber: 1, state: 'MERGED', prState: 'merged', mergedAt: '2026-10-14T10:00:00.000Z', headline: 'Landed', repoFullName: 'o/r' }]]);
    expect((await loadMissionStages(['m1'], ['ws-1'])).get('m1')).not.toMatchObject({ waitingOn: '0 of 1 landed' });
  });

  it('a worker without a PR counts for progress, never as a PR for the stage', async () => {
    missionRows = [mission()];
    taskRows = [task({ id: 't1', status: 'in_progress' })];
    workerRows = [{ id: 'w1', taskId: 't1', status: 'running', startedAt: '2026-10-14T10:00:00.000Z', prUrl: null, prNumber: null, mergedAt: null, prLifecycleStatus: null }];
    const stage = (await loadMissionStages(['m1'], ['ws-1'])).get('m1');
    expect(stage?.step).toBe('building');
    expect(stage?.progress).toEqual([{ state: 'running', group: 'active' }]);
  });

  it('R-29: each mission carries its progress cells, done first, organizer runs excluded', async () => {
    const merged = { prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: '2026-10-14T10:00:00.000Z', prLifecycleStatus: 'merged', status: 'completed' };
    missionRows = [mission({ id: 'a' }), mission({ id: 'b' })];
    taskRows = [
      task({ id: 'a-wait', missionId: 'a', status: 'pending', createdAt: '2026-10-14T09:00:00.000Z' }),
      task({ id: 'a-done', missionId: 'a', status: 'completed', createdAt: '2026-10-14T09:01:00.000Z' }),
      task({ id: 'a-plan', missionId: 'a', status: 'in_progress', taskClass: 'bookkeeping', mode: 'planning', roleSlug: 'organizer', kind: 'coordination', title: 'Mission: example' }),
      task({ id: 'b-run', missionId: 'b', status: 'in_progress' }),
    ];
    workerRows = [
      { id: 'w1', taskId: 'a-done', ...merged },
      { id: 'w2', taskId: 'a-plan', status: 'running', prUrl: null },
      { id: 'w3', taskId: 'b-run', status: 'running', prUrl: null },
    ];
    const stages = await loadMissionStages(['a', 'b'], ['ws-1']);
    expect(stages.get('a')?.progress).toEqual([{ state: 'landed', group: 'done' }, { state: 'ready', group: 'waiting' }]);
    expect(stages.get('b')?.progress).toEqual([{ state: 'running', group: 'active' }]);
    // The board reads dependencies and phases, so the task read loads them.
    const cols = tasksFindMany.mock.calls[0][0].columns;
    expect(cols.dependsOn).toBe(true);
    expect(cols.missionPhaseIndex).toBe(true);
  });

  describe('progress parity with the mission page (R-29)', () => {
    const merged = { prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: '2026-10-14T10:00:00.000Z', prLifecycleStatus: 'merged', status: 'completed' };
    const closedPr = { prUrl: 'https://example.test/pr/2', prNumber: 2, mergedAt: null, prLifecycleStatus: 'closed', status: 'completed' };
    const DEP = '00000000-0000-4000-8000-0000000000aa';
    const at = (n: number) => `2026-10-14T09:0${n}:00.000Z`;

    /** The page's board over the same rows and the same loaded inputs. */
    function pageProgress(rows: any[], wk: any[], extra: { externalDeps?: any[]; releasedEdges?: any[] } = {}) {
      const byTask = (id: string) => wk.filter(w => w.taskId === id);
      const board = buildMissionBoard({
        now: Date.parse('2026-10-14T12:00:00.000Z'), missionCreatedAt: 0, missionStatus: 'active',
        tasks: rows.map(t => toBoardTaskInput({ ...t, workers: byTask(t.id), delivery: deliveries.get(t.id) ?? null })),
        externalDeps: extra.externalDeps ?? [],
        gateFacts: { releasedEdges: extra.releasedEdges ?? [], waitingKinds: {} },
      });
      return overviewProgress(board);
    }

    it('a closed, unmerged kernel delivery is a waiting not-landed cell, never a done square', async () => {
      missionRows = [mission()];
      taskRows = [task({ id: 't1', createdAt: at(1) }), task({ id: 't2', createdAt: at(2) })];
      workerRows = [{ id: 'w1', taskId: 't1', ...closedPr }, { id: 'w2', taskId: 't2', ...merged }];
      deliveries = new Map([['t1', { stage: 'closed', state: 'CLOSED_UNMERGED', headline: 'Closed', owner: 'system' }]]);
      const progress = (await loadMissionStages(['m1'], ['ws-1'])).get('m1')!.progress!;
      expect(mockDeliveries.mock.calls[0][0]).toEqual(['t1', 't2']);
      expect(progress).toEqual([{ state: 'landed', group: 'done' }, { state: 'not_landed', group: 'waiting' }]);
      expect(progress).toEqual(pageProgress(taskRows, workerRows));
    });

    it('a delivery that shipped under another PR stays done, as on the page', async () => {
      missionRows = [mission()];
      taskRows = [task({ id: 't1', createdAt: at(1) })];
      workerRows = [{ id: 'w1', taskId: 't1', ...closedPr }];
      deliveries = new Map([['t1', { stage: 'superseded', state: 'SUPERSEDED', headline: 'Shipped elsewhere', owner: 'system' }]]);
      const progress = (await loadMissionStages(['m1'], ['ws-1'])).get('m1')!.progress!;
      expect(progress).toEqual([{ state: 'landed', group: 'done' }]);
      expect(progress).toEqual(pageProgress(taskRows, workerRows));
    });

    it('a dependency in another mission is loaded by id and judged, as the page judges it', async () => {
      missionRows = [mission()];
      taskRows = [task({ id: 't1', status: 'pending', dependsOn: [DEP], createdAt: at(1) })];
      const ext = { id: DEP, title: 'other mission work', status: 'in_progress', workers: [] };
      depRows = new Map([[DEP, ext]]);
      const progress = (await loadMissionStages(['m1'], ['ws-1'])).get('m1')!.progress!;
      expect(mockDepRows.mock.calls[0][0]).toEqual([DEP]);
      expect(progress).toEqual([{ state: 'blocked', group: 'waiting' }]);
      expect(progress).toEqual(pageProgress(taskRows, workerRows, { externalDeps: [ext] }));
    });

    it('an edge the claim gate released reads ready, as on the page; the read is one for every mission', async () => {
      missionRows = [mission(), mission({ id: 'm2' })];
      taskRows = [
        task({ id: 't1', status: 'in_progress', createdAt: at(1) }),
        task({ id: 't2', status: 'pending', dependsOn: ['t1'], createdAt: at(2) }),
        task({ id: 'u1', missionId: 'm2', status: 'pending', createdAt: at(3) }),
      ];
      workerRows = [{ id: 'w1', taskId: 't1', status: 'running', prUrl: null }];
      const edges = [{ dependentId: 't2', dependencyId: 't1', arm: 'early_release' }];
      released = new Map([['m1', edges]]);
      const stages = await loadMissionStages(['m1', 'm2'], ['ws-1']);
      expect(mockReleased).toHaveBeenCalledTimes(1);
      expect(mockReleased.mock.calls[0]).toEqual([['m1', 'm2'], ['ws-1']]);
      const progress = stages.get('m1')!.progress!;
      expect(progress).toEqual(pageProgress(taskRows.filter(t => t.missionId === 'm1'), workerRows, { releasedEdges: edges }));
      expect(progress.find(c => c.group === 'waiting')!.state).toBe('ready');
      // Without the release the same task is held behind its dependency.
      released = new Map();
      expect((await loadMissionStages(['m1'], ['ws-1'])).get('m1')!.progress!.find(c => c.group === 'waiting')!.state).toBe('blocked');
    });
  });

  it('reads nothing with no missions or no workspaces', async () => {
    expect((await loadMissionStages([], ['ws-1'])).size).toBe(0);
    expect((await loadMissionStages(['m1'], [])).size).toBe(0);
    expect(missionsFindMany).not.toHaveBeenCalled();
    expect(tasksFindMany).not.toHaveBeenCalled();
  });
});
