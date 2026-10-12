import { describe, expect, it } from 'bun:test';
import {
  AGENT_AUDIT_RULE_SOURCE,
  AGENT_AUDIT_SOURCE,
  FALLBACK_REASON_SENTENCES,
  agentAuditObjective,
  computeFeatureHealth,
  fallbackReasonKey,
  fallbackSentence,
  labelDecisionAudit,
  type HealthOutcome,
  type HealthRow,
} from '../decision-feature-health';
import { computeDecisionReadout } from '../decision-readout';
import type { OutcomeRow, OutcomeStore } from '../decision-outcomes';

/**
 * One measurable readout per decision feature, and the agent audit that
 * grades a sample of it. Synthetic rows only.
 */

let seq = 0;
function row(over: Partial<HealthRow> = {}): HealthRow {
  seq++;
  return {
    id: `d${seq}`,
    status: 'applied',
    applied: true,
    verdict: 'builder',
    ruleAnswer: null,
    appliedAnswer: 'builder',
    reason: null,
    latencyMs: 100,
    costUsd: 0.001,
    overridden: false,
    ...over,
  };
}
const fallback = (reason: string, over: Partial<HealthRow> = {}) =>
  row({ status: 'fallback', applied: false, verdict: null, appliedAnswer: null, reason, latencyMs: null, costUsd: null, ...over });
const audit = (r: HealthRow, label: string, source = AGENT_AUDIT_SOURCE): HealthOutcome => ({ decisionRecordId: r.id, source, label });

describe('fallbackReasonKey', () => {
  it('reads the bare reason legacy call sites write', () => {
    expect(fallbackReasonKey('insufficient_candidates')).toBe('insufficient_candidates');
    expect(fallbackReasonKey('timeout')).toBe('timeout');
  });

  it('reads the cause out of a decision-kind reason chain', () => {
    expect(fallbackReasonKey('fallback:fallback_no_provider; cause=no_provider; unavailable=no key')).toBe('no_provider');
    expect(fallbackReasonKey('fallback:heuristic_defer_provider_failure; cause=provider_failure; chain=cheap')).toBe('provider_failure');
  });

  it('reads the code of a kind reason with no cause', () => {
    expect(fallbackReasonKey('rule:must_run')).toBe('must_run');
  });

  it('is unknown when nothing was written', () => {
    expect(fallbackReasonKey(null)).toBe('unknown');
    expect(fallbackReasonKey('  ')).toBe('unknown');
  });
});

describe('fallback sentences', () => {
  it('gives every known fallback reason one plain sentence and a fix', () => {
    for (const [reason, s] of Object.entries(FALLBACK_REASON_SENTENCES)) {
      expect(s.length, reason).toBeGreaterThan(20);
      expect(s.length, reason).toBeLessThanOrEqual(160);
      // Plain words: no snake_case identifiers leak into the sentence.
      expect(s, reason).not.toMatch(/[a-z]+_[a-z]+/);
      expect(s.endsWith('.'), reason).toBe(true);
    }
  });

  it('says what the role case needs in plain words', () => {
    expect(fallbackSentence('insufficient_candidates')).toStartWith('Not deciding: fewer than two roles say when to use them.');
  });

  it('covers every fallback reason the ledgers document', () => {
    // decision_records.reason, orchestration_decisions.reason, task-role skips, and DecisionFallbackCause.
    const documented = [
      'capability_disabled', 'missing_key', 'timeout', 'provider_error', 'parse', 'no_candidates',
      'retrieval_error', 'rule_decided', 'deadline', 'invalid', 'error',
      'insufficient_candidates', 'sensitive_workspace', 'no_key',
      'disabled', 'invalid_features', 'no_provider', 'provider_failure', 'low_confidence', 'unmeasured_model', 'shadow',
    ];
    for (const r of documented) expect(Object.keys(FALLBACK_REASON_SENTENCES), r).toContain(r);
  });

  it('still says something for a reason it does not know', () => {
    expect(fallbackSentence('brand_new_reason')).toContain('brand new reason');
  });
});

