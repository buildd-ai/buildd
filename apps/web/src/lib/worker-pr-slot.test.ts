import { describe, it, expect } from 'bun:test';
import { wouldDisplaceLivePr, type WorkerPrSlot } from './worker-pr-slot';

const base: WorkerPrSlot = {
  id: 'w1', workspaceId: 'ws', taskId: 't1', prNumber: 10, prUrl: 'https://github.com/o/r/pull/10',
  mergedAt: null, prLifecycleStatus: 'pr_open',
};

describe('wouldDisplaceLivePr', () => {
  it('a second, different PR would displace the first live one', () => {
    expect(wouldDisplaceLivePr(base, 11)).toBe(true);
  });
  it('re-recording the same PR displaces nothing', () => {
    expect(wouldDisplaceLivePr(base, 10)).toBe(false);
  });
  it('a worker with no PR yet records the first one on itself', () => {
    expect(wouldDisplaceLivePr({ ...base, prNumber: null, prUrl: null }, 11)).toBe(false);
  });
  it('a merged or closed earlier PR may be replaced', () => {
    expect(wouldDisplaceLivePr({ ...base, mergedAt: new Date() }, 11)).toBe(false);
    expect(wouldDisplaceLivePr({ ...base, prLifecycleStatus: 'closed' }, 11)).toBe(false);
  });
  it('without a task there is no sibling to attach to', () => {
    expect(wouldDisplaceLivePr({ ...base, taskId: null }, 11)).toBe(false);
  });
});
