import { describe, expect, it } from 'bun:test';
import {
  CLAIM_GOLD_SOURCE,
  claimHoldObjective,
  gradeClaimDecision,
  type ClaimGoldInput,
  type ClaimGoldSide,
} from '../orchestration-claim-gold';

// Synthetic fixtures only.
const merged = (files: string[], over: Partial<ClaimGoldSide> = {}): ClaimGoldSide => ({
  taskId: over.taskId ?? 'task-a',
  taskStatus: 'completed',
  pr: { number: 101, mergedAt: new Date('2026-01-02T00:00:00Z'), files },
  conflictRetry: false,
  ...over,
});

const input = (over: Partial<ClaimGoldInput>): ClaimGoldInput => ({
  answer: 'START',
  candidate: merged(['apps/web/src/a.ts'], { taskId: 'cand' }),
  holder: merged(['apps/web/src/b.ts'], { taskId: 'hold' }),
  superseded: false,
  ...over,
});

describe('gradeClaimDecision: START', () => {
  it('right when both merged, files disjoint and no retry', () => {
    const g = gradeClaimDecision(input({}));
    expect(g).toEqual({ status: 'labelled', right: 'START', decisionWasRight: true, reason: 'start_disjoint_clean' });
  });

  it('wrong when a conflict-resolution retry followed on the started side', () => {
    const g = gradeClaimDecision(input({ candidate: merged(['apps/web/src/a.ts'], { taskId: 'cand', conflictRetry: true }) }));
    expect(g).toEqual({ status: 'labelled', right: 'HOLD', decisionWasRight: false, reason: 'start_conflict_retry' });
  });

  it('wrong when a conflict or migration-collision retry followed on the holder side', () => {
    const g = gradeClaimDecision(input({ holder: merged(['packages/core/drizzle/0001_x.sql'], { taskId: 'hold', conflictRetry: true }) }));
    expect(g).toMatchObject({ status: 'labelled', right: 'HOLD', reason: 'start_conflict_retry' });
  });

  it('wrong when one PR superseded the other, even though only one side merged', () => {
    const g = gradeClaimDecision(input({
      holder: { taskId: 'hold', taskStatus: 'completed', pr: { number: 102, mergedAt: null, files: ['apps/web/src/a.ts'] }, conflictRetry: false },
      superseded: true,
    }));
    expect(g).toMatchObject({ status: 'labelled', right: 'HOLD', reason: 'start_superseded' });
  });

  it('unknown when the merged diffs overlap but nothing went wrong', () => {
    const g = gradeClaimDecision(input({ holder: merged(['apps/web/src/a.ts'], { taskId: 'hold' }) }));
    expect(g).toEqual({ status: 'unknown', reason: 'start_overlap_without_conflict' });
  });
});

describe('gradeClaimDecision: HOLD', () => {
  it('right when the holder diff intersected the waiting task diff', () => {
    const g = gradeClaimDecision(input({
      answer: 'HOLD',
      holder: merged(['apps/web/src/a.ts', 'apps/web/src/c.ts'], { taskId: 'hold' }),
    }));
    expect(g).toEqual({ status: 'labelled', right: 'HOLD', decisionWasRight: true, reason: 'hold_overlap' });
  });

  it('wrong (unnecessary wait) when the diffs were disjoint', () => {
    const g = gradeClaimDecision(input({ answer: 'HOLD' }));
    expect(g).toEqual({ status: 'labelled', right: 'START', decisionWasRight: false, reason: 'hold_disjoint' });
  });

  it('a supersession says nothing about a wait: never merged is unknown', () => {
    const g = gradeClaimDecision(input({
      answer: 'HOLD',
      candidate: { taskId: 'cand', taskStatus: 'completed', pr: { number: 101, mergedAt: null, files: ['apps/web/src/a.ts'] }, conflictRetry: false },
      superseded: true,
    }));
    expect(g).toEqual({ status: 'unknown', reason: 'candidate_not_merged' });
  });
});

