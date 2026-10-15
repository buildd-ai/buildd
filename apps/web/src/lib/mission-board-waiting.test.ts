import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  combineGateFacts,
  edgeFactsSql,
  edgeReleaseArm,
  pendingHoldsSql,
  waitingKindFor,
  type EdgeFactsRow,
} from './mission-board-waiting';

const MISSION = '00000000-0000-4000-8000-000000000001';
const dialect = new PgDialect();
const render = (q: ReturnType<typeof edgeFactsSql>) => dialect.sqlToQuery(q);

const edge = (over: Partial<EdgeFactsRow> = {}): EdgeFactsRow => ({
  dependent_id: 'b',
  dependency_id: 'a',
  inferred: false,
  arm_status: false,
  arm_early_release: false,
  arm_migration_other_base: false,
  arm_inferred_unstarted_holder: false,
  arm_force_start: false,
  arm_surface_audit_scope: false,
  arm_bypass: false,
  ...over,
});

const MISSION_FREE = { held: false, local: false, budgetExhausted: false };
const task = (over: Partial<Parameters<typeof waitingKindFor>[0]> = {}) => ({
  deferred: false, held: false, openDeclared: 0, openInferred: 0, deferralReason: null, ...over,
});

describe('edgeReleaseArm', () => {
  it('names the arm that released an edge its status did not', () => {
    expect(edgeReleaseArm(edge({ arm_early_release: true }))).toBe('early_release');
    expect(edgeReleaseArm(edge({ arm_force_start: 't' }))).toBe('force_start');
    expect(edgeReleaseArm(edge({ arm_migration_other_base: true }))).toBe('migration_other_base');
    expect(edgeReleaseArm(edge({ arm_inferred_unstarted_holder: true }))).toBe('inferred_unstarted_holder');
  });

  it('gate-level arms win: they release every edge of the dependent', () => {
    expect(edgeReleaseArm(edge({ arm_bypass: true, arm_early_release: true }))).toBe('bypass');
    expect(edgeReleaseArm(edge({ arm_surface_audit_scope: true }))).toBe('surface_audit_scope');
  });

  it('a status-satisfied or still-holding edge has no release arm', () => {
    expect(edgeReleaseArm(edge({ arm_status: true, arm_early_release: true }))).toBeUndefined();
    expect(edgeReleaseArm(edge())).toBeUndefined();
  });
});

describe('waitingKindFor', () => {
  it('a schedule or a hold explains the task before its dependencies do', () => {
    expect(waitingKindFor(task({ deferred: true, openDeclared: 1 }), MISSION_FREE)).toBe('start_deferred');
    expect(waitingKindFor(task({ held: true, openDeclared: 1 }), MISSION_FREE)).toBe('task_held');
    expect(waitingKindFor(task({ openDeclared: 1 }), { ...MISSION_FREE, held: true })).toBe('mission_held');
    expect(waitingKindFor(task({ openDeclared: 1 }), { ...MISSION_FREE, budgetExhausted: true })).toBe('mission_budget');
  });

  it('declared dependencies before inferred ordering', () => {
    expect(waitingKindFor(task({ openDeclared: 1, openInferred: 1 }), MISSION_FREE)).toBe('dep_declared');
    expect(waitingKindFor(task({ openInferred: 2 }), MISSION_FREE)).toBe('dep_inferred');
  });

  it('a ready task in a local mission waits for a local session, not a dependency', () => {
    expect(waitingKindFor(task(), { ...MISSION_FREE, local: true })).toBe('mission_local');
    expect(waitingKindFor(task({ openDeclared: 1 }), { ...MISSION_FREE, local: true })).toBe('dep_declared');
  });

  it('otherwise the claim loop\'s last deferral, and nothing when there is none', () => {
    expect(waitingKindFor(task({ deferralReason: 'workspace_cap' }), MISSION_FREE)).toBe('workspace_cap');
    expect(waitingKindFor(task({ deferralReason: 'mission_concurrent' }), MISSION_FREE)).toBe('mission_concurrent');
    expect(waitingKindFor(task({ deferralReason: 'path_overlap' }), MISSION_FREE)).toBe('pr_overlap_live');
    expect(waitingKindFor(task({ deferralReason: 'something_new' }), MISSION_FREE)).toBeNull();
    expect(waitingKindFor(task(), MISSION_FREE)).toBeNull();
  });
});

describe('combineGateFacts', () => {
  it('collects released edges and counts the edges that still hold, by kind', () => {
    const facts = combineGateFacts({
      edges: [
        edge({ dependent_id: 'b', dependency_id: 'a', arm_early_release: true }),
        edge({ dependent_id: 'c', dependency_id: 'a' }),
        edge({ dependent_id: 'd', dependency_id: 'a', inferred: true }),
        edge({ dependent_id: 'e', dependency_id: 'a', arm_status: true }),
      ],
      pending: [{ id: 'b', deferred: false, held: false }, { id: 'c', deferred: false, held: false }, { id: 'd', deferred: false, held: false }, { id: 'e', deferred: false, held: false }],
      deferrals: [{ taskId: 'e', reason: 'workspace_cap' }],
      mission: MISSION_FREE,
    });
    expect(facts.releasedEdges).toEqual([{ dependentId: 'b', dependencyId: 'a', arm: 'early_release' }]);
    expect(facts.waitingKinds).toEqual({ c: 'dep_declared', d: 'dep_inferred', e: 'workspace_cap' });
  });

  it('a held task reads held even when every edge is released', () => {
    const facts = combineGateFacts({
      edges: [edge({ arm_early_release: true })],
      pending: [{ id: 'b', deferred: 'f', held: 't' }],
      deferrals: [],
      mission: MISSION_FREE,
    });
    expect(facts.waitingKinds).toEqual({ b: 'task_held' });
  });
});

describe('the loader queries', () => {
  it('edge facts are scoped to one mission\'s unfinished tasks and read each dependsOn element', () => {
    const q = render(edgeFactsSql(MISSION));
    expect(q.sql).toContain('jsonb_array_elements_text(COALESCE("tasks"."depends_on"::jsonb');
    expect(q.sql).toContain('"tasks"."mission_id" = $');
    expect(q.sql).toContain(`"tasks"."status" NOT IN ('completed', 'cancelled')`);
    expect(q.params).toContain(MISSION);
  });

  it('pending holds read the task hold and a future start', () => {
    const q = render(pendingHoldsSql(MISSION));
    expect(q.sql).toContain(`"tasks"."context"->'heldBy'`);
    expect(q.sql).toContain('"tasks"."start_at" > now()');
    expect(q.sql).toContain(`"tasks"."status" = 'pending'`);
  });
});
