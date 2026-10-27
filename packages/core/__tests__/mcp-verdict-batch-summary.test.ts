import { describe, expect, it } from 'bun:test';
import { batchSummaryText } from '../mcp-specs';

describe('batchSummaryText', () => {
  it('one short reply: counts, then only what did not settle', () => {
    const t = batchSummaryText({
      recorded: 21, counts: { pass: 20, fail: 1 }, refused: [], scope: 21, passing: 20, verdict: 'fail',
      unsettled: [{ criterionId: 'R-9', standing: 'fail' }],
    });
    expect(t).toBe('Recorded 21 verdicts (20 pass, 1 fail). 20 of 21 in scope pass on the target; mission verdict fail.\nNot settled: R-9 fail');
    expect(t.split('\n').length).toBeLessThanOrEqual(2);
  });
  it('names refused items and omits empty sections', () => {
    const t = batchSummaryText({ recorded: 1, counts: { pass: 1 }, refused: [{ criterionId: 'R-2', error: 'not in scope' }], unsettled: [], scope: 1, passing: 1, verdict: 'pass' });
    expect(t).toContain('Recorded 1 verdict (1 pass)');
    expect(t).toContain('Not recorded: R-2 (not in scope)');
    expect(t).not.toContain('Not settled');
  });
});