describe('computeFeatureHealth', () => {
  it('a week of insufficient-candidate fallbacks reads as not collecting, with the role fix', () => {
    const rows = Array.from({ length: 12 }, () => fallback('insufficient_candidates'));
    const h = computeFeatureHealth(rows, []);
    expect(h.collection.state).toBe('not_collecting');
    expect(h.collection.reason).toBe('insufficient_candidates');
    expect(h.collection.sentence).toStartWith('Not deciding: fewer than two roles say when to use them.');
    expect(h.calls).toBe(12);
    expect(h.acted).toEqual({ n: 0, pct: 0 });
    expect(h.fallback.pct).toBe(100);
    expect(h.fallback.byReason).toEqual([{ reason: 'insufficient_candidates', n: 12, pct: 100, sentence: fallbackSentence('insufficient_candidates') }]);
  });

  it('switched off reads as disabled, no key as misconfigured', () => {
    expect(computeFeatureHealth([fallback('capability_disabled')], []).collection.state).toBe('disabled');
    expect(computeFeatureHealth([fallback('fallback:x; cause=disabled')], []).collection.state).toBe('disabled');
    expect(computeFeatureHealth([fallback('missing_key'), fallback('no_key')], []).collection.state).toBe('misconfigured');
    expect(computeFeatureHealth([fallback('fallback:x; cause=no_provider')], []).collection.state).toBe('misconfigured');
  });

  it('no rows is not collecting, never an insufficient sample', () => {
    const h = computeFeatureHealth([], []);
    expect(h.collection.state).toBe('not_collecting');
    expect(h.collection.reason).toBe('no_records');
    expect(h.acted.pct).toBeNull();
    expect(h.graded.accuracy).toBeNull();
  });

  it('a model answer that was only recorded still counts as collecting', () => {
    const h = computeFeatureHealth([row({ status: 'suggested', applied: false, reason: 'below_threshold' })], []);
    expect(h.collection.state).toBe('insufficient_sample');
    expect(h.collection.sentence).toContain('0 of 20');
  });

  it('computes acted %, fallback % by reason, latency p50/p95, cost and override rate', () => {
    const applied = Array.from({ length: 6 }, (_, i) => row({ latencyMs: (i + 1) * 100, costUsd: 0.01, overridden: i === 0 }));
    const rows = [
      ...applied,
      row({ status: 'suggested', applied: false, latencyMs: 700, costUsd: 0.01 }),
      fallback('timeout', { latencyMs: 2000 }),
      fallback('timeout', { latencyMs: 3000 }),
      fallback('provider_error'),
    ];
    const h = computeFeatureHealth(rows, []);
    expect(h.calls).toBe(10);
    expect(h.acted).toEqual({ n: 6, pct: 60 });
    expect(h.fallback.n).toBe(3);
    expect(h.fallback.pct).toBe(30);
    expect(h.fallback.byReason.map(r => [r.reason, r.n, r.pct])).toEqual([['timeout', 2, 20], ['provider_error', 1, 10]]);
    // 100..700, 2000, 3000 (nearest rank): p50 = 5th of 9, p95 = 9th of 9.
    expect(h.latencyMs).toEqual({ p50: 500, p95: 3000 });
    expect(h.costUsd).toBeCloseTo(0.07, 6);
    expect(h.overrides).toEqual({ n: 1, rate: 1 / 6 });
  });

  it('grades accuracy as right / (right + wrong) with a Wilson interval, unsure excluded', () => {
    const rows = Array.from({ length: 10 }, () => row());
    const outcomes = [
      ...rows.slice(0, 7).map(r => audit(r, 'right')),
      ...rows.slice(7, 9).map(r => audit(r, 'wrong')),
      audit(rows[9], 'unsure'),
    ];
    const h = computeFeatureHealth(rows, outcomes);
    expect(h.graded.right).toBe(7);
    expect(h.graded.wrong).toBe(2);
    expect(h.graded.unsure).toBe(1);
    expect(h.graded.n).toBe(9);
    expect(h.graded.accuracy).toBeCloseTo(7 / 9, 6);
    expect(h.graded.interval.lower).toBeGreaterThan(0.4);
    expect(h.graded.interval.lower).toBeLessThan(7 / 9);
    expect(h.graded.interval.upper).toBeGreaterThan(7 / 9);
    expect(h.graded.interval.upper).toBeLessThanOrEqual(1);
  });

  it("reads the rule's accuracy on the same sample from its own source", () => {
    const rows = Array.from({ length: 4 }, () => row());
    const outcomes = [
      ...rows.map(r => audit(r, 'right')),
      audit(rows[0], 'right', AGENT_AUDIT_RULE_SOURCE),
      audit(rows[1], 'wrong', AGENT_AUDIT_RULE_SOURCE),
      audit(rows[2], 'wrong', AGENT_AUDIT_RULE_SOURCE),
    ];
    const h = computeFeatureHealth(rows, outcomes);
    expect(h.graded.accuracy).toBe(1);
    expect(h.rule).toMatchObject({ n: 3, right: 1, wrong: 2 });
    expect(h.rule.accuracy).toBeCloseTo(1 / 3, 6);
  });

  it('ignores other sources, labels for rows outside the window, and a second label on one record', () => {
    const r = row();
    const h = computeFeatureHealth([r], [
      { decisionRecordId: r.id, source: 'human', label: 'overridden' },
      { decisionRecordId: 'elsewhere', source: AGENT_AUDIT_SOURCE, label: 'wrong' },
      audit(r, 'right'),
      audit(r, 'wrong'),
    ]);
    expect(h.graded).toMatchObject({ n: 1, right: 1, wrong: 0 });
  });

  it('is sufficient once the graded sample reaches the minimum', () => {
    const rows = Array.from({ length: 5 }, () => row());
    const h = computeFeatureHealth(rows, rows.map(r => audit(r, 'right')), { minGraded: 5 });
    expect(h.collection.state).toBe('sufficient');
  });
});

