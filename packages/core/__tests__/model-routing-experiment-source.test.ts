import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * The claim-route glue for the model-routing experiment.
 *
 * Scope predicates are rendered to SQL with the real PgDialect — a mocked
 * `drizzle-orm` would accept a predicate on the wrong column, and the draw
 * would then read another team's experiment or another experiment's rows.
 * Only the db CLIENT is stubbed; drizzle and the schema are real.
 */

const fake = {
  experimentRows: [] as any[],
  priorRows: [] as any[],
  inserted: [] as any[],
  conflictTargets: [] as any[],
  selectCalls: 0,
  throwOnSelect: false,
  throwOnInsert: false,
};

mock.module('../db/client', () => ({
  db: {
    select: () => ({
      from: (table: any) => ({
        where: async () => {
          fake.selectCalls++;
          if (fake.throwOnSelect) throw new Error('db down');
          const name = table?.[Symbol.for('drizzle:Name')];
          return name === 'experiments' ? fake.experimentRows : fake.priorRows;
        },
      }),
    }),
    insert: () => ({
      values: (v: any) => ({
        onConflictDoNothing: async (opts: any) => {
          if (fake.throwOnInsert) throw new Error('insert failed');
          fake.inserted.push(v);
          fake.conflictTargets.push(opts?.target);
        },
      }),
    }),
  },
}));

const src = await import('../model-routing-experiment-source');
const { experimentAssignments } = await import('../db/schema');

const dialect = new PgDialect();
const render = (fragment: any) => {
  const q = dialect.sqlToQuery(fragment);
  return { sql: q.sql.replace(/\s+/g, ' ').trim().toLowerCase(), params: q.params };
};

const EXP_ID = '5b0f6c1e-0000-4000-8000-00000000000a';
const running = (over: Record<string, unknown> = {}) => ({
  id: EXP_ID, kind: 'model_routing', status: 'running', treatmentFraction: 1,
  policyVersion: 1, config: {}, startedAt: new Date('2026-01-01'), ...over,
});

const task = (over: Record<string, unknown> = {}) => ({
  id: 'task-1', missionId: null, parentTaskId: null, taskClass: 'work', category: 'feature',
  kind: 'engineering', complexity: 'normal', tier: null, backend: 'claude', roleSlug: 'builder',
  context: {}, ...over,
});

const drawArgs = (over: Record<string, unknown> = {}) => ({
  teamId: 'team-1', task: task(), explicitModel: null, routerReason: 'baseline',
  routerModel: 'sonnet', roleModel: null, budgetPressure: 0.1, ...over,
}) as any;

beforeEach(() => {
  fake.experimentRows = [];
  fake.priorRows = [];
  fake.inserted = [];
  fake.conflictTargets = [];
  fake.selectCalls = 0;
  fake.throwOnSelect = false;
  fake.throwOnInsert = false;
  src.invalidateModelRoutingExperimentCache();
});

describe('scopes render to the intended predicates', () => {
  it('running experiment: team AND status=running AND kind=model_routing', () => {
    const { sql, params } = render(src.runningExperimentScope('team-1'));
    expect(sql).toContain('"experiments"."team_id" = $1');
    expect(sql).toContain('"experiments"."status" = $2');
    expect(sql).toContain('"experiments"."kind" = $3');
    expect(params).toEqual(['team-1', 'running', 'model_routing']);
  });

  it('prior assignments: experiment AND task_id IN (...) — inArray, not ANY(array)', () => {
    const { sql, params } = render(src.priorAssignmentsScope(EXP_ID, ['a', 'b']));
    expect(sql).toContain('"experiment_assignments"."experiment_id" = $1');
    expect(sql).toContain('"experiment_assignments"."task_id" in ($2, $3)');
    expect(sql).not.toContain('any(');
    expect(params).toEqual([EXP_ID, 'a', 'b']);
  });
});

describe('drawModelRoutingArm', () => {
  it('returns null with no running experiment, and caches that answer', async () => {
    expect(await src.drawModelRoutingArm(drawArgs())).toBeNull();
    expect(await src.drawModelRoutingArm(drawArgs())).toBeNull();
    expect(fake.selectCalls).toBe(1);
  });

  it('returns null without a team (no lookup at all)', async () => {
    expect(await src.drawModelRoutingArm(drawArgs({ teamId: null }))).toBeNull();
    expect(fake.selectCalls).toBe(0);
  });

  it('draws an eligible task into treatment at fraction 1', async () => {
    fake.experimentRows = [running()];
    const d = await src.drawModelRoutingArm(drawArgs());
    expect(d).toMatchObject({
      experimentId: EXP_ID, arm: 'treatment', propensity: 1, unitType: 'task', unitId: 'task-1',
      treatmentTier: 'premium', alreadyRecorded: false, served: false,
    });
    expect(d!.eligibility).toMatchObject({ source: 'drawn', budgetPressure: 0.1, kind: 'engineering', roleSlug: 'builder' });
  });

  it('returns null for an ineligible task', async () => {
    fake.experimentRows = [running()];
    expect(await src.drawModelRoutingArm(drawArgs({ explicitModel: 'claude-sonnet-5' }))).toBeNull();
    expect(await src.drawModelRoutingArm(drawArgs({ budgetPressure: 0.8 }))).toBeNull();
  });

  it('honours eligibility.maxBudgetPressure from the experiment config', async () => {
    fake.experimentRows = [running({ config: { eligibility: { maxBudgetPressure: 0.05 } } })];
    expect(await src.drawModelRoutingArm(drawArgs({ budgetPressure: 0.1 }))).toBeNull();
  });

  it('an attempt inherits its parent\'s arm even though attempts are ineligible to draw', async () => {
    fake.experimentRows = [running({ treatmentFraction: 0 })];
    fake.priorRows = [{ taskId: 'parent-1', unitType: 'mission', unitId: 'm-1', arm: 'treatment', propensity: 0.5 }];
    const d = await src.drawModelRoutingArm(drawArgs({ task: task({ taskClass: 'attempt', parentTaskId: 'parent-1' }) }));
    expect(d).toMatchObject({ arm: 'treatment', propensity: 0.5, unitType: 'mission', unitId: 'm-1', alreadyRecorded: false });
    expect(d!.eligibility.inheritedFromTaskId).toBe('parent-1');
  });

  it('a re-claim reuses its own row and is marked already recorded', async () => {
    fake.experimentRows = [running()];
    fake.priorRows = [{ taskId: 'task-1', unitType: 'task', unitId: 'task-1', arm: 'control', propensity: 0.5 }];
    // explicitModel set — as it is after a first claim wrote context.model.
    const d = await src.drawModelRoutingArm(drawArgs({ explicitModel: 'claude-sonnet-5', routerReason: 'explicit_override' }));
    expect(d).toMatchObject({ arm: 'control', alreadyRecorded: true });
  });

  it('never throws: a db error means "no experiment"', async () => {
    fake.throwOnSelect = true;
    expect(await src.drawModelRoutingArm(drawArgs())).toBeNull();
  });
});

