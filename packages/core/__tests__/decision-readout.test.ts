import { describe, expect, it } from 'bun:test';
import {
  computeDecisionReadout,
  type ReadoutChallengerRow,
  type ReadoutDecisionRow,
  type ReadoutOutcomeRow,
  type DecisionObjective,
} from '../decision-readout';

/**
 * The shared readout. Two things it must never blur: a kind that is not
 * collecting at all (off, no key, every call failing) and a kind that is
 * collecting but has too few labelled outcomes yet. And it never claims
 * causal lift from rows the experiment randomizer did not assign.
 */

let seq = 0;
function rec(over: Partial<ReadoutDecisionRow> = {}): ReadoutDecisionRow {
  seq++;
  return {
    id: `d${seq}`,
    status: 'applied',
    applied: true,
    appliedAnswer: 'run',
    policyVersion: 'p1',
    provider: 'openrouter',
    model: 'typesafe/jev-1.13',
    attemptCount: 1,
    escalated: false,
    failureClass: null,
    subjectType: 'task',
    subjectId: `task-${seq}`,
    latencyMs: 100,
    costUsd: 0.001,
    experimentId: null,
    experimentArm: null,
    ...over,
  };
}
const label = (d: ReadoutDecisionRow, l: string, source = 'task_terminal'): ReadoutOutcomeRow => ({ decisionRecordId: d.id, source, label: l, value: null });
const challenger = (d: ReadoutDecisionRow, over: Partial<ReadoutChallengerRow> = {}): ReadoutChallengerRow => ({
  decisionRecordId: d.id, challengerKey: 'openrouter/chat/acme/rich', status: 'attempted', skipReason: null,
  provider: 'openrouter', model: 'acme/rich', outcome: 'decided', decision: d.appliedAnswer, agrees: true,
  failureKind: null, latencyMs: 300, costUsd: 0.004, ...over,
});

// The kind's objective: an adapter, the only place quality is defined.
const objective: DecisionObjective = {
  source: 'task_terminal',
  score: (outcome, answer) => (outcome.label === 'defect_found' ? answer === 'run' : outcome.label === 'clean' ? answer === 'skip' : null),
};

const enabled = { access: 'enabled' as const, eligibleSubjects: 10 };

