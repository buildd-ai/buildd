import { describe, it, expect } from 'bun:test';
import {
  criteriaFingerprint,
  decideCriteriaRearm,
  formatVerdictLines,
  MAX_REARM_CYCLES,
} from './criteria-rearm';
import type { GoalCriteriaState } from '@buildd/shared';

function state(overall: GoalCriteriaState['overall'], criteria: Array<Partial<GoalCriteriaState['criteria'][number]>>): GoalCriteriaState {
  return {
    overall,
    evaluatedAt: '2026-08-31T11:00:00.000Z',
    evaluatedBy: 'auto',
    criteria: criteria.map((c, i) => ({
      index: c.index ?? i,
      type: c.type ?? 'description',
      label: c.label ?? `criterion ${i}`,
      verdict: c.verdict ?? 'pass',
      evidence: c.evidence ?? '',
      ...(c.evidenceRef ? { evidenceRef: c.evidenceRef } : {}),
    })) as GoalCriteriaState['criteria'],
  } as GoalCriteriaState;
}

describe('criteriaFingerprint', () => {
  it('is stable across re-evaluations that produce the same verdicts', () => {
    const a = state('fail', [{ verdict: 'fail' }, { verdict: 'NOT_EVALUATED' }]);
    const b = state('fail', [{ verdict: 'fail' }, { verdict: 'NOT_EVALUATED' }]);
    b.evaluatedAt = '2026-08-31T23:00:00.000Z';
    expect(criteriaFingerprint(a)).toBe(criteriaFingerprint(b));
  });

  it('ignores evidence wording — a re-graded explanation is not new information', () => {
    const a = state('fail', [{ verdict: 'fail', evidence: 'No artifact matching (type="content") found' }]);
    const b = state('fail', [{ verdict: 'fail', evidence: 'no content artifact was found for this mission' }]);
    expect(criteriaFingerprint(a)).toBe(criteriaFingerprint(b));
  });

  it('changes when any criterion verdict changes', () => {
    const a = state('fail', [{ verdict: 'fail' }, { verdict: 'NOT_EVALUATED' }]);
    const b = state('fail', [{ verdict: 'fail' }, { verdict: 'pass' }]);
    expect(criteriaFingerprint(a)).not.toBe(criteriaFingerprint(b));
  });

  it('changes when the overall verdict changes even if per-criterion verdicts match', () => {
    const a = state('fail', [{ verdict: 'UNVERIFIED' }]);
    const b = state('unverified', [{ verdict: 'UNVERIFIED' }]);
    expect(criteriaFingerprint(a)).not.toBe(criteriaFingerprint(b));
  });

  it('is order-independent — criteria are keyed by index, not array position', () => {
    const a = state('fail', [{ index: 0, verdict: 'fail' }, { index: 1, verdict: 'pass' }]);
    const b = state('fail', [{ index: 1, verdict: 'pass' }, { index: 0, verdict: 'fail' }]);
    expect(criteriaFingerprint(a)).toBe(criteriaFingerprint(b));
  });

  it('distinguishes no-verdict-at-all from any verdict', () => {
    expect(criteriaFingerprint(null)).toBe('none');
    expect(criteriaFingerprint(state('fail', [{ verdict: 'fail' }]))).not.toBe('none');
  });
});

describe('decideCriteriaRearm', () => {
  const fresh = { fingerprint: 'fp-A', previousFingerprint: null, cycles: 0, tasksCreatedSinceRearm: 0, alreadyEscalated: false };

  it('re-arms the organizer the first time a verdict fails', () => {
    const d = decideCriteriaRearm(fresh);
    expect(d.action).toBe('rearm');
    expect(d.nextCycles).toBe(1);
  });

  it('re-arms again when the verdict shape changed — that is new information', () => {
    const d = decideCriteriaRearm({ ...fresh, previousFingerprint: 'fp-OLD', cycles: 3 });
    expect(d.action).toBe('rearm');
    expect(d.nextCycles).toBe(1);
  });

  it('escalates when the verdict is unchanged and the last cycle filed nothing', () => {
    const d = decideCriteriaRearm({ ...fresh, previousFingerprint: 'fp-A', cycles: 1 });
    expect(d.action).toBe('escalate');
    expect(d.reason).toMatch(/filed no work/i);
  });

  it('waits instead of re-arming while the work the last cycle filed is still in flight', () => {
    const d = decideCriteriaRearm({ ...fresh, previousFingerprint: 'fp-A', cycles: 1, tasksCreatedSinceRearm: 2 });
    expect(d.action).toBe('wait');
    expect(d.nextCycles).toBe(2);
  });

  it('escalates once the cycle budget is spent even while work keeps being filed', () => {
    const d = decideCriteriaRearm({
      ...fresh,
      previousFingerprint: 'fp-A',
      cycles: MAX_REARM_CYCLES,
      tasksCreatedSinceRearm: 2,
    });
    expect(d.action).toBe('escalate');
    expect(d.reason).toMatch(/cycle/i);
  });

  it('stays silent once escalated — the owner owes a decision, not another note', () => {
    const d = decideCriteriaRearm({ ...fresh, previousFingerprint: 'fp-A', cycles: 2, alreadyEscalated: true });
    expect(d.action).toBe('wait');
  });

  it('re-arms after an escalation if the verdict shape finally changed', () => {
    const d = decideCriteriaRearm({ ...fresh, previousFingerprint: 'fp-OLD', cycles: 9, alreadyEscalated: true });
    expect(d.action).toBe('rearm');
    expect(d.nextCycles).toBe(1);
  });
});

describe('formatVerdictLines', () => {
  it('names every non-passing criterion with its verdict and evidence', () => {
    const lines = formatVerdictLines(state('fail', [
      { label: 'Design doc exists', verdict: 'fail', evidence: 'No artifact matching (type="content") found' },
      { label: 'One owner for mission state', verdict: 'NOT_EVALUATED', evidence: 'not graded this round' },
      { label: 'All PRs merged', verdict: 'pass', evidence: 'All 2 PR(s) merged' },
    ]));
    expect(lines).toContain('- [fail] Design doc exists — No artifact matching (type="content") found');
    expect(lines).toContain('- [NOT_EVALUATED] One owner for mission state — not graded this round');
    expect(lines).not.toContain('All PRs merged');
  });

  it('returns an empty string when there is no verdict to relay', () => {
    expect(formatVerdictLines(null)).toBe('');
  });
});
