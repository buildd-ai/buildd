import { describe, it, expect } from 'bun:test';
import { landingInstructions } from './seam';

const finding = (o: Record<string, unknown>) => ({ id: 'f', title: 'Null deref', path: 'a.ts', line: 3, required: true, status: 'open', ...o }) as any;

describe('landingInstructions', () => {
  it('names red CI and each open required finding, and says one review is granted', () => {
    const t = landingInstructions({ delivery: { ci: 'red' } as any, findings: [finding({}), finding({ id: 'g', title: 'Waived one', status: 'waived' }), finding({ id: 'h', title: 'Optional', required: false })] });
    expect(t).toContain('CI is red');
    expect(t).toContain('Null deref (a.ts:3)');
    expect(t).not.toContain('Waived one');
    expect(t).not.toContain('Optional');
    expect(t).toContain('Merge the base branch');
    expect(t).toContain('One review of the pushed head is granted');
  });

  it('with green CI and no findings it only merges and confirms', () => {
    const t = landingInstructions({ delivery: { ci: 'green' } as any, findings: [] });
    expect(t).toContain('Confirm CI is green');
    expect(t).not.toContain('Address every open review finding');
  });
});
