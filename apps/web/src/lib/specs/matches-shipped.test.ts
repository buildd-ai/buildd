import { describe, expect, it } from 'bun:test';
import { matchesShipped, type ShippedVerdict } from './matches-shipped';

// Living Spec b7fc9316 (revision 7) R-34, AC-35, built ahead of approval:
// a waiting revision "Matches what shipped" when its merged work has a pass
// verdict on every head criterion at the merged commit.

const MERGE = 'a'.repeat(40);
const merges = [{ taskId: 't1', mergeSha: MERGE }];
const criteria = [{ id: 'R-1', textHash: 'h1' }, { id: 'AC-1', textHash: 'h2' }];
const v = (criterionId: string, verdict: ShippedVerdict['verdict'], over: Partial<ShippedVerdict> = {}): ShippedVerdict => ({
  taskId: 't1', criterionId, verdict, headSha: MERGE, at: '2026-11-04T10:00:00Z', textHash: criterionId === 'R-1' ? 'h1' : 'h2', ...over,
});

describe('matchesShipped', () => {
  it('labels the row when every head criterion passed at the merged commit (AC-35)', () => {
    expect(matchesShipped({ criteria, merges, verdicts: [v('R-1', 'pass'), v('AC-1', 'pass')] }))
      .toEqual({ merged: true, matches: true, unmet: [] });
  });

  it('one failed and one with no check: no label, exactly those two are listed (AC-35)', () => {
    expect(matchesShipped({ criteria, merges, verdicts: [v('R-1', 'fail')] }))
      .toEqual({ merged: true, matches: false, unmet: [{ id: 'R-1', state: 'failed' }, { id: 'AC-1', state: 'no_check' }] });
  });

  it('a pass on an older wording does not count', () => {
    const r = matchesShipped({ criteria, merges, verdicts: [v('R-1', 'pass', { textHash: 'old' }), v('AC-1', 'pass')] });
    expect(r.matches).toBe(false);
    expect(r.unmet).toEqual([{ id: 'R-1', state: 'no_check' }]);
  });

  it('a pass with no recorded wording does not count', () => {
    expect(matchesShipped({ criteria, merges, verdicts: [v('R-1', 'pass', { textHash: null }), v('AC-1', 'pass')] }).matches).toBe(false);
  });

  it('a pass at another commit does not count; a short sha of the merge does', () => {
    expect(matchesShipped({ criteria, merges, verdicts: [v('R-1', 'pass', { headSha: 'b'.repeat(40) }), v('AC-1', 'pass')] }).matches).toBe(false);
    expect(matchesShipped({ criteria, merges, verdicts: [v('R-1', 'pass', { headSha: MERGE.slice(0, 7) }), v('AC-1', 'pass')] }).matches).toBe(true);
  });

  it('a verdict is judged against its own task\'s merge commit', () => {
    expect(matchesShipped({ criteria, merges, verdicts: [v('R-1', 'pass', { taskId: 'other' }), v('AC-1', 'pass')] }).matches).toBe(false);
  });

  it('inconclusive and unsupported are no check', () => {
    expect(matchesShipped({ criteria, merges, verdicts: [v('R-1', 'inconclusive'), v('AC-1', 'unsupported')] }).unmet)
      .toEqual([{ id: 'R-1', state: 'no_check' }, { id: 'AC-1', state: 'no_check' }]);
  });

  it('the newest verdict decides: a later fail beats an earlier pass', () => {
    const r = matchesShipped({ criteria, merges, verdicts: [v('R-1', 'pass'), v('R-1', 'fail', { at: '2026-11-04T11:00:00Z' }), v('AC-1', 'pass')] });
    expect(r.unmet).toEqual([{ id: 'R-1', state: 'failed' }]);
  });

  it('passes from two merged tasks together cover the criteria', () => {
    const two = [...merges, { taskId: 't2', mergeSha: 'c'.repeat(40) }];
    expect(matchesShipped({ criteria, merges: two, verdicts: [v('R-1', 'pass'), v('AC-1', 'pass', { taskId: 't2', headSha: 'c'.repeat(40) })] }).matches).toBe(true);
  });

  it('nothing merged, or no criteria: never labelled and nothing listed', () => {
    expect(matchesShipped({ criteria, merges: [], verdicts: [v('R-1', 'pass')] })).toEqual({ merged: false, matches: false, unmet: [] });
    expect(matchesShipped({ criteria: [], merges, verdicts: [] })).toEqual({ merged: true, matches: false, unmet: [] });
  });
});
