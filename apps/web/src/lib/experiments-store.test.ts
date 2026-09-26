import { describe, it, expect, mock } from 'bun:test';
import { PgDialect, QueryBuilder } from 'drizzle-orm/pg-core';

/**
 * The experiments predicates, rendered to SQL. The route tests mock this whole
 * module, so this file is where team scoping, the optimistic lock and the
 * single-running guard are actually observable. No connection: `db.select` is
 * drizzle's standalone QueryBuilder (used by the NOT EXISTS subquery).
 */
mock.module('@buildd/core/db', () => ({
  db: { select: (fields: any) => new QueryBuilder().select(fields) },
}));
mock.module('@buildd/core/model-routing-experiment-source', () => ({
  invalidateModelRoutingExperimentCache: () => {},
}));
mock.module('@buildd/core/cbm-access-experiment-source', () => ({
  invalidateCbmAccessExperimentCache: () => {},
}));

const store = await import('./experiments-store');

const dialect = new PgDialect();
function render(fragment: any): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(fragment);
  return { sql: q.sql.replace(/\s+/g, ' ').trim().toLowerCase(), params: q.params };
}

const TEAM = 'team-a';
const ID = 'exp-1';

describe('experiments-store predicates', () => {
  it('list is scoped to the team', () => {
    const { sql, params } = render(store.teamExperimentsScope(TEAM));
    expect(sql).toBe('"experiments"."team_id" = $1');
    expect(params).toEqual([TEAM]);
  });

  it('get-by-id is scoped by id AND team — an id from another team matches nothing', () => {
    const { sql, params } = render(store.teamExperimentScope(TEAM, ID));
    expect(sql).toBe('("experiments"."id" = $1 and "experiments"."team_id" = $2)');
    expect(params).toEqual([ID, TEAM]);
  });

  it('other-running: same team, same kind, running, excluding self', () => {
    const { sql, params } = render(store.otherRunningScope(TEAM, 'model_routing', ID));
    expect(sql).toContain('"experiments"."team_id" = $1');
    expect(sql).toContain('"experiments"."kind" = $2');
    expect(sql).toContain('"experiments"."status" = $3');
    expect(sql).toContain('"experiments"."id" <> $4');
    expect(params).toEqual([TEAM, 'model_routing', 'running', ID]);
  });

  it('guarded update locks on id, team, expected status and policy version', () => {
    const { sql, params } = render(store.guardedUpdateScope(TEAM, ID, { status: 'running', policyVersion: 2 }, null));
    expect(sql).toBe('("experiments"."id" = $1 and "experiments"."team_id" = $2 and "experiments"."status" = $3 and "experiments"."policy_version" = $4)');
    expect(params).toEqual([ID, TEAM, 'running', 2]);
    expect(sql).not.toContain('not exists');
  });

  it('guarded start adds NOT EXISTS over another running experiment of the kind in the same team', () => {
    const { sql, params } = render(store.guardedUpdateScope(TEAM, ID, { status: 'draft', policyVersion: 1 }, { kind: 'model_routing' }));
    expect(sql).toContain('not exists (select 1 from "experiments" "other_experiment" where');
    expect(sql).toContain('"other_experiment"."team_id" = $5');
    expect(sql).toContain('"other_experiment"."kind" = $6');
    expect(sql).toContain('"other_experiment"."status" = $7');
    expect(sql).toContain('"other_experiment"."id" <> $8');
    expect(params).toEqual([ID, TEAM, 'draft', 1, TEAM, 'model_routing', 'running', ID]);
  });
});
