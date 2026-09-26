import { describe, it, expect } from 'bun:test';
import { isInTaskLineage, unresolvedParentIds } from './also-running';

// Regression: the task page's "Also running" list named the task's own CI-fix
// attempt as a peer. An attempt (or the task it is fixing) is this task's own
// work, not something else running alongside it.
describe('isInTaskLineage', () => {
  // root ← task ← ciFix ← ciFixOfFix ;  root ← sibling
  const parentOf = new Map<string, string | null>([
    ['root', null],
    ['task', 'root'],
    ['ciFix', 'task'],
    ['ciFixOfFix', 'ciFix'],
    ['sibling', 'root'],
    ['stranger', null],
  ]);

  it("excludes the task's own CI-fix attempt (a child)", () => {
    expect(isInTaskLineage('ciFix', 'task', parentOf)).toBe(true);
  });

  it('excludes deeper descendants (a fix of the fix)', () => {
    expect(isInTaskLineage('ciFixOfFix', 'task', parentOf)).toBe(true);
  });

  it('excludes ancestors (the task a fix attempt is fixing)', () => {
    expect(isInTaskLineage('task', 'ciFix', parentOf)).toBe(true);
    expect(isInTaskLineage('root', 'ciFixOfFix', parentOf)).toBe(true);
  });

  it('excludes the task itself', () => {
    expect(isInTaskLineage('task', 'task', parentOf)).toBe(true);
  });

  it('keeps siblings and unrelated tasks — those are genuine peers', () => {
    expect(isInTaskLineage('sibling', 'task', parentOf)).toBe(false);
    expect(isInTaskLineage('stranger', 'task', parentOf)).toBe(false);
  });

  it('terminates on a parent cycle', () => {
    const cyclic = new Map<string, string | null>([['a', 'b'], ['b', 'a'], ['c', null]]);
    expect(isInTaskLineage('c', 'a', cyclic)).toBe(false);
  });
});

describe('unresolvedParentIds', () => {
  it('lists parents referenced but not yet loaded', () => {
    const parentOf = new Map<string, string | null>([['a', 'b'], ['c', 'a'], ['d', null]]);
    expect(unresolvedParentIds(parentOf)).toEqual(['b']);
  });
});
