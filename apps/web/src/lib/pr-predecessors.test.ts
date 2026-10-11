import { describe, it, expect } from 'bun:test';
import { predecessorsFrom } from './pr-predecessors';

describe('predecessorsFrom (spec workflow-state-kernel §13.11 rule 5)', () => {
  it('collects the owner chain and recorded supersessions, never the PR itself', () => {
    expect(predecessorsFrom(23, [{ lineagePrNumbers: [20, 21, 23] }, null], [19, null])).toEqual([19, 20, 21]);
  });
  it('is empty when nothing is recorded (prose claims are not read)', () => {
    expect(predecessorsFrom(5, [{ note: 'Supersedes #4' }], [])).toEqual([]);
  });
});
