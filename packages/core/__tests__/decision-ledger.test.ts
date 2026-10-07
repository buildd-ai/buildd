import { describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  decisionLedgerWhere,
  recordChallengerRun,
  recordDecision,
  rowFromRecord,
  summarizeDecisionLedger,
  type DecisionLedgerFilters,
  type DecisionLedgerInput,
} from '../decision-ledger';

const dialect = new PgDialect();
function renderWhere(f: DecisionLedgerFilters): string {
  return dialect.sqlToQuery(decisionLedgerWhere(f) as never).sql;
}

const BASE: DecisionLedgerInput = {
  teamId: 'team-1',
  workspaceId: 'ws-1',
  missionId: null,
  taskId: 'task-1',
  capability: 'task_role_shadow',
  fingerprint: 'fp-abc',
  promptVersion: 'tr1',
  model: 'typesafe/jev-1.13',
  minConfidence: 0.9,
  ruleAnswer: null,
  verdict: 'builder',
  confidence: 0.96,
  appliedAnswer: 'builder',
  applied: true,
  status: 'applied',
  reason: null,
  latencyMs: 120,
  inputTokens: 300,
  costUsd: 0.0001,
};

describe('recordDecision', () => {
  it('inserts exactly the row it was given, with null defaults for omitted optionals', async () => {
    const insert = mock(async () => {});
    await recordDecision(BASE, { insert });
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0];
    expect(row.capability).toBe('task_role_shadow');
    expect(row.applied).toBe(true);
    expect(row.status).toBe('applied');
    expect(row.humanOverride).toBeNull();
  });

  it('never throws when the insert fails', async () => {
    const insert = mock(async () => { throw new Error('db down'); });
    await expect(recordDecision(BASE, { insert })).resolves.toBeNull();
  });

  it('writes a fallback row with no verdict on a failed/timed-out call', async () => {
    const insert = mock(async () => {});
    await recordDecision({
      ...BASE, verdict: null, confidence: null, appliedAnswer: null, applied: false,
      status: 'fallback', reason: 'timeout',
    }, { insert });
    const row = insert.mock.calls[0][0];
    expect(row.status).toBe('fallback');
    expect(row.applied).toBe(false);
    expect(row.verdict).toBeNull();
  });
});

describe('rowFromRecord', () => {
  it('coerces undefined optionals to null so every column has an explicit value', () => {
    const row = rowFromRecord({
      teamId: 'team-1', taskId: 'task-1', capability: 'task_role_shadow', fingerprint: 'fp',
      applied: false, status: 'suggested',
    } as DecisionLedgerInput);
    expect(row.workspaceId).toBeNull();
    expect(row.missionId).toBeNull();
    expect(row.ruleAnswer).toBeNull();
    expect(row.verdict).toBeNull();
    expect(row.humanOverride).toBeNull();
    expect(row.overriddenAt).toBeNull();
    expect(row.overriddenBy).toBeNull();
  });
});

describe('decisionLedgerWhere', () => {
  const f = (over: Partial<DecisionLedgerFilters> = {}): DecisionLedgerFilters => ({ teamId: 'team-1', ...over });

  it('always scopes to the team', () => {
    expect(renderWhere(f())).toContain('team_id');
  });

  it('adds a capability predicate only when given', () => {
    expect(renderWhere(f())).not.toContain('capability');
    expect(renderWhere(f({ capability: 'task_role_shadow' }))).toContain('capability');
  });

  it('adds a disagreement predicate only when requested', () => {
    expect(renderWhere(f({ disagreementOnly: true }))).toContain('rule_answer');
  });

  it('adds an override predicate only when requested', () => {
    expect(renderWhere(f({ overriddenOnly: true }))).toContain('human_override');
  });

  it('adds since/until predicates only when given', () => {
    const since = new Date('2026-10-01T00:00:00Z');
    const until = new Date('2026-10-02T00:00:00Z');
    expect(renderWhere(f({ since, until }))).toContain('created_at');
  });
});

describe('recordDecision: row id and decision-kind fields', () => {
  it('resolves to the inserted row id, which challengers and outcome labels attach to', async () => {
    const insert = mock(async () => 'rec-1');
    await expect(recordDecision(BASE, { insert })).resolves.toBe('rec-1');
  });

  it('defaults the decision-kind fields so an older call site writes a full row', () => {
    const row = rowFromRecord(BASE);
    expect(row).toMatchObject({
      policyVersion: null, provider: null, attemptCount: null, escalated: false, failureClass: null,
      subjectType: null, subjectId: null, experimentId: null, experimentArm: null, propensity: null,
    });
  });
});