describe('gradeClaimDecision: unknown, never guessed', () => {
  for (const answer of ['START', 'HOLD'] as const) {
    it(`${answer}: missing candidate or holder`, () => {
      expect(gradeClaimDecision(input({ answer, candidate: null }))).toEqual({ status: 'unknown', reason: 'candidate_missing' });
      expect(gradeClaimDecision(input({ answer, holder: null }))).toEqual({ status: 'unknown', reason: 'holder_missing' });
    });

    it(`${answer}: a cancelled side`, () => {
      expect(gradeClaimDecision(input({ answer, candidate: merged(['a'], { taskStatus: 'cancelled' }) })))
        .toEqual({ status: 'unknown', reason: 'candidate_cancelled' });
      expect(gradeClaimDecision(input({ answer, holder: merged(['b'], { taskStatus: 'cancelled' }) })))
        .toEqual({ status: 'unknown', reason: 'holder_cancelled' });
    });

    it(`${answer}: a task not yet settled`, () => {
      expect(gradeClaimDecision(input({ answer, holder: merged(['b'], { taskStatus: 'in_progress' }) })))
        .toEqual({ status: 'unknown', reason: 'holder_not_settled' });
    });

    it(`${answer}: a side with no PR, or a PR never merged`, () => {
      expect(gradeClaimDecision(input({ answer, candidate: { taskId: 'c', taskStatus: 'completed', pr: null, conflictRetry: false } })))
        .toEqual({ status: 'unknown', reason: 'candidate_no_pr' });
      expect(gradeClaimDecision(input({ answer, holder: { taskId: 'h', taskStatus: 'failed', pr: { number: 9, mergedAt: null, files: ['b'] }, conflictRetry: false } })))
        .toEqual({ status: 'unknown', reason: 'holder_not_merged' });
    });

    it(`${answer}: a merged PR whose file list is missing`, () => {
      expect(gradeClaimDecision(input({ answer, holder: { taskId: 'h', taskStatus: 'completed', pr: { number: 9, mergedAt: new Date(), files: null }, conflictRetry: false } })))
        .toEqual({ status: 'unknown', reason: 'holder_files_missing' });
    });
  }

  it('a cancelled side outranks retry evidence on a START', () => {
    const g = gradeClaimDecision(input({ candidate: merged(['a'], { taskStatus: 'cancelled', conflictRetry: true }) }));
    expect(g).toEqual({ status: 'unknown', reason: 'candidate_cancelled' });
  });

  it('an answer that is neither START nor HOLD is not graded', () => {
    expect(gradeClaimDecision(input({ answer: 'MAYBE' as never }))).toEqual({ status: 'unknown', reason: 'no_answer' });
  });
});

describe('gradeClaimDecision: file comparison', () => {
  it('ignores blanks, whitespace, duplicates and a leading ./', () => {
    const g = gradeClaimDecision(input({
      answer: 'HOLD',
      candidate: merged([' ./apps/web/src/a.ts ', ''], { taskId: 'cand' }),
      holder: merged(['apps/web/src/a.ts', 'apps/web/src/a.ts'], { taskId: 'hold' }),
    }));
    expect(g).toMatchObject({ status: 'labelled', reason: 'hold_overlap' });
  });

  it('an empty merged diff is evidence of nothing, not of disjointness', () => {
    expect(gradeClaimDecision(input({ holder: merged([], { taskId: 'hold' }) })))
      .toEqual({ status: 'unknown', reason: 'holder_files_missing' });
  });
});

describe('claimHoldObjective', () => {
  it('scores an answer against the right answer the gold names', () => {
    expect(claimHoldObjective.source).toBe(CLAIM_GOLD_SOURCE);
    expect(claimHoldObjective.score({ label: 'START', value: null }, 'START')).toBe(true);
    expect(claimHoldObjective.score({ label: 'START', value: null }, 'HOLD')).toBe(false);
    expect(claimHoldObjective.score({ label: 'HOLD', value: null }, 'HOLD')).toBe(true);
  });

  it('says nothing for a label or answer outside the vocabulary', () => {
    expect(claimHoldObjective.score({ label: 'unknown', value: null }, 'START')).toBeNull();
    expect(claimHoldObjective.score({ label: 'HOLD', value: null }, 'maybe')).toBeNull();
  });
});