describe('agentAuditObjective', () => {
  it('scores right and wrong, and has no opinion on unsure', () => {
    expect(agentAuditObjective.source).toBe(AGENT_AUDIT_SOURCE);
    expect(agentAuditObjective.score({ label: 'right', value: null }, 'a')).toBe(true);
    expect(agentAuditObjective.score({ label: 'wrong', value: null }, 'a')).toBe(false);
    expect(agentAuditObjective.score({ label: 'unsure', value: null }, 'a')).toBeNull();
  });

  it('does not lend its grade to a different answer (a challenger that disagreed)', () => {
    const o = { label: 'right', value: null, metadata: { answer: 'builder' } };
    expect(agentAuditObjective.score(o, 'builder')).toBe(true);
    expect(agentAuditObjective.score(o, 'researcher')).toBeNull();
  });

  it('plugs into the shared readout for a kind with no objective of its own', () => {
    const readout = computeDecisionReadout(
      {
        records: [{
          id: 'r1', status: 'applied', applied: true, appliedAnswer: 'x', policyVersion: 'p1', provider: 'a', model: 'm',
          attemptCount: 1, escalated: false, failureClass: null, subjectType: 'task', subjectId: 't1', latencyMs: 10, costUsd: 0,
          experimentId: null, experimentArm: null,
        }],
        outcomes: [{ decisionRecordId: 'r1', source: AGENT_AUDIT_SOURCE, label: 'right', value: null, metadata: { answer: 'x' } }],
        challengers: [],
      },
      { access: 'enabled', eligibleSubjects: null },
      { minLabelled: 1, objective: agentAuditObjective },
    );
    expect(readout.groups[0]).toMatchObject({ scored: 1, correct: 1 });
  });
});

