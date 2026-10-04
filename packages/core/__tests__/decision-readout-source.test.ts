import { describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { choice } from '@builddai/ai-kit/decide';
import { defineBuilddDecisionKind } from '../decision-kinds';
import { decisionReadoutRecordsWhere, readDecisionKindReadout, DEFAULT_MIN_LABELLED } from '../decision-readout-source';
import type { ReadoutRows } from '../decision-readout';

const dialect = new PgDialect();
const since = new Date('2026-09-26T00:00:00Z');
const until = new Date('2026-10-03T00:00:00Z');

const kind = defineBuilddDecisionKind({
  kind: 'buildd.test_readout_probe',
  policyVersion: 'p1',
  featureSchemaVersion: 'v1',
  decisions: ['run', 'skip'] as const,
  parseFeatures: (input: unknown) => ({ ok: true, features: input as { risk: number } }),
  questions: { probe: choice('Run?', { run: 'yes', skip: 'no' }) },
  state: f => ({ risk: f.risk }),
  interpret: a => ({ decision: a.probe.choice, confidence: a.probe.confidence, reasonCode: 'm' }),
  minConfidence: 0.8,
  fallback: () => ({ decision: 'skip', reasonCode: 'fb' }),
}, {
  capability: 'surface_audit_advice',
  mode: 'live',
  challenger: { endpoint: 'chat', model: 'acme/rich', via: 'openrouter' },
  readout: {
    eligibleSubjects: async () => 12,
    minLabelled: 1,
    objective: { score: (o, answer) => (o.label === 'defect_found' ? answer === 'run' : null) },
  },
});

const rows = (over: Partial<ReadoutRows> = {}): ReadoutRows => ({
  records: [{
    id: 'd1', status: 'applied', applied: true, appliedAnswer: 'run', policyVersion: 'p1', provider: 'openrouter', model: 'm',
    attemptCount: 1, escalated: false, failureClass: null, subjectType: 'task', subjectId: 't1', latencyMs: 10, costUsd: 0.001,
    experimentId: null, experimentArm: null,
  }],
  outcomes: [{ decisionRecordId: 'd1', source: 'task_terminal', label: 'defect_found', value: null }],
  challengers: [],
  ...over,
});

describe('decisionReadoutRecordsWhere', () => {
  it('scopes to team, kind and window, and to a workspace when given', () => {
    const team = dialect.sqlToQuery(decisionReadoutRecordsWhere({ teamId: 't', kind: 'buildd.x', since, until }) as never).sql;
    expect(team).toContain('"decision_records"."team_id" = $1');
    expect(team).toContain('"decision_records"."capability" = $2');
    expect(team).toContain('"decision_records"."created_at" >= $3');
    expect(team).toContain('"decision_records"."created_at" < $4');
    expect(team).not.toContain('workspace_id');
    const ws = dialect.sqlToQuery(decisionReadoutRecordsWhere({ teamId: 't', workspaceId: 'w', kind: 'buildd.x', since, until }) as never).sql;
    expect(ws).toContain('"decision_records"."workspace_id" = $5');
  });
});

describe('readDecisionKindReadout', () => {
  it('a registered kind: access from team policy, eligibility and objective from the kind adapter', async () => {
    const loadRows = mock(async () => rows());
    const resolveAccess = mock(async () => 'enabled' as const);
    const r = await readDecisionKindReadout(kind, { teamId: 't', workspaceId: 'w', since, until }, { loadRows, resolveAccess });
    expect(loadRows.mock.calls[0][0]).toEqual({ teamId: 't', workspaceId: 'w', since, until, kind: 'buildd.test_readout_probe' });
    expect(r.registered).toBe(true);
    expect(r.readout.eligibleSubjects).toBe(12);
    expect(r.readout.collection.state).toBe('sufficient');
    expect(r.readout.groups[0]).toMatchObject({ scored: 1, correct: 1 });
    // The kind binds a challenger and this decision has no run: a gap, counted.
    expect(r.readout.challenger.notRun).toBe(1);
  });

  it('a disabled team switch reads disabled even with zero rows', async () => {
    const r = await readDecisionKindReadout(kind, { teamId: 't', since, until }, {
      loadRows: async () => rows({ records: [], outcomes: [] }),
      resolveAccess: async () => 'capability_disabled',
    });
    expect(r.readout.collection).toEqual({ state: 'disabled', collecting: false, reasons: ['capability_disabled'] });
  });

  it('an unregistered kind id reads rows only: access unknown, nothing scored, default minimum', async () => {
    const resolveAccess = mock(async () => 'enabled' as const);
    const r = await readDecisionKindReadout('buildd.not_defined_here', { teamId: 't', since, until }, { loadRows: async () => rows(), resolveAccess });
    expect(r.registered).toBe(false);
    expect(resolveAccess).not.toHaveBeenCalled();
    expect(r.readout.eligibleSubjects).toBeNull();
    expect(r.readout.groups[0].scored).toBe(0);
    expect(r.readout.collection.reasons).toEqual([`labelled 1 < ${DEFAULT_MIN_LABELLED}`]);
  });

  it('an eligibility adapter that throws reads unknown, not zero', async () => {
    const flaky = defineBuilddDecisionKind({ ...kind, kind: 'buildd.test_readout_flaky' } as any, {
      capability: 'surface_audit_advice', mode: 'live', readout: { eligibleSubjects: async () => { throw new Error('db down'); } },
    });
    const r = await readDecisionKindReadout(flaky, { teamId: 't', since, until }, { loadRows: async () => rows(), resolveAccess: async () => 'enabled' });
    expect(r.readout.eligibleSubjects).toBeNull();
    expect(r.readout.coverage).toBeNull();
  });
});
