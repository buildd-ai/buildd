import { describe, expect, it } from 'bun:test';
import { OVERLAP_GOLD_SOURCE, gradeOverlapDecision, overlapRealObjective, type OverlapGoldInput, type OverlapGoldSide } from '../overlap-real-gold';

const MERGED = new Date('2026-10-02T00:00:00Z');

function side(over: Partial<OverlapGoldSide> = {}): OverlapGoldSide {
  return { taskStatus: 'completed', pr: { mergedAt: MERGED, files: ['packages/a.ts'] }, conflictRetry: false, ...over };
}
function input(over: Partial<OverlapGoldInput> = {}): OverlapGoldInput {
  return {
    decisionId: 'buildd.orchestration_overlap_real',
    answer: 'NOT_REAL',
    newTask: side(),
    other: side({ pr: { mergedAt: MERGED, files: ['packages/b.ts'] } }),
    superseded: false,
    ...over,
  };
}

describe('gradeOverlapDecision', () => {
  it('both merged, disjoint files, no repair: NOT_REAL was right (no order was needed)', () => {
    expect(gradeOverlapDecision(input())).toEqual({ status: 'labelled', right: 'NOT_REAL', reason: 'merged_disjoint_clean', decisionWasRight: true });
  });

  it('a conflict retry on either side after the decision: REAL was right, whatever the files say', () => {
    expect(gradeOverlapDecision(input({ other: side({ conflictRetry: true, pr: { mergedAt: MERGED, files: ['packages/b.ts'] } }) })))
      .toMatchObject({ right: 'REAL', reason: 'conflict_retry', decisionWasRight: false });
    expect(gradeOverlapDecision(input({ answer: 'REAL', newTask: side({ conflictRetry: true }), other: side({ taskStatus: 'in_progress', pr: null }) })))
      .toMatchObject({ right: 'REAL', reason: 'conflict_retry', decisionWasRight: true });
  });

  it('one PR superseding the other: REAL', () => {
    expect(gradeOverlapDecision(input({ superseded: true }))).toMatchObject({ right: 'REAL', reason: 'superseded' });
  });

  it('merged diffs that intersect: REAL', () => {
    expect(gradeOverlapDecision(input({ answer: 'REAL', other: side() }))).toMatchObject({ right: 'REAL', reason: 'merged_overlap', decisionWasRight: true });
  });

  describe('unknown', () => {
    const cases: Array<[string, Partial<OverlapGoldInput>, string]> = [
      ['another decision under the same capability (size bucket)', { decisionId: 'buildd.orchestration_size_bucket' }, 'not_overlap_decision'],
      ['no answer', { answer: null }, 'no_answer'],
      ['a side missing', { other: null }, 'other_missing'],
      ['a side cancelled', { newTask: side({ taskStatus: 'cancelled' }) }, 'new_task_cancelled'],
      ['a side still running', { other: side({ taskStatus: 'in_progress' }) }, 'other_not_settled'],
      ['a side with no PR', { other: side({ pr: null }) }, 'other_no_pr'],
      ['a side not merged', { newTask: side({ pr: { mergedAt: null, files: ['x'] } }) }, 'new_task_not_merged'],
      ['a side with no file list', { other: side({ pr: { mergedAt: MERGED, files: [] } }) }, 'other_files_missing'],
    ];
    for (const [name, over, reason] of cases) {
      it(name, () => expect(gradeOverlapDecision(input(over))).toEqual({ status: 'unknown', reason }));
    }
  });
});

describe('overlapRealObjective', () => {
  it('scores REAL / NOT_REAL against the gold', () => {
    expect(overlapRealObjective.source).toBe(OVERLAP_GOLD_SOURCE);
    expect(overlapRealObjective.score({ label: 'REAL', value: null }, 'REAL')).toBe(true);
    expect(overlapRealObjective.score({ label: 'REAL', value: null }, 'NOT_REAL')).toBe(false);
    expect(overlapRealObjective.score({ label: 'M', value: null }, 'REAL')).toBeNull();
  });
});
