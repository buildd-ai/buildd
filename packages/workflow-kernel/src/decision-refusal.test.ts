/** Living Spec r7 AC-46: a refused decision is explained in plain words, never as a code. */
import { describe, expect, test } from 'bun:test';
import { decisionRefusalReason, explainDecisionRefusal } from './decision-refusal';

describe('explainDecisionRefusal (AC-46)', () => {
  test('a stale head says the PR has a newer commit and to reload', () => {
    const s = explainDecisionRefusal('force_re_review', 'decision_head_stale');
    expect(s).toStartWith('A forced re-review was not requested: ');
    expect(s).toContain('newer commit');
    expect(s).toContain('Reload');
  });

  test('an unauthorized override or force names what is missing', () => {
    expect(explainDecisionRefusal('approve_override', 'no_merge_permission')).toContain('merge permission');
    expect(explainDecisionRefusal('force_re_review', 'force_requires_human')).toContain('only a person');
    expect(explainDecisionRefusal('request_fix', 'human_required')).toContain('only a person');
  });

  test('no sentence leaks a reason code, and an unknown reason still reads as a sentence', () => {
    for (const r of ['decision_head_stale', 'no_merge_permission', 'force_requires_human', 'review_budget_spent', 'state_moved', 'something_new']) {
      const s = decisionRefusalReason(r);
      expect(s).not.toMatch(/[a-z]+_[a-z_]+/);
      expect(s).toMatch(/\.$/);
    }
  });
});
