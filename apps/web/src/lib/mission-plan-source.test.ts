import { describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ESTIMATOR_VERSION } from '@buildd/core/task-estimate';

let estimatePredicate: any;
mock.module('@buildd/core/db', () => ({ db: {
  query: { missions: { findMany: async () => [{
    id: 'm1', title: 'M', status: 'active', workspaceId: null, isHeld: false,
    tasks: [{ id: 't1', title: 'Task', status: 'pending', dependsOn: [], updatedAt: null, workers: [], context: {} }],
  }] } },
  select: () => ({ from: () => ({ where: (predicate: any) => {
    estimatePredicate = predicate;
    return { orderBy: async () => [] };
  } }) }),
} }));
const { missionPlanInputs, planBlock, loadMissionPlan } = await import('./mission-plan-source');

describe('planBlock', () => {
  it('a mission the list files under Needs you waits on you; held is held; the rest are free', () => {
    expect(planBlock('needs', false)).toBe('you');
    expect(planBlock('notlanded', false)).toBe('you');
    expect(planBlock('held', false)).toBe('held');
    expect(planBlock('build', true)).toBe('held');
    expect(planBlock('build', false)).toBeNull();
    expect(planBlock('waiting', false)).toBeNull();
  });
});

describe('missionPlanInputs', () => {
  it('carries the newest estimate, first run and merge time onto each task', () => {
    const [m] = missionPlanInputs([{
      id: 'm1', title: 'M', workspaceId: 'w', dependsOnMissionId: 'm0', isHeld: false,
      tasks: [
        { id: 't1', status: 'completed', dependsOn: null, updatedAt: '2026-10-06T10:00:00Z', workers: [{ startedAt: '2026-10-06T08:00:00Z', completedAt: '2026-10-06T09:00:00Z' }] },
        { id: 't2', status: 'pending', dependsOn: ['t1'], updatedAt: null },
      ],
    }], new Map([['t2', { p50Minutes: 30, p80Minutes: 60 }]]), new Map([['m1', 'build']]));
    expect(m).toMatchObject({ href: '/app/missions/m1', blocked: null, dependsOnMissionId: 'm0' });
    expect(m.tasks[0]).toMatchObject({ startedAt: Date.parse('2026-10-06T08:00:00Z'), endedAt: Date.parse('2026-10-06T09:00:00Z'), p50Minutes: null });
    expect(m.tasks[1]).toMatchObject({ startedAt: null, endedAt: null, dependsOn: ['t1'], p50Minutes: 30, p80Minutes: 60 });
  });
});


describe('loadMissionPlan calibration version safety', () => {
  it('selects only forecasts from the running estimator version', async () => {
    await loadMissionPlan(undefined, Date.now());
    const query = new PgDialect().sqlToQuery(estimatePredicate);
    expect(query.sql).toContain('"estimator_version" =');
    expect(query.params).toContain(ESTIMATOR_VERSION);
    expect(query.params).toContain('t1');
  });
});
