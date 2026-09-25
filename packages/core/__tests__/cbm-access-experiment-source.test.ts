import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * The claim-route glue for the CBM-access experiment. Scope predicates are
 * rendered with the real PgDialect; only the db CLIENT is stubbed.
 */

const fake = {
  experimentRows: [] as any[],
  priorRows: [] as any[],
  inserted: [] as any[],
  conflictTargets: [] as any[],
  throwOnSelect: false,
  throwOnInsert: false,
};

mock.module('../db/client', () => ({
  db: {
    select: () => ({
      from: (table: any) => ({
        where: async () => {
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

const src = await import('../cbm-access-experiment-source');
const { experimentAssignments } = await import('../db/schema');

const dialect = new PgDialect();
const render = (fragment: any) => {
  const q = dialect.sqlToQuery(fragment);
  return { sql: q.sql.replace(/\s+/g, ' ').trim().toLowerCase(), params: q.params };
};

const EXP_ID = '3c1b8e40-0000-4000-8000-0000000000cb';
const TEAM = 'team-1';
const running = (over: Record<string, unknown> = {}) => ({
  id: EXP_ID, kind: 'cbm_access', status: 'running', treatmentFraction: 0.2,
  policyVersion: 3, config: {}, startedAt: new Date('2026-01-01'), ...over,
});

function uuid(i: number): string {
  const h = (n: number) => ((n * 2654435761) >>> 0).toString(16).padStart(8, '0');
  return `${h(i)}-${h(i + 7).slice(0, 4)}-4${h(i + 13).slice(0, 3)}-8${h(i + 29).slice(0, 3)}-${h(i + 31)}${h(i + 37).slice(0, 4)}`;
}

const task = (over: Record<string, unknown> = {}) => ({
  id: uuid(1), taskClass: 'work', kind: 'engineering', complexity: 'normal', backend: 'claude',
  roleSlug: 'builder', context: {}, workspace: { repo: 'acme/app' }, ...over,
});

const enrol = (over: Partial<Parameters<typeof src.enrolCbmAccessExperiment>[0]> = {}) =>
  src.enrolCbmAccessExperiment({ teamId: TEAM, task: task(), roleCbmDisabled: false, runnerCanWithhold: true, runnerCliVersion: '2.1.300', ...over });

beforeEach(() => {
  fake.experimentRows = [];
  fake.priorRows = [];
  fake.inserted = [];
  fake.conflictTargets = [];
  fake.throwOnSelect = false;
  fake.throwOnInsert = false;
  src.invalidateCbmAccessExperimentCache();
});

describe('predicates', () => {
  it('the experiment lookup is this team, running, kind cbm_access', () => {
    const { sql, params } = render(src.runningCbmExperimentScope(TEAM));
    expect(sql).toContain('"experiments"."team_id" = $1');
    expect(sql).toContain('"experiments"."status" = $2');
    expect(sql).toContain('"experiments"."kind" = $3');
    expect(params).toEqual([TEAM, 'running', 'cbm_access']);
  });

  it('prior assignments are scoped to this experiment and the given tasks', () => {
    const { sql, params } = render(src.cbmPriorAssignmentsScope(EXP_ID, ['a', 'b']));
    expect(sql).toContain('"experiment_assignments"."experiment_id" = $1');
    expect(sql).toContain('"experiment_assignments"."task_id" in ($2, $3)');
    expect(params).toEqual([EXP_ID, 'a', 'b']);
  });
});

describe('enrolCbmAccessExperiment', () => {
  it('ships dark: with no running experiment nothing is enrolled or written', async () => {
    expect(await enrol()).toBeNull();
    expect(fake.inserted).toEqual([]);
  });

  it('enrols eligible tasks at a non-zero fraction and records arm + propensity for every one', async () => {
    fake.experimentRows = [running()];
    const N = 1000;
    let withheld = 0;
    for (let i = 0; i < N; i++) {
      const marker = await enrol({ task: task({ id: uuid(i) }) });
      expect(marker).not.toBeNull();
      if (marker!.withheld) withheld++;
    }
    expect(withheld / N).toBeGreaterThan(0.15);
    expect(withheld / N).toBeLessThan(0.25);
    expect(fake.inserted.length).toBe(N);

    const row = fake.inserted.find(r => r.arm === 'treatment');
    expect(row).toMatchObject({
      experimentId: EXP_ID, unitType: 'task', arm: 'treatment', policyVersion: 3, served: true,
      eligibility: { source: 'drawn', kind: 'engineering', cbm: 'withheld' },
      runnerCliVersion: '2.1.300',
    });
    expect(row.propensity).toBeCloseTo(0.2, 10);
    expect(row.unitId).toBe(row.taskId);
    expect(fake.inserted.find(r => r.arm === 'control').propensity).toBeCloseTo(0.8, 10);
    // Idempotent on (experiment, task): a racing claim writes one row.
    expect(fake.conflictTargets[0]).toEqual([experimentAssignments.experimentId, experimentAssignments.taskId]);
  });

  it('a re-claim reuses the recorded arm and writes nothing new', async () => {
    fake.experimentRows = [running()];
    fake.priorRows = [{ taskId: uuid(1), unitId: uuid(1), arm: 'treatment', propensity: 0.2 }];
    expect(await enrol()).toEqual({ experimentId: EXP_ID, policyVersion: 3, arm: 'treatment', withheld: true });
    expect(fake.inserted).toEqual([]);
  });

  it('a retry attempt inherits its parent arm and records the lineage', async () => {
    fake.experimentRows = [running({ treatmentFraction: 0.99 })];
    const parent = uuid(10);
    fake.priorRows = [{ taskId: parent, unitId: parent, arm: 'control', propensity: 0.8 }];
    const marker = await enrol({ task: task({ id: uuid(11), taskClass: 'attempt', parentTaskId: parent }) });
    expect(marker).toMatchObject({ arm: 'control', withheld: false });
    expect(fake.inserted[0]).toMatchObject({
      taskId: uuid(11), unitId: parent, arm: 'control', propensity: 0.8,
      eligibility: { source: 'inherited', inheritedFromTaskId: parent },
    });
  });

  it('never enrols Codex, non-graph kinds, repo-less, CBM-opted-out or old-runner tasks', async () => {
    fake.experimentRows = [running({ treatmentFraction: 0.99 })];
    expect(await enrol({ task: task({ backend: 'codex' }) })).toBeNull();
    expect(await enrol({ task: task({ kind: 'writing' }) })).toBeNull();
    expect(await enrol({ task: task({ workspace: { repo: null } }) })).toBeNull();
    expect(await enrol({ roleCbmDisabled: true })).toBeNull();
    expect(await enrol({ runnerCanWithhold: false })).toBeNull();
    expect(fake.inserted).toEqual([]);
  });

  it('fails open to "not enrolled" (CBM as usual) when the store throws', async () => {
    fake.experimentRows = [running({ treatmentFraction: 0.99 })];
    fake.throwOnInsert = true;
    // An unrecorded assignment must not withhold: no row, no withheld arm.
    expect(await enrol()).toBeNull();
    src.invalidateCbmAccessExperimentCache();
    fake.throwOnSelect = true;
    expect(await enrol()).toBeNull();
  });
});
