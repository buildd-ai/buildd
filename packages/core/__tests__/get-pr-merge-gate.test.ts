/**
 * Spec 072de598 I-12 / AC-10: get_pr never reads "Ready to merge" while the
 * mission merge gate holds the PR; it names the gate's own reason instead.
 */
import { describe, expect, it } from 'bun:test';
import { formatGetPrDelivery } from '../mcp-tools';

const delivery = {
  headline: 'Approved', detail: null, review: { line: '1 round, approved' }, repairs: [],
  reviewApproval: { state: 'success', description: 'Ready to merge: 127d7b9 approved by review' },
};

describe('get_pr and the mission merge gate', () => {
  it('a held PR: the gate reason leads, and the approval is not called ready to merge', () => {
    const out = formatGetPrDelivery({ delivery, mergeGate: { blocks: true, reason: 'The visual review found issues on commit 127d7b92.' } });
    expect(out.mergeGateLine).toBe('Merge blocked: The visual review found issues on commit 127d7b92.');
    expect(out.approvalLine).toBe('Review approval: Approved: 127d7b9 approved by review');
    expect(out.approvalLine).not.toContain('Ready to merge');
  });

  it('no gate: unchanged', () => {
    const out = formatGetPrDelivery({ delivery });
    expect(out.mergeGateLine).toBe('');
    expect(out.approvalLine).toBe('Review approval: Ready to merge: 127d7b9 approved by review');
  });
});
