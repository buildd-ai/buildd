import { describe, it, expect, mock } from 'bun:test';
import { QueryBuilder } from 'drizzle-orm/pg-core';

mock.module('../db/client', () => ({ db: { select: (f: any) => new QueryBuilder().select(f) } }));
const src = await import('../heartbeat-triage-experiment-source');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

describe('heartbeat triage experiment scopes', () => {
  it('running experiment: team AND running AND this kind', async () => {
    const { experiments } = await import('../db/schema');
    const q = new QueryBuilder().select({ id: experiments.id }).from(experiments).where(src.runningHeartbeatTriageScope('t-1')).toSQL();
    expect(norm(q.sql)).toContain('where ("experiments"."team_id" = $1 and "experiments"."status" = $2 and "experiments"."kind" = $3)');
    expect(q.params).toEqual(['t-1', 'running', 'heartbeat_triage']);
  });
  it('a mission\'s assignment: experiment AND unit type mission AND unit id', async () => {
    const { experimentAssignments } = await import('../db/schema');
    const q = new QueryBuilder().select({ id: experimentAssignments.id }).from(experimentAssignments).where(src.heartbeatTriageAssignmentScope('e-1', 'm-1')).toSQL();
    expect(norm(q.sql)).toContain('"experiment_assignments"."experiment_id" = $1 and "experiment_assignments"."unit_type" = $2 and "experiment_assignments"."unit_id" = $3');
    expect(q.params).toEqual(['e-1', 'mission', 'm-1']);
  });
});
