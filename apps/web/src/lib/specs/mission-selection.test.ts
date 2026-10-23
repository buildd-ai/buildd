import { describe, it, expect, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));

const { mergeSelection, changedCriteriaOf, parseCreateSelections } = await import('./mission-selection');
import type { GoalCriterion, LivingSpecGoalCriterion } from '@buildd/shared';

const sel = (over: Partial<LivingSpecGoalCriterion> = {}): LivingSpecGoalCriterion => ({
  type: 'living_spec', specId: 's1', specRevisionId: 'r3', revision: 3, contentHash: 'h3', label: 'Spec "X" revision 3', ...over,
});

describe('mergeSelection (outcome spec, Slice 12)', () => {
  const others: GoalCriterion[] = [{ type: 'no_open_tasks' }];

  it('adds the criterion when the mission selects a spec for the first time', () => {
    const r = mergeSelection(others, sel());
    expect(r.changed).toBe(true);
    expect(r.criteria).toHaveLength(2);
  });

  it('is idempotent: the same selection again changes nothing, so recorded verdicts stay valid', () => {
    const once = mergeSelection(others, sel()).criteria;
    const again = mergeSelection(once, sel());
    expect(again.changed).toBe(false);
    expect(again.criteria).toEqual(once);
  });

  it('keeps one criterion per spec: a named new revision replaces the old pin in place', () => {
    const once = mergeSelection(others, sel()).criteria;
    const repinned = mergeSelection(once, sel({ specRevisionId: 'r4', revision: 4, contentHash: 'h4' }));
    expect(repinned.changed).toBe(true);
    expect(repinned.criteria.filter((c) => c.type === 'living_spec')).toHaveLength(1);
    expect((repinned.criteria[1] as LivingSpecGoalCriterion).revision).toBe(4);
  });

  it('leaves other criteria untouched', () => {
    const r = mergeSelection(others, sel());
    expect(r.criteria[0]).toEqual({ type: 'no_open_tasks' });
  });
});

describe('mergeSelection and standards (D-43)', () => {
  it('selecting a spec the mission carries as a standard turns that entry into the outcome: one entry per spec', () => {
    const standard = sel({ role: 'standard', label: 'Standard "X" revision 3' });
    const r = mergeSelection([{ type: 'no_open_tasks' }, standard], sel());
    expect(r.changed).toBe(true);
    const specs = r.criteria.filter((c) => c.type === 'living_spec') as LivingSpecGoalCriterion[];
    expect(specs).toHaveLength(1);
    expect(specs[0].role).toBeUndefined();
  });
});

describe('selection at create (D-41)', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('defaults the scope to what the revision adds, changes or replaces, never what it removes or only moves', () => {
    const lines = [
      { kind: 'added-range', label: 'R-17 to R-19', items: [{ kind: 'added', id: 'R-17', text: 'a', section: 'V' }, { kind: 'added', id: 'R-18', text: 'b', section: 'V' }] },
      { kind: 'changed', id: 'R-3', text: 'x', oldText: 'y', words: [], section: 'M' },
      { kind: 'moved', id: 'R-4', text: 'x', section: 'M', movedFrom: 'N' },
      { kind: 'removed', id: 'R-9', oldText: 'gone', section: 'M' },
      { kind: 'replacing', id: 'AC-11', text: 'x', section: 'AC', replaces: [{ id: 'AC-2', oldText: null }] },
      { kind: 'added', id: 'AC-18', text: 'x', section: 'AC' },
    ] as any;
    expect(changedCriteriaOf(lines)).toEqual(['R-17', 'R-18', 'R-3', 'AC-11', 'AC-18']);
    expect(changedCriteriaOf([])).toEqual([]);
  });

  it('takes one selection or a list, one entry per spec', () => {
    expect(parseCreateSelections({ specId: A })).toEqual({ ok: true, entries: [{ specId: A, revision: undefined, criteria: undefined, narrowedReason: undefined }] });
    const two = parseCreateSelections([{ specId: A, criteria: ['R-1'], narrowedReason: 'only the list rules' }, { specId: B, revision: 3 }]);
    expect(two.ok && two.entries.map((e) => e.specId)).toEqual([A, B]);
    expect(parseCreateSelections([{ specId: A }, { specId: A }])).toEqual({ ok: false, error: expect.stringContaining('one entry per spec') });
  });

  it('refuses waivers, removal, a missing spec id and an empty list at create', () => {
    for (const raw of [[], { specId: 'nav' }, { specId: A, waive: [] }, { remove: true, reason: 'not this one at all' }, 'nav', [null]]) {
      expect(parseCreateSelections(raw).ok).toBe(false);
    }
  });
});