describe('labelDecisionAudit', () => {
  const TEAM = 'team-a';
  const record = { id: 'rec-1', teamId: TEAM, capability: 'task_role_shadow', verdict: 'builder', ruleAnswer: 'researcher', appliedAnswer: 'builder', status: 'applied' as const };

  function memoryStore() {
    const rows: OutcomeRow[] = [];
    const store: OutcomeStore = {
      async findRecords(q) {
        return q.teamId === TEAM && q.decisionRecordId === record.id ? [{ id: record.id, capability: record.capability }] : [];
      },
      async insertOutcome(r) {
        if (rows.some(x => x.decisionRecordId === r.decisionRecordId && x.source === r.source)) return false;
        rows.push(r);
        return true;
      },
      async readOutcome(id, source) {
        const r = rows.find(x => x.decisionRecordId === id && x.source === source);
        return r ? { label: r.label, value: r.value } : null;
      },
    };
    return { rows, store };
  }

  it('writes the agent label on the answer it grades, and the rule label on the rule answer', async () => {
    const { rows, store } = memoryStore();
    const res = await labelDecisionAudit({ record, label: 'right', rationale: 'The task shipped a code PR.', ruleLabel: 'wrong' }, { store });
    expect(res).toEqual({ ok: true, label: 'recorded', ruleLabel: 'recorded' });
    expect(rows.map(r => [r.source, r.label, r.metadata?.answer])).toEqual([
      [AGENT_AUDIT_SOURCE, 'right', 'builder'],
      [AGENT_AUDIT_RULE_SOURCE, 'wrong', 'researcher'],
    ]);
    expect(rows[0].metadata?.rationale).toBe('The task shipped a code PR.');
  });

  it('grades the answer in effect when the model gave none', async () => {
    const { rows, store } = memoryStore();
    await labelDecisionAudit({ record: { ...record, verdict: null, status: 'fallback' }, label: 'wrong', rationale: 'r' }, { store });
    expect(rows[0].metadata).toMatchObject({ answer: 'builder', graded: 'applied' });
  });

  it('the same label again is a duplicate; a different one is a conflict and the first stands', async () => {
    const { rows, store } = memoryStore();
    await labelDecisionAudit({ record, label: 'right', rationale: 'r' }, { store });
    expect(await labelDecisionAudit({ record, label: 'right', rationale: 'again' }, { store })).toMatchObject({ ok: true, label: 'duplicate' });
    const conflict = await labelDecisionAudit({ record, label: 'wrong', rationale: 'changed my mind' }, { store });
    expect(conflict).toMatchObject({ ok: true, label: 'conflict', existing: 'right' });
    expect(rows.filter(r => r.source === AGENT_AUDIT_SOURCE).map(r => r.label)).toEqual(['right']);
  });

  it('refuses a label outside right / wrong / unsure, an empty or long rationale, and a bad rule label', async () => {
    const { rows, store } = memoryStore();
    expect(await labelDecisionAudit({ record, label: 'maybe', rationale: 'r' }, { store })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await labelDecisionAudit({ record, label: 'right', rationale: '  ' }, { store })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await labelDecisionAudit({ record, label: 'right', rationale: 'x'.repeat(281) }, { store })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await labelDecisionAudit({ record, label: 'right', rationale: 'r', ruleLabel: 'nah' }, { store })).toMatchObject({ ok: false, error: 'invalid' });
    expect(rows).toHaveLength(0);
  });
});

describe('computeFeatureHealth — collection coverage', () => {
  it('reports the share of decisions with any outcome label, by source', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' }), row({ id: 'd' })];
    const h = computeFeatureHealth(rows, [
      { decisionRecordId: 'a', source: 'human', label: 'overridden' },
      { decisionRecordId: 'a', source: 'strand_followup', label: 'wait-for-local' },
      { decisionRecordId: 'b', source: 'strand_followup', label: 'continue-on-runner' },
      { decisionRecordId: 'other', source: 'human', label: 'overridden' },
    ]);
    expect(h.coverage.labelled).toEqual({ n: 2, pct: 50, bySource: [{ source: 'strand_followup', n: 2 }, { source: 'human', n: 1 }] });
  });

  it('a feature with no labels reads 0%, never missing', () => {
    expect(computeFeatureHealth([row({ id: 'a' })], []).coverage.labelled).toEqual({ n: 0, pct: 0, bySource: [] });
    expect(computeFeatureHealth([], []).coverage.labelled).toEqual({ n: 0, pct: null, bySource: [] });
  });

  it('replay coverage only when every row says whether it has a copy', () => {
    expect(computeFeatureHealth([row({ id: 'a' })], []).coverage.replay).toBeNull();
    expect(computeFeatureHealth([row({ id: 'a', replayed: true }), row({ id: 'b', replayed: null })], []).coverage.replay).toBeNull();
    expect(computeFeatureHealth([row({ id: 'a', replayed: true }), row({ id: 'b', replayed: false })], []).coverage.replay).toEqual({ n: 1, pct: 50 });
  });
});
