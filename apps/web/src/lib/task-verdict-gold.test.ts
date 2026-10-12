import { describe, expect, it } from 'bun:test';
import { TASK_VERDICT_GOLD_SOURCE, gradeVerdictDecision, taskVerdictObjective, type VerdictGoldInput } from './task-verdict-gold';

const T0 = new Date('2026-10-01T10:00:00Z');

function input(over: Partial<VerdictGoldInput> = {}): VerdictGoldInput {
  return {
    kind: 'headline',
    answer: 'rerun_checks',
    decidedHeadSha: 'aaa111',
    nextRun: { conclusion: 'success', headSha: 'aaa111', at: new Date(T0.getTime() + 600_000) },
    prTextEditedBeforeRun: false,
    newHeadOnlyMergedBase: false,
    prClosedUnmerged: false,
    ...over,
  };
}

describe('gradeVerdictDecision — headline', () => {
  it('green again on the same head with the PR text untouched: re-running was right', () => {
    expect(gradeVerdictDecision(input())).toEqual({ status: 'labelled', label: 'rerun_checks', reason: 'passed_unchanged' });
  });

  it('green on the same head after the PR text was edited: the PR text was the fix', () => {
    expect(gradeVerdictDecision(input({ answer: 'fix_code', prTextEditedBeforeRun: true })))
      .toEqual({ status: 'labelled', label: 'fix_pr_metadata', reason: 'passed_after_text_edit' });
  });

  it('green on a new head that is a real change: the code was the fix', () => {
    expect(gradeVerdictDecision(input({ nextRun: { conclusion: 'success', headSha: 'bbb222', at: T0 } })))
      .toEqual({ status: 'labelled', label: 'fix_code', reason: 'passed_after_push' });
  });

  it('red again on the same head: re-running was wrong, and nothing more is claimed', () => {
    expect(gradeVerdictDecision(input({ nextRun: { conclusion: 'failure', headSha: 'aaa111', at: T0 } })))
      .toEqual({ status: 'labelled', label: 'not:rerun_checks', reason: 'failed_unchanged' });
  });

  describe('unknown', () => {
    const cases: Array<[string, Partial<VerdictGoldInput>, string]> = [
      ['no answer', { answer: null }, 'no_answer'],
      ['an answer outside the vocabulary', { answer: 'merge' }, 'no_answer'],
      ['no later run', { nextRun: null }, 'no_next_run'],
      ['no recorded head', { decidedHeadSha: null }, 'head_missing'],
      ['PR closed unmerged', { prClosedUnmerged: true }, 'pr_closed'],
      ['text edit unknown', { prTextEditedBeforeRun: null }, 'text_edit_unknown'],
      ['new head that only merged the base', { nextRun: { conclusion: 'success', headSha: 'bbb222', at: T0 }, newHeadOnlyMergedBase: true }, 'push_only_merged_base'],
      ['new head, merge-only unknown', { nextRun: { conclusion: 'success', headSha: 'bbb222', at: T0 }, newHeadOnlyMergedBase: null }, 'push_only_merged_base'],
      ['red on a new head', { nextRun: { conclusion: 'failure', headSha: 'bbb222', at: T0 } }, 'failed_after_push'],
    ];
    for (const [name, over, reason] of cases) {
      it(name, () => expect(gradeVerdictDecision(input(over))).toEqual({ status: 'unknown', reason }));
    }
  });
});

describe('gradeVerdictDecision — mismatch diagnosis', () => {
  it('green on the same head: flaky CI was right', () => {
    expect(gradeVerdictDecision(input({ kind: 'mismatch_diagnosis', answer: 'wrong_check' })))
      .toEqual({ status: 'labelled', label: 'flaky_ci', reason: 'passed_unchanged' });
  });

  it('red again on the same head: flaky CI was wrong', () => {
    expect(gradeVerdictDecision(input({ kind: 'mismatch_diagnosis', answer: 'flaky_ci', nextRun: { conclusion: 'failure', headSha: 'aaa111', at: T0 } })))
      .toEqual({ status: 'labelled', label: 'not:flaky_ci', reason: 'failed_unchanged' });
  });

  it('green after a push says nothing about which non-flaky diagnosis it was', () => {
    expect(gradeVerdictDecision(input({ kind: 'mismatch_diagnosis', answer: 'fix_not_applied', nextRun: { conclusion: 'success', headSha: 'bbb222', at: T0 } })))
      .toEqual({ status: 'labelled', label: 'not:flaky_ci', reason: 'passed_after_push' });
  });
});

describe('gradeVerdictDecision — error class', () => {
  it('has no mechanical truth: always unknown', () => {
    expect(gradeVerdictDecision(input({ kind: 'error_class', answer: 'noise' }))).toEqual({ status: 'unknown', reason: 'no_mechanical_truth' });
  });
});

describe('taskVerdictObjective', () => {
  it('scores a positive label by equality and a negative one only against the named answer', () => {
    expect(taskVerdictObjective.source).toBe(TASK_VERDICT_GOLD_SOURCE);
    expect(taskVerdictObjective.score({ label: 'fix_code', value: null }, 'fix_code')).toBe(true);
    expect(taskVerdictObjective.score({ label: 'fix_code', value: null }, 'rerun_checks')).toBe(false);
    expect(taskVerdictObjective.score({ label: 'not:rerun_checks', value: null }, 'rerun_checks')).toBe(false);
    expect(taskVerdictObjective.score({ label: 'not:rerun_checks', value: null }, 'fix_code')).toBeNull();
    expect(taskVerdictObjective.score({ label: 'flaky_ci', value: null }, 'fix_code')).toBeNull();
  });
});
