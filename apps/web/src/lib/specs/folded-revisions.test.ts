import { describe, expect, test } from 'bun:test';
import { foldedRevisions, foldedLine } from './folded-revisions';

// Living Spec b7fc9316 (draft revision 7) R-30, R-39: one row per spec; the
// unapproved revisions between the approved one and the head fold under it.
describe('foldedRevisions', () => {
  test('revisions strictly between the approved revision and the head', () => {
    expect(foldedRevisions(2, 6)).toEqual([3, 4, 5]);
  });
  test('none when the head is the next revision after the approved one', () => {
    expect(foldedRevisions(2, 3)).toEqual([]);
  });
  test('with nothing approved, every revision before the head folds', () => {
    expect(foldedRevisions(null, 4)).toEqual([1, 2, 3]);
    expect(foldedRevisions(null, 1)).toEqual([]);
  });
});

describe('foldedLine', () => {
  test('lists the folded numbers, singular and plural', () => {
    expect(foldedLine([3])).toBe('Folds revision 3');
    expect(foldedLine([3, 4, 5])).toBe('Folds revisions 3, 4 and 5');
    expect(foldedLine([])).toBeNull();
  });
});
