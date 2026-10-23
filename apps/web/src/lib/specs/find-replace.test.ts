import { describe, expect, it } from 'bun:test';
import { applyFindReplace } from './section-revise';

describe('applyFindReplace', () => {
  it('replaces one unique match', () => {
    expect(applyFindReplace('a R-6 b', 'R-6', 'R-7')).toBe('a R-7 b');
  });
  it('refuses missing and ambiguous matches', () => {
    expect(applyFindReplace('a b', 'z', 'y')).toMatchObject({ error: expect.stringContaining('not found') });
    expect(applyFindReplace('a a', 'a', 'y')).toMatchObject({ error: expect.stringContaining('more than once') });
  });
});
