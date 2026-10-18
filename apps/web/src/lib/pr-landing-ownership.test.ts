import { describe, expect, it } from 'bun:test';
import { parseLandingHandoff } from './pr-landing-ownership';

describe('parseLandingHandoff', () => {
  it('a record without a reason reads Merging needs a person, never Landing', () => {
    const h = parseLandingHandoff({ prNumber: 7, headSha: 'abc1234' }, 7);
    expect(h).toMatchObject({ prNumber: 7, headSha: 'abc1234', cause: 'unknown', reason: 'Merging needs a person', at: null });
  });

  it('keeps a stored reason, and refuses another PR or a missing head', () => {
    expect(parseLandingHandoff({ prNumber: 7, headSha: 'abc1234', reason: 'CI is red' }, 7)?.reason).toBe('CI is red');
    expect(parseLandingHandoff({ prNumber: 8, headSha: 'abc1234' }, 7)).toBeNull();
    expect(parseLandingHandoff({ prNumber: 7 }, 7)).toBeNull();
  });
});