describe('recordChallengerRun', () => {
  const attempted = {
    status: 'attempted' as const, skipReason: null, appliedDecision: 'run', appliedSource: 'model' as const, agrees: false,
    attempt: {
      index: 1, role: 'challenger' as const, provider: 'openrouter', model: 'acme/rich-1', modelVersion: 'acme/rich-1-2026',
      outcome: 'decided' as const, decision: 'skip', confidence: 0.91, reasonCode: 'model_skip', threshold: 0.8,
      failure: null, applied: false, escalatedFrom: null, latencyMs: 42.4, providerAttempts: 1,
      usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.0003 },
    },
  };

  it('maps an attempted run onto one row, with agreement against the applied answer', async () => {
    const insert = mock(async () => {});
    await recordChallengerRun({ decisionRecordId: 'rec-1', teamId: 'team-1', capability: 'buildd.x', challengerKey: 'openrouter/acme/rich-1', run: attempted }, { insert });
    expect(insert.mock.calls[0][0]).toEqual({
      decisionRecordId: 'rec-1', teamId: 'team-1', capability: 'buildd.x', challengerKey: 'openrouter/acme/rich-1',
      status: 'attempted', skipReason: null, provider: 'openrouter', model: 'acme/rich-1', modelVersion: 'acme/rich-1-2026',
      outcome: 'decided', decision: 'skip', confidence: 0.91, appliedAnswer: 'run', agrees: false, failureKind: null,
      latencyMs: 42, costUsd: 0.0003,
    });
  });

  it('maps a skip with its reason and no attempt fields', async () => {
    const insert = mock(async () => {});
    await recordChallengerRun({
      decisionRecordId: 'rec-1', teamId: 'team-1', capability: 'buildd.x', challengerKey: 'k',
      run: { status: 'skipped', skipReason: 'no_route', appliedDecision: 'run', appliedSource: 'model', attempt: null, agrees: null },
    }, { insert });
    expect(insert.mock.calls[0][0]).toMatchObject({ status: 'skipped', skipReason: 'no_route', provider: null, decision: null, agrees: null, latencyMs: null });
  });

  it('never throws', async () => {
    const insert = mock(async () => { throw new Error('db down'); });
    await expect(recordChallengerRun({ decisionRecordId: 'r', teamId: 't', capability: 'c', challengerKey: 'k', run: attempted }, { insert })).resolves.toBeUndefined();
  });
});

describe('summarizeDecisionLedger', () => {
  it('counts the question gate by disposition, answer, reason and override without echoing an option label', () => {
    const rows = [
      { status: 'applied', verdict: 'decide', appliedAnswer: 'Use the staging database', reason: null, humanOverride: null, confidence: 0.9 },
      { status: 'applied', verdict: 'hold', appliedAnswer: 'hold', reason: null, humanOverride: { answer: 'B' }, confidence: 0.8 },
      { status: 'applied', verdict: 'ask', appliedAnswer: 'ask', reason: null, humanOverride: null, confidence: 0.7 },
      { status: 'suggested', verdict: 'decide', appliedAnswer: null, reason: 'below_threshold', humanOverride: null, confidence: 0.4 },
      { status: 'fallback', verdict: null, appliedAnswer: null, reason: 'timeout', humanOverride: null, confidence: null },
    ] as const;
    const s = summarizeDecisionLedger(rows as any, 2);
    expect(s.total).toBe(5);
    expect(s.byStatus).toEqual({ applied: 3, suggested: 1, fallback: 1 });
    expect(s.byVerdict).toEqual({ decide: 2, hold: 1, ask: 1, none: 1 });
    expect(s.byAppliedAnswer).toEqual({ decided_option: 1, hold: 1, ask: 1, none: 2 });
    expect(s.byReason).toEqual({ none: 3, below_threshold: 1, timeout: 1 });
    expect(s.overridden).toBe(1);
    expect(s.outcomeLabels).toBe(2);
    expect(s.meanConfidence).toBe(0.7);
    expect(JSON.stringify(s)).not.toContain('staging');
  });

  it('is all zeros for an empty page', () => {
    expect(summarizeDecisionLedger([]).total).toBe(0);
    expect(summarizeDecisionLedger([]).meanConfidence).toBeNull();
  });
});
