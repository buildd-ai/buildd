import { describe, expect, it } from 'bun:test';
import { viewCriteria } from './task-view';

describe('viewCriteria', () => {
  it('carries a reviewer pass a failing test outranked through as a note', () => {
    const out = viewCriteria([{
      criterionId: 'AC-129', text: 'x', verdict: 'fail', source: 'test', headSha: 'a', stale: false, holds: false,
      notes: [{ verdict: 'pass', source: 'review', headSha: 'a', at: new Date() }],
    }]);
    expect(out[0].verdict).toBe('fail');
    expect(out[0].notes).toEqual([{ verdict: 'pass', source: 'review' }]);
  });
});