describe('applyModelRoutingTreatment', () => {
  const apply = (draw: any, over: Record<string, unknown> = {}) => src.applyModelRoutingTreatment(draw, {
    controlModel: 'claude-sonnet-5', routerReason: 'baseline', taskTier: null, backend: 'claude',
    resolveTier: async (t) => ({ model: t === 'premium' ? 'claude-opus-5' : 'x', provider: 'anthropic', source: 'default' }),
    clientCanServe: () => true,
    ...over,
  } as any);

  async function treatmentDraw() {
    fake.experimentRows = [running()];
    return (await src.drawModelRoutingArm(drawArgs()))!;
  }

  it('serves the treatment tier and records both models', async () => {
    const d = await treatmentDraw();
    const r = await apply(d);
    expect(r).toMatchObject({ tier: 'premium', model: 'claude-opus-5' });
    expect(d).toMatchObject({ served: true, defaultModel: 'claude-sonnet-5', assignedModel: 'claude-opus-5' });
  });

  it('falls back to control (served=false) when the client cannot serve the treatment model — no deferral', async () => {
    const d = await treatmentDraw();
    const r = await apply(d, { clientCanServe: (m: string) => m !== 'claude-opus-5' });
    expect(r).toBeNull();
    expect(d).toMatchObject({ arm: 'treatment', served: false, assignedModel: 'claude-sonnet-5' });
    expect(d.eligibility.fallback).toBe('client_capability');
  });

  it('keeps control for a control draw', async () => {
    fake.experimentRows = [running({ treatmentFraction: 0 })];
    const d = (await src.drawModelRoutingArm(drawArgs()))!;
    expect(await apply(d)).toBeNull();
    expect(d).toMatchObject({ arm: 'control', served: true, assignedModel: 'claude-sonnet-5' });
  });

  it('does not override a task-pinned tier; marks treatment unserved', async () => {
    const d = await treatmentDraw();
    expect(await apply(d, { taskTier: 'budget' })).toBeNull();
    expect(d.served).toBe(false);
  });

  it('swallows a tier-resolution error and serves control', async () => {
    const d = await treatmentDraw();
    expect(await apply(d, { resolveTier: async () => { throw new Error('registry down'); } })).toBeNull();
    expect(d.served).toBe(false);
  });
});

describe('recordModelRoutingAssignment', () => {
  it('inserts once, idempotent on (experiment_id, task_id)', async () => {
    fake.experimentRows = [running()];
    const d = (await src.drawModelRoutingArm(drawArgs()))!;
    await src.recordModelRoutingAssignment(d, { taskId: 'task-1', runnerCliVersion: '2.1.0', resolvedModel: 'claude-opus-5' });
    expect(fake.inserted).toHaveLength(1);
    expect(fake.inserted[0]).toMatchObject({
      experimentId: EXP_ID, taskId: 'task-1', arm: 'treatment', policyVersion: 1,
      assignedModel: 'claude-opus-5', runnerCliVersion: '2.1.0',
    });
    expect(fake.conflictTargets[0]).toEqual([experimentAssignments.experimentId, experimentAssignments.taskId]);
  });

  it('skips the insert for a row that already exists', async () => {
    fake.experimentRows = [running()];
    fake.priorRows = [{ taskId: 'task-1', unitType: 'task', unitId: 'task-1', arm: 'control', propensity: 0.5 }];
    const d = (await src.drawModelRoutingArm(drawArgs()))!;
    await src.recordModelRoutingAssignment(d, { taskId: 'task-1', runnerCliVersion: null, resolvedModel: 'm' });
    expect(fake.inserted).toHaveLength(0);
  });

  it('never throws on an insert failure', async () => {
    fake.experimentRows = [running()];
    const d = (await src.drawModelRoutingArm(drawArgs()))!;
    fake.throwOnInsert = true;
    await expect(src.recordModelRoutingAssignment(d, { taskId: 'task-1', runnerCliVersion: null, resolvedModel: 'm' })).resolves.toBeUndefined();
  });
});
