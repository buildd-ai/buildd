import { describe, it, expect, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));

const { mergeSelection } = await import('./mission-selection');
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
