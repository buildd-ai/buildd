import { describe, it, expect } from 'bun:test';
import { parseReviewBlockers, firstSentence, reviewDecisionLine, blockerLabel } from './review-decision';

describe('parseReviewBlockers', () => {
  it('keeps well-formed entries and drops the rest', () => {
    expect(parseReviewBlockers([
      { kind: 'migration', text: 'Adds a table' },
      { kind: 'nonsense', text: 'Unknown kinds read as other' },
      { kind: 'ci' },
      'not an object',
      { kind: 'scope', text: '   ' },
    ])).toEqual([
      { kind: 'migration', text: 'Adds a table' },
      { kind: 'other', text: 'Unknown kinds read as other' },
    ]);
  });
  it('old rows without the field read as no blockers', () => {
    expect(parseReviewBlockers(undefined)).toEqual([]);
    expect(parseReviewBlockers('a string')).toEqual([]);
  });
});

describe('firstSentence', () => {
  it('stops at the first sentence end, not at dots inside a file name', () => {
    expect(firstSentence('The diff touches lib/schema.ts and drizzle/0001_x.sql. Workspace policy needs a person.'))
      .toBe('The diff touches lib/schema.ts and drizzle/0001_x.sql.');
  });
  it('caps a run-on sentence', () => {
    const long = 'word '.repeat(80).trim();
    const out = firstSentence(long);
    expect(out.length).toBeLessThanOrEqual(141);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('reviewDecisionLine', () => {
  it('leads with the recommendation', () => {
    expect(reviewDecisionLine({ recommendation: 'Approve the new table.', reason: 'Long reason. More.' })).toBe('Approve the new table.');
  });
  it('falls back to the first sentence of the reason', () => {
    expect(reviewDecisionLine({ recommendation: null, reason: 'Two things block this. First one.' })).toBe('Two things block this.');
  });
  it('a blank recommendation does not win', () => {
    expect(reviewDecisionLine({ recommendation: '  ', reason: 'Reason here.' })).toBe('Reason here.');
  });
});

it('every blocker kind has a plain label', () => {
  expect(blockerLabel('merge_conflict')).toBe('merge conflict');
  expect(blockerLabel('policy_gate')).toBe('needs a person');
});
