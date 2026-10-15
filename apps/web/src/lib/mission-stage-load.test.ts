import { describe, expect, it, mock, beforeEach } from 'bun:test';

// Predicate builders record their arguments, so the test asserts each read's
// scope (CLAUDE.md: a mocked db hides WHERE scoping unless the predicates are
// observable).
mock.module('drizzle-orm', () => ({
  and: (...args: any[]) => ({ type: 'and', args }),
  inArray: (field: any, values: any[]) => ({ type: 'inArray', field, values }),
  isNotNull: (field: any) => ({ type: 'isNotNull', field }),
}));
mock.module('@buildd/core/db/relational-sql', () => ({ sqlWhere: (expr: any) => expr }));
mock.module('@buildd/core/db/schema', () => ({
  missions: { id: 'missions.id', workspaceId: 'missions.workspaceId' },
  tasks: { missionId: 'tasks.missionId', workspaceId: 'tasks.workspaceId' },
  workers: {
    taskId: 'workers.taskId', prUrl: 'workers.prUrl', prNumber: 'workers.prNumber',
    mergedAt: 'workers.mergedAt', prLifecycleStatus: 'workers.prLifecycleStatus',
  },
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

const { loadMissionStages } = await import('./mission-stage-load');

const ws = { name: 'buildd', gitConfig: { defaultBranch: 'dev' }, releaseConfig: null };
const mission = (over: any = {}) => ({
  id: 'm1', status: 'active', isHeld: false, integrationBranchEnabled: false, workingBranch: null,
  goalCriteria: [{ type: 'command', command: 'bun run test', label: 'Unit tests pass' }], goalCriteriaState: null,
  mergePolicy: null, releasedAt: null, workspace: ws, ...over,
});
const task = (over: any = {}) => ({
  id: 't1', missionId: 'm1', title: 'Build it', status: 'completed', taskClass: 'work', kind: 'engineering',
  mode: 'execution', category: 'feature', roleSlug: 'builder', context: null, ...over,
});

beforeEach(() => {
  missionsFindMany.mockClear();
  tasksFindMany.mockClear();
  selectCalls.length = 0;
  missionRows = [];
  taskRows = [];
  workerRows = [];
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
    // Workers: only the tasks those scoped reads returned, and only PR-bearing rows.
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0].where).toEqual({ type: 'and', args: [
      { type: 'inArray', field: 'workers.taskId', values: ['t1'] },
      { type: 'isNotNull', field: 'workers.prUrl' },
    ] });
  });

  it('is three reads however many missions are listed (no N+1)', async () => {
    missionRows = [mission({ id: 'a' }), mission({ id: 'b' }), mission({ id: 'c' })];
    taskRows = [task({ id: 'ta', missionId: 'a' }), task({ id: 'tb', missionId: 'b' }), task({ id: 'tc', missionId: 'c' })];
    const stages = await loadMissionStages(['a', 'b', 'c'], ['ws-1']);
    expect(missionsFindMany).toHaveBeenCalledTimes(1);
    expect(tasksFindMany).toHaveBeenCalledTimes(1);
    expect(selectCalls).toHaveLength(1);
    expect([...stages.keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  it('AC-7 through the loader: build done and criteria pending is verifying', async () => {
    missionRows = [mission()];
    taskRows = [task({ id: 't1' }), task({ id: 't2' })];
    workerRows = [{ taskId: 't1', prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: '2026-10-14T10:00:00.000Z', prLifecycleStatus: 'merged' }];
    const stages = await loadMissionStages(['m1'], ['ws-1']);
    expect(stages.get('m1')).toEqual({ step: 'verifying', waitingOn: 'Unit tests pass: not checked' });
  });

  it('a direct mission whose audit completed (pass or findings) is verifying, not delivered, until the mission completes', async () => {
    const merged = { prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: '2026-10-14T10:00:00.000Z', prLifecycleStatus: 'merged' };
    const rows = [task({ id: 't1' }), task({ id: 'a1', title: '[surface audit] check the screens', roleSlug: 'visual-auditor', createdAt: '2026-10-14T11:00:00.000Z' })];
    missionRows = [mission({ goalCriteria: [] })];
    taskRows = rows;
    workerRows = [{ taskId: 't1', ...merged }];
    expect((await loadMissionStages(['m1'], ['ws-1'])).get('m1')).toEqual({ step: 'verifying', waitingOn: 'see the mission page' });
    expect(tasksFindMany.mock.calls[0][0].columns.createdAt).toBe(true);

    missionRows = [mission({ goalCriteria: [], status: 'completed' })];
    expect((await loadMissionStages(['m1'], ['ws-1'])).get('m1')).toEqual({ step: 'delivered', waitingOn: null });
  });

  it('an unmerged PR keeps the build open', async () => {
    missionRows = [mission()];
    taskRows = [task({ id: 't1' })];
    workerRows = [{ taskId: 't1', prUrl: 'https://example.test/pr/1', prNumber: 1, mergedAt: null, prLifecycleStatus: 'pr_open' }];
    expect((await loadMissionStages(['m1'], ['ws-1'])).get('m1')).toEqual({ step: 'building', waitingOn: '0 of 1 landed' });
  });

  it('reads nothing with no missions or no workspaces', async () => {
    expect((await loadMissionStages([], ['ws-1'])).size).toBe(0);
    expect((await loadMissionStages(['m1'], [])).size).toBe(0);
    expect(missionsFindMany).not.toHaveBeenCalled();
    expect(tasksFindMany).not.toHaveBeenCalled();
  });
});