describe('collection health: not collecting is never "insufficient sample"', () => {
  it('disabled: the team switch is off', () => {
    const r = computeDecisionReadout({ records: [], outcomes: [], challengers: [] }, { access: 'capability_disabled', eligibleSubjects: 40 }, { minLabelled: 5 });
    expect(r.collection).toEqual({ state: 'disabled', collecting: false, reasons: ['capability_disabled'] });
  });

  it('misconfigured: enabled with no key', () => {
    const r = computeDecisionReadout({ records: [], outcomes: [], challengers: [] }, { access: 'missing_key', eligibleSubjects: 40 }, { minLabelled: 5 });
    expect(r.collection.state).toBe('misconfigured');
    expect(r.collection.reasons).toEqual(['missing_key']);
  });

  it('misconfigured: rows exist but every call was unavailable', () => {
    const records = [rec({ status: 'fallback', applied: false, attemptCount: 0, failureClass: 'key', provider: null })];
    const r = computeDecisionReadout({ records, outcomes: [], challengers: [] }, enabled, { minLabelled: 5 });
    expect(r.collection).toEqual({ state: 'misconfigured', collecting: false, reasons: ['every_call_unavailable'] });
    expect(r.failures).toEqual({ capability: 0, key: 1, provider: 0 });
  });

  it('not_collecting: enabled, eligible subjects, zero rows', () => {
    const r = computeDecisionReadout({ records: [], outcomes: [], challengers: [] }, enabled, { minLabelled: 5 });
    expect(r.collection).toEqual({ state: 'not_collecting', collecting: false, reasons: ['no_records'] });
  });

  it('not_collecting: nothing eligible says so, rather than blaming the pipeline', () => {
    const r = computeDecisionReadout({ records: [], outcomes: [], challengers: [] }, { access: 'enabled', eligibleSubjects: 0 }, { minLabelled: 5 });
    expect(r.collection.reasons).toEqual(['no_eligible_subjects']);
  });

  it('not_collecting: every model call failed at the provider', () => {
    const records = [rec({ status: 'fallback', applied: false, failureClass: 'provider' }), rec({ status: 'fallback', applied: false, failureClass: 'provider' })];
    const r = computeDecisionReadout({ records, outcomes: [], challengers: [] }, enabled, { minLabelled: 5 });
    expect(r.collection).toEqual({ state: 'not_collecting', collecting: false, reasons: ['every_call_failed'] });
    expect(r.failures.provider).toBe(2);
  });

  it('not_collecting: only deterministic rules decided', () => {
    const records = [rec({ status: 'fallback', applied: false, attemptCount: 0, provider: null })];
    const r = computeDecisionReadout({ records, outcomes: [], challengers: [] }, enabled, { minLabelled: 5 });
    expect(r.collection.reasons).toEqual(['rules_only']);
  });

  it('insufficient_sample: collecting, too few labelled outcomes', () => {
    const records = [rec(), rec()];
    const r = computeDecisionReadout({ records, outcomes: [label(records[0], 'defect_found')], challengers: [] }, enabled, { minLabelled: 5, objective });
    expect(r.collection).toEqual({ state: 'insufficient_sample', collecting: true, reasons: ['labelled 1 < 5'] });
  });

  it('sufficient once labelled n reaches the minimum', () => {
    const records = [rec(), rec()];
    const outcomes = records.map(d => label(d, 'defect_found'));
    const r = computeDecisionReadout({ records, outcomes, challengers: [] }, enabled, { minLabelled: 2, objective });
    expect(r.collection).toEqual({ state: 'sufficient', collecting: true, reasons: [] });
  });

  it('a truncated row window is flagged', () => {
    const records = [rec(), rec()];
    const r = computeDecisionReadout({ records, outcomes: [], challengers: [], truncated: true }, enabled, { minLabelled: 5 });
    expect(r.collection.reasons).toContain('rows_truncated');
  });
});

