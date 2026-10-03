import { describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  decisionLedgerWhere,
  recordDecision,
  rowFromRecord,
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
    await expect(recordDecision(BASE, { insert })).resolves.toBeUndefined();
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
