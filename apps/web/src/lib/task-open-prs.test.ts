import { describe, it, expect } from 'bun:test';
import { pickOtherOpenPrs } from './task-open-prs';

const url = (n: number) => `https://github.com/o/r/pull/${n}`;
const row = (n: number | null, extra: Partial<{ mergedAt: Date | null; prLifecycleStatus: string | null; prUrl: string | null }> = {}) => ({
  prUrl: n == null ? null : url(n),
  prNumber: n,
  mergedAt: null,
  prLifecycleStatus: 'pr_open',
  ...extra,
});

describe('pickOtherOpenPrs', () => {
  it('lists a sibling PR that is still open', () => {
    expect(pickOtherOpenPrs([row(1), row(2)], { prUrl: url(1) })).toEqual([url(2)]);
  });

  it('never counts the PR that just merged, even on a row not yet stamped', () => {
    expect(pickOtherOpenPrs([row(1)], { prUrl: url(1) })).toEqual([]);
  });

  it('a retry row carrying the same PR is one PR, merged on any row means merged', () => {
    const rows = [row(2, { mergedAt: new Date() }), row(2), row(1)];
    expect(pickOtherOpenPrs(rows, { prUrl: url(1) })).toEqual([]);
  });

  it('a sibling closed, merged or unresolvable no longer holds the task', () => {
    for (const s of ['closed', 'merged', 'unresolvable']) {
      expect(pickOtherOpenPrs([row(1), row(2, { prLifecycleStatus: s })], { prUrl: url(1) })).toEqual([]);
    }
  });

  it('ignores rows with no PR (orphan / research rows)', () => {
    expect(pickOtherOpenPrs([row(null), row(1), { ...row(3), prNumber: null }], { prUrl: url(1) })).toEqual([]);
  });

  it('a sibling with no lifecycle recorded yet counts as open', () => {
    expect(pickOtherOpenPrs([row(1), row(2, { prLifecycleStatus: null })], { prUrl: url(1) })).toEqual([url(2)]);
  });

  it('dedupes a sibling carried on several rows', () => {
    expect(pickOtherOpenPrs([row(1), row(2), row(2)], { prUrl: url(1) })).toEqual([url(2)]);
  });
});
