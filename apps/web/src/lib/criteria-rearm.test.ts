import { describe, it, expect } from 'bun:test';
import {
  criteriaFingerprint,
  decideCriteriaRearm,
  formatVerdictLines,
  inferCriteriaFailureReading,
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

describe('two-tick scenario — dd2166e8 regression', () => {
  // Mission dd2166e8 burned evaluator sessions in a loop: all tasks done, both
  // PRs merged, verdict stuck at `overall: fail` with one NOT_EVALUATED prose
  // criterion. Each lap the LLM rephrased the same failure. The guard must treat
  // rephrased evidence as unchanged and escalate to the owner on the second tick.
  it('escalates on the second tick when the verdict shape is identical but evidence was reworded', () => {
    const tick1State = state('fail', [
      { fingerprint: 'fp1', verdict: 'fail', evidence: 'No artifact matching (type="content") found' },
      { fingerprint: 'fp2', verdict: 'NOT_EVALUATED', evidence: 'Could not evaluate this criterion this round' },
      { fingerprint: 'fp3', verdict: 'fail', evidence: 'PR is still open' },
    ]);
    const tick2State = state('fail', [
      { fingerprint: 'fp1', verdict: 'fail', evidence: 'A content artifact was not present in this mission' },
      { fingerprint: 'fp2', verdict: 'NOT_EVALUATED', evidence: 'Evaluation skipped: another criterion already failed' },
      { fingerprint: 'fp3', verdict: 'fail', evidence: 'The pull request has not been merged' },
    ]);

    const fp1 = criteriaFingerprint(tick1State);
    const fp2 = criteriaFingerprint(tick2State);
    // Evidence wording must not affect the fingerprint.
    expect(fp1).toBe(fp2);

    // Tick 1: no prior fingerprint → re-arm the organizer.
    const tick1 = decideCriteriaRearm({
      fingerprint: fp1,
      previousFingerprint: null,
      cycles: 0,
      tasksCreatedSinceRearm: 0,
      alreadyEscalated: false,
    });
    expect(tick1.action).toBe('rearm');

    // Tick 2: same fingerprint, organizer ran but filed no work → escalate.
    const tick2 = decideCriteriaRearm({
      fingerprint: fp2,
      previousFingerprint: fp1,
      cycles: tick1.nextCycles,
      tasksCreatedSinceRearm: 0,
      alreadyEscalated: false,
    });
    expect(tick2.action).toBe('escalate');
    expect(tick2.reason).toMatch(/filed no work/i);
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

describe('inferCriteriaFailureReading', () => {
  it('reads all-prose failures as an unmeasurable criterion', () => {
    const s = state('fail', [
      { type: 'description', verdict: 'fail' },
      { type: 'description', verdict: 'NOT_EVALUATED' },
    ]);
    expect(inferCriteriaFailureReading(s)).toBe('criterion_unmeasurable');
  });

  it('reads all-mechanical failures as unowned work', () => {
    const s = state('fail', [
      { type: 'no_open_tasks', verdict: 'fail' },
      { type: 'all_prs_merged', verdict: 'fail' },
    ]);
    expect(inferCriteriaFailureReading(s)).toBe('work_unowned');
  });

  it('gives no steer on a mix of prose and mechanical failures', () => {
    const s = state('fail', [
      { type: 'description', verdict: 'fail' },
      { type: 'command', verdict: 'fail' },
    ]);
    expect(inferCriteriaFailureReading(s)).toBe('mixed');
  });

  it('ignores passing criteria when reading the failure pattern', () => {
    const s = state('fail', [
      { type: 'description', verdict: 'fail' },
      { type: 'command', verdict: 'pass' },
    ]);
    expect(inferCriteriaFailureReading(s)).toBe('criterion_unmeasurable');
  });

  it('returns null when there is no non-passing criterion', () => {
    expect(inferCriteriaFailureReading(state('pass', [{ verdict: 'pass' }]))).toBeNull();
    expect(inferCriteriaFailureReading(null)).toBeNull();
  });
});
