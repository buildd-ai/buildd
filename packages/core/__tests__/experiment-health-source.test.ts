import { describe, it, expect, mock } from 'bun:test';
import { QueryBuilder } from 'drizzle-orm/pg-core';

/**
 * The health check's queries rendered to real SQL (same technique as
 * experiment-readout-source.test.ts): a mocked db would accept a cohort filter
 * on the wrong column, or none.
 */
mock.module('../db/client', () => ({
  db: { select: (fields: any) => new QueryBuilder().select(fields) },
}));

const src = await import('../experiment-health-source');

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const EXP_ID = '5b0f6c1e-0000-4000-8000-00000000000c';

describe('experiment health queries', () => {
  it('assignments: experiment AND policy_version for the two-arm kinds, capped', () => {
    const q = src.buildHealthAssignmentsQuery(EXP_ID, 2, null).toSQL();
    const sql = norm(q.sql);
    expect(sql).toContain('select "arm", "unit_id", "assigned_at" from "experiment_assignments"');
    expect(sql).toContain('where ("experiment_assignments"."experiment_id" = $1 and "experiment_assignments"."policy_version" = $2)');
    expect(q.params).toEqual([EXP_ID, 2, src.EXPERIMENT_HEALTH_ROW_LIMIT]);
  });

  it('assignments: experiment AND allocation_version for a tier pool', () => {
    const q = src.buildHealthAssignmentsQuery(EXP_ID, null, 7).toSQL();
    expect(norm(q.sql)).toContain('"experiment_assignments"."allocation_version" = $2');
    expect(q.params).toEqual([EXP_ID, 7, src.EXPERIMENT_HEALTH_ROW_LIMIT]);
  });

  it('triage looks: experiment, policy version, and only looks that drew an arm', () => {
    const q = src.buildTriageLooksHealthQuery(EXP_ID, 3).toSQL();
    const sql = norm(q.sql);
    expect(sql).toContain('select "arm", "mission_id", "created_at" from "heartbeat_triage_looks"');
    expect(sql).toContain('"heartbeat_triage_looks"."experiment_id" = $1');
    expect(sql).toContain('"heartbeat_triage_looks"."policy_version" = $2');
    expect(sql).toContain('"heartbeat_triage_looks"."arm" is not null');
  });

  it('last assigned: max over every version of the experiment', () => {
    const a = norm(src.buildLastAssignedQuery(EXP_ID, 'model_routing').toSQL().sql);
    expect(a).toContain('max("assigned_at")');
    expect(a).toContain('where "experiment_assignments"."experiment_id" = $1');
    expect(a).not.toContain('policy_version');
    const t = norm(src.buildLastAssignedQuery(EXP_ID, 'heartbeat_triage').toSQL().sql);
    expect(t).toContain('max("created_at") from "heartbeat_triage_looks"');
  });

  it('pool and live arms are scoped to the experiment and the pool', () => {
    expect(norm(src.buildPoolForExperimentQuery(EXP_ID).toSQL().sql)).toContain('where "tier_pools"."experiment_id" = $1');
    const arms = src.buildActiveArmsQuery('pool-1').toSQL();
    expect(norm(arms.sql)).toContain('where ("tier_pool_arms"."pool_id" = $1 and "tier_pool_arms"."status" = $2)');
    expect(arms.params).toEqual(['pool-1', 'active']);
  });

  it('running experiments: status = running, every kind', () => {
    const q = src.buildRunningExperimentsQuery().toSQL();
    expect(norm(q.sql)).toContain('where "experiments"."status" = $1');
    expect(q.params).toEqual(['running']);
  });
});
