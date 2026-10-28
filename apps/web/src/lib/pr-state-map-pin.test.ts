import { describe, expect, it } from 'bun:test';
import { TERMINAL_PR_LIFECYCLE, isTerminalPrLifecycle } from './dep-gate-contract';
import { derivePrDisplayState } from './pr-presentation';
import { DEAD_PR_LIFECYCLE } from './mission-work-state';

const ALL = ['pr_open', 'ci_running', 'ci_green', 'ci_failed', 'conflict', 'merged', 'closed', 'unresolvable', null, undefined, 'bogus'];

describe('one PR-state map', () => {
  it('pins the terminal set', () => {
    expect([...TERMINAL_PR_LIFECYCLE].sort()).toEqual(['closed', 'merged', 'unresolvable']);
  });
  it('mission DEAD_PR_LIFECYCLE is the shared terminal set', () => {
    expect([...DEAD_PR_LIFECYCLE].sort()).toEqual([...TERMINAL_PR_LIFECYCLE].sort());
  });
  it('terminal lifecycle <=> display state merged/closed/unresolvable', () => {
    for (const s of ALL) {
      const d = derivePrDisplayState(s, null);
      expect(isTerminalPrLifecycle(s)).toBe(d === 'merged' || d === 'closed' || d === 'unresolvable');
    }
  });
  it('pins display mapping', () => {
    expect(ALL.map(s => derivePrDisplayState(s, null))).toEqual([
      'awaiting_ci', 'ci_running', 'ci_passed', 'ci_failed', 'conflict', 'merged', 'closed', 'unresolvable', 'open', 'open', 'open',
    ]);
    expect(derivePrDisplayState('pr_open', new Date())).toBe('merged');
  });
});
