import { describe, expect, it } from 'bun:test';
import { hubTarget, hubWords } from './hub';

const ws = (id: string, specs: number, waiting = 0) => ({ id, name: id.toUpperCase(), specs, waiting });

describe('hubTarget', () => {
  it('opens the one workspace that has specs', () => {
    expect(hubTarget([ws('a', 0), ws('b', 4)])).toEqual({ kind: 'redirect', href: '/app/workspaces/b/specs' });
  });

  it('lists several, what waits for approval first, counts in words', () => {
    const t = hubTarget([ws('a', 9), ws('b', 2, 1), ws('c', 0)]);
    if (t.kind !== 'list') throw new Error('expected a list');
    expect(t.workspaces.map((w) => [w.id, w.words])).toEqual([['b', '2 specs, 1 waiting for approval'], ['a', '9 specs']]);
  });

  it('is empty when no workspace has a spec', () => {
    expect(hubTarget([ws('a', 0)])).toEqual({ kind: 'empty' });
    expect(hubTarget([])).toEqual({ kind: 'empty' });
  });

  it('says one spec in the singular', () => {
    expect(hubWords({ specs: 1, waiting: 0 })).toBe('1 spec');
  });
});