describe('the minimum metrics', () => {
  it('counts subjects, coverage, applied attempts, escalation, latency and cost', () => {
    const records = [
      rec({ subjectId: 'a', latencyMs: 100, costUsd: 0.001 }),
      rec({ subjectId: 'a', latencyMs: 200, costUsd: 0.002, escalated: true, attemptCount: 2 }),
      rec({ subjectId: 'b', status: 'suggested', applied: false, latencyMs: 300, costUsd: 0.003 }),
      rec({ subjectId: 'c', status: 'fallback', applied: false, attemptCount: 0, provider: null, latencyMs: 1, costUsd: null }),
    ];
    const r = computeDecisionReadout({ records, outcomes: [], challengers: [] }, enabled, { minLabelled: 5 });
    expect(r.eligibleSubjects).toBe(10);
    expect(r.decidedSubjects).toBe(3);
    expect(r.coverage).toBeCloseTo(0.3, 9);
    expect(r.records).toBe(4);
    expect(r.appliedAttempts).toBe(2);
    expect(r.byStatus).toEqual({ applied: 2, suggested: 1, fallback: 1 });
    expect(r.escalation).toEqual({ eligible: 3, escalated: 1, rate: 1 / 3 });
    expect(r.latencyMs).toEqual({ p50: 100, p90: 300, max: 300 });
    expect(r.cost.totalUsd).toBeCloseTo(0.006, 12);
    expect(r.cost.perDecisionUsd).toBeCloseTo(0.0015, 12);
  });

  it('coverage is unknown, not zero, when the adapter cannot count eligible subjects', () => {
    const r = computeDecisionReadout({ records: [rec()], outcomes: [], challengers: [] }, { access: 'enabled', eligibleSubjects: null }, { minLabelled: 5 });
    expect(r.coverage).toBeNull();
  });

  it('groups n by policy version and provider/model', () => {
    const records = [rec(), rec(), rec({ policyVersion: 'p2' }), rec({ provider: 'openai', model: 'gpt-x' })];
    const outcomes = [label(records[0], 'defect_found'), label(records[1], 'clean')];
    const r = computeDecisionReadout({ records, outcomes, challengers: [] }, enabled, { minLabelled: 5, objective });
    const p1 = r.groups.find(g => g.policyVersion === 'p1' && g.provider === 'openrouter')!;
    expect(p1).toMatchObject({ n: 2, applied: 2, labelled: 2, correct: 1, scored: 2 });
    expect(p1.correctRate).toBeCloseTo(0.5, 9);
    expect(p1.interval.lower).toBeGreaterThan(0);
    expect(r.groups.map(g => [g.policyVersion, g.provider, g.model, g.n])).toEqual([
      ['p1', 'openai', 'gpt-x', 1],
      ['p1', 'openrouter', 'typesafe/jev-1.13', 2],
      ['p2', 'openrouter', 'typesafe/jev-1.13', 1],
    ]);
  });

  it('labelled n counts records with a label from the objective\'s source only', () => {
    const records = [rec(), rec()];
    const outcomes = [label(records[0], 'defect_found'), label(records[1], 'clean', 'human')];
    const r = computeDecisionReadout({ records, outcomes, challengers: [] }, enabled, { minLabelled: 5, objective });
    expect(r.outcomes).toEqual({ labelled: 1, unlabelled: 1, bySource: { task_terminal: 1, human: 1 } });
  });

  it('without an objective, labels are counted but nothing is scored', () => {
    const records = [rec()];
    const r = computeDecisionReadout({ records, outcomes: [label(records[0], 'defect_found')], challengers: [] }, enabled, { minLabelled: 1 });
    expect(r.outcomes.labelled).toBe(1);
    expect(r.groups[0].scored).toBe(0);
  });

  it('counts failures by owner: capability, key, provider', () => {
    const records = [
      rec({ status: 'fallback', applied: false, failureClass: 'provider' }),
      rec({ status: 'fallback', applied: false, attemptCount: 0, failureClass: 'key' }),
      rec(),
    ];
    const r = computeDecisionReadout({ records, outcomes: [], challengers: [] }, enabled, { minLabelled: 5 });
    expect(r.failures).toEqual({ capability: 0, key: 1, provider: 1 });
  });
});

describe('challengers', () => {
  it('reports attempted vs skipped by reason, failures, agreement, latency and cost', () => {
    const records = [rec(), rec(), rec(), rec(), rec()];
    const challengers = [
      challenger(records[0]),
      challenger(records[1], { decision: 'skip', agrees: false }),
      challenger(records[2], { outcome: 'failed', decision: null, agrees: null, failureKind: 'timeout', costUsd: null }),
      challenger(records[3], { status: 'skipped', skipReason: 'not_sampled', provider: null, model: null, outcome: null, decision: null, agrees: null, latencyMs: null, costUsd: null }),
      challenger(records[4], { status: 'skipped', skipReason: 'no_route', provider: null, model: null, outcome: null, decision: null, agrees: null, latencyMs: null, costUsd: null }),
    ];
    const r = computeDecisionReadout({ records, outcomes: [], challengers }, enabled, { minLabelled: 5 });
    expect(r.challenger.attempted).toBe(3);
    expect(r.challenger.skipped).toEqual({ not_sampled: 1, no_route: 1 });
    expect(r.challenger.failures).toEqual({ timeout: 1 });
    expect(r.challenger.agreement).toMatchObject({ n: 2, agree: 1, rate: 0.5 });
    expect(r.challenger.latencyMs).toEqual({ p50: 300, p90: 300, max: 300 });
    expect(r.challenger.costUsd).toBeCloseTo(0.008, 12);
    expect(r.challenger.notRun).toBe(0);
  });

  it('scores the challenger\'s answer against the same outcome, through the objective', () => {
    const records = [rec({ appliedAnswer: 'run' }), rec({ appliedAnswer: 'run' })];
    const challengers = [challenger(records[0], { decision: 'skip', agrees: false }), challenger(records[1], { decision: 'run', agrees: true })];
    const outcomes = [label(records[0], 'clean'), label(records[1], 'defect_found')];
    const r = computeDecisionReadout({ records, outcomes, challengers }, enabled, { minLabelled: 1, objective });
    expect(r.challenger.scored).toMatchObject({ n: 2, appliedCorrect: 1, challengerCorrect: 2 });
  });

  it('counts decisions with a challenger configured but no run row as notRun, when told how many were expected', () => {
    const records = [rec(), rec()];
    const r = computeDecisionReadout({ records, outcomes: [], challengers: [challenger(records[0])], challengerConfigured: true }, enabled, { minLabelled: 5 });
    expect(r.challenger.notRun).toBe(1);
  });
});

