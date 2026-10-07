/**
 * The landing family's effect handlers (T15–T17, §14 Slice C). The handlers'
 * behaviour on real Postgres — the pinned merge call, verification, the
 * post-merge work — is S10/S15 in
 * apps/web/tests/db/workflow-matrix.test.ts; this file pins the pure mapping
 * from GitHub's merge answer to the T16 outcome, and the composition.
 */
import { describe, expect, test } from 'bun:test';
import { classifyMergeCall, withLandingEffects } from './pr-landing-effects';

describe('classifyMergeCall: GitHub answer → MergeCallResult outcome', () => {
  const no = (message: string, indeterminate = false) => classifyMergeCall({ merged: false, message, indeterminate });
  test('a merge is "merged" (still verified by a live read before it is a fact)', () => {
    expect(classifyMergeCall({ merged: true, message: 'Pull Request successfully merged' })).toBe('merged');
  });
  test('a lost answer is indeterminate, never a refusal', () => {
    expect(no('Could not reach GitHub: socket hang up', true)).toBe('indeterminate');
    // GitHub also says "not mergeable" to a PR that merged a moment ago: read before deciding.
    expect(no('Pull Request is not mergeable')).toBe('indeterminate');
  });
  test('a moved head is not a refusal: nothing landed and the new head has its own fact', () => {
    expect(no('Head branch was modified. Review and try the merge again.')).toBe('not_merged');
  });
  test('an out-of-date branch or a base that moved during the call is a refresh, not a person', () => {
    expect(no('Base branch was modified. Review and try the merge again.')).toBe('behind');
    expect(no('Head branch is out of date')).toBe('behind');
    expect(no('At least 1 approving review is required and the branch was not up to date')).toBe('behind');
  });
  test('a textual conflict is a conflict repair', () => {
    expect(no('Merge conflict')).toBe('conflict');
  });
  test('anything else GitHub definitely refused goes to a person', () => {
    expect(no('Required status check "build" is expected.')).toBe('refused');
    expect(no('Resource not accessible by integration')).toBe('refused');
  });
});

test('withLandingEffects composes every landing and post-merge effect the reducer emits', () => {
  const h = withLandingEffects({}) as Record<string, unknown>;
  for (const k of ['merge_call', 'verify_merge', 'emit_pr_merged', 'finalize_mission_pr']) {
    expect(typeof h[k]).toBe('function');
  }
});

// T16's behind/conflict is a conflict-family repair: its handlers are conflict-retry-effects.ts's,
// so the landing family must not register a second one that shadows them by composition order.
test('withLandingEffects adds no conflict-family handler', () => {
  expect(Object.keys(withLandingEffects({})).sort()).toEqual(['emit_pr_merged', 'finalize_mission_pr', 'merge_call', 'verify_merge']);
});
