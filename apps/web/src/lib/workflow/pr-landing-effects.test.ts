/**
 * The landing family's effect handlers (T15–T17, §14 Slice C). The handlers'
 * behaviour on real Postgres — the pinned merge call, verification, the
 * post-merge work — is S10/S15 in
 * apps/web/tests/db/workflow-matrix.test.ts; this file pins the pure mapping
 * from GitHub's merge answer to the T16 outcome, and the composition.
 */
import { describe, expect, test } from 'bun:test';
import { classifyMergeCall, mergeRetryAt, withLandingEffects } from './pr-landing-effects';

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
  test('a rate limit (403/429) is not a refusal: nothing landed, landing may be asked again', () => {
    const st = (status: number, message: string, retryAfterMs?: number) => classifyMergeCall({ merged: false, message, status, ...(retryAfterMs != null ? { retryAfterMs } : {}) });
    expect(st(403, 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.')).toBe('not_merged');
    expect(st(429, 'You have exceeded a secondary rate limit.')).toBe('not_merged');
    expect(st(429, 'Too Many Requests')).toBe('not_merged');
    expect(st(403, 'API rate limit exceeded for installation ID 1.')).toBe('not_merged');
    // A 403 GitHub sent reset headers with is a rate limit whatever its text says.
    expect(st(403, 'Forbidden', 60_000)).toBe('not_merged');
    // A 403 that is not a rate limit is still a refusal.
    expect(st(403, 'Resource not accessible by integration')).toBe('refused');
  });
  test('a 5xx is GitHub failing, not refusing: indeterminate, verified by a live read', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyMergeCall({ merged: false, message: 'Server Error', status })).toBe('indeterminate');
    }
  });
  test('a draft PR is waiting on its author, not refused: nothing landed', () => {
    expect(classifyMergeCall({ merged: false, message: 'Pull Request is in draft state', status: 405 })).toBe('not_merged');
  });
  test('the retry time honours retry-after / x-ratelimit-reset; a rate limit without one waits a minute', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    const at = (r: Parameters<typeof mergeRetryAt>[0]) => mergeRetryAt(r, now);
    expect(at({ merged: false, message: 'You have exceeded a secondary rate limit.', status: 429, retryAfterMs: 120_000 })).toBe('2026-10-01T00:02:00.000Z');
    expect(at({ merged: false, message: 'You have exceeded a secondary rate limit.', status: 403 })).toBe('2026-10-01T00:01:00.000Z');
    // Capped: a reset far away is still re-tried within the hour (primary limits reset hourly).
    expect(at({ merged: false, message: 'API rate limit exceeded', status: 403, retryAfterMs: 5 * 3600_000 })).toBe('2026-10-01T01:00:00.000Z');
    expect(at({ merged: false, message: 'Server Error', status: 503, retryAfterMs: 30_000 })).toBe('2026-10-01T00:00:30.000Z');
    expect(at({ merged: false, message: 'Server Error', status: 500 })).toBeNull();
    expect(at({ merged: false, message: 'Resource not accessible by integration', status: 403 })).toBeNull();
    expect(at({ merged: true, message: 'merged', status: 200 })).toBeNull();
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