describe('causal claims only from randomized assignment', () => {
  it('no experiment assignment: no claim, and says why', () => {
    const records = [rec(), rec()];
    const r = computeDecisionReadout({ records, outcomes: records.map(d => label(d, 'defect_found')), challengers: [] }, enabled, { minLabelled: 1, objective });
    expect(r.causal).toEqual({ claim: false, reason: 'no_randomized_assignment' });
  });

  it('a randomized two-arm experiment reports the arm difference, with insufficient_n under the minimum', () => {
    const records = [
      rec({ experimentId: 'e1', experimentArm: 'control', appliedAnswer: 'skip' }),
      rec({ experimentId: 'e1', experimentArm: 'treatment', appliedAnswer: 'run' }),
      rec(), // unassigned rows are excluded, never pooled into an arm
    ];
    const outcomes = records.map(d => label(d, 'defect_found'));
    const r = computeDecisionReadout({ records, outcomes, challengers: [] }, enabled, { minLabelled: 2, objective });
    expect(r.causal.claim).toBe(true);
    if (!r.causal.claim) throw new Error('unreachable');
    expect(r.causal.experimentId).toBe('e1');
    expect(r.causal.excludedUnassigned).toBe(1);
    expect(r.causal.arms).toEqual([
      { arm: 'control', n: 1, correct: 0, rate: 0 },
      { arm: 'treatment', n: 1, correct: 1, rate: 1 },
    ]);
    expect(r.causal.difference.difference).toBe(1);
    expect(r.causal.verdict).toBe('insufficient_n');
  });

  it('refuses to pool two experiments', () => {
    const records = [rec({ experimentId: 'e1', experimentArm: 'control' }), rec({ experimentId: 'e2', experimentArm: 'treatment' })];
    const r = computeDecisionReadout({ records, outcomes: [], challengers: [] }, enabled, { minLabelled: 1, objective });
    expect(r.causal).toEqual({ claim: false, reason: 'mixed_experiments' });
  });

  it('one arm or no objective is no claim', () => {
    const one = [rec({ experimentId: 'e1', experimentArm: 'control' })];
    expect(computeDecisionReadout({ records: one, outcomes: [], challengers: [] }, enabled, { minLabelled: 1, objective }).causal)
      .toEqual({ claim: false, reason: 'single_arm' });
    const two = [rec({ experimentId: 'e1', experimentArm: 'control' }), rec({ experimentId: 'e1', experimentArm: 'treatment' })];
    expect(computeDecisionReadout({ records: two, outcomes: [], challengers: [] }, enabled, { minLabelled: 1 }).causal)
      .toEqual({ claim: false, reason: 'no_objective' });
  });
});
