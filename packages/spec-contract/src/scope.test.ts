import { describe, expect, it } from 'bun:test';
import { checkCriteriaScope, inScope, scopeOf } from './scope';

const ids = ['R-1', 'R-2', 'AC-1', 'AC-3'];

describe('checkCriteriaScope', () => {
  it('no scope covers every criterion', () => {
    expect(checkCriteriaScope(undefined, ids, 1)).toEqual({ ok: true, criteria: null });
  });

  it('normalizes and de-duplicates ids in the filer\'s order', () => {
    expect(checkCriteriaScope(['AC-03', 'R-1', 'AC-3'], ids, 1)).toEqual({ ok: true, criteria: ['AC-3', 'R-1'] });
  });

  it('refuses an id the revision lacks, a decision, an empty list or a non-list, naming what the revision has', () => {
    const r = checkCriteriaScope(['AC-9', 'D-1'], ids, 4);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toContain('AC-9, D-1, not a criterion of approved revision 4 (it has R-1, R-2, AC-1, AC-3)');
    expect(checkCriteriaScope([], ids, 1).ok).toBe(false);
    expect(checkCriteriaScope('R-1', ids, 1).ok).toBe(false);
  });
});

describe('inScope', () => {
  const criteria = ids.map((id) => ({ id }));
  it('keeps the revision\'s order and only the scoped ids', () => {
    expect(inScope({ criteria: ['AC-3', 'R-1'] }, criteria).map((c) => c.id)).toEqual(['R-1', 'AC-3']);
  });
  it('a pin with no scope answers for all', () => {
    expect(inScope({}, criteria)).toHaveLength(4);
    expect(scopeOf({ criteria: [] })).toBeNull();
  });
});
