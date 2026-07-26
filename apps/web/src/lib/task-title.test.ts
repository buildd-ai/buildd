import { describe, it, expect } from 'bun:test';
import { stripTaskTitlePrefixes, reviewerTitle, reviewerRetryTitle } from './task-title';

describe('stripTaskTitlePrefixes', () => {
  it('returns a plain title unchanged', () => {
    expect(stripTaskTitlePrefixes('Narrow the schema deny-path rule')).toBe('Narrow the schema deny-path rule');
  });

  it('strips a single [reviewer] PR #N: prefix', () => {
    expect(stripTaskTitlePrefixes('[reviewer] PR #1469: Narrow the rule')).toBe('Narrow the rule');
  });

  it('strips a single [reviewer retry #k] prefix', () => {
    expect(stripTaskTitlePrefixes('[reviewer retry #1] Narrow the rule')).toBe('Narrow the rule');
  });

  it('unwinds the stacked monster from the screenshot', () => {
    expect(
      stripTaskTitlePrefixes('[reviewer] PR #1469: [reviewer retry #1] Narrow the schema deny-path rule'),
    ).toBe('Narrow the schema deny-path rule');
  });

  it('handles retry-first ordering too', () => {
    expect(
      stripTaskTitlePrefixes('[reviewer retry #2] [reviewer] PR #42: Do the thing'),
    ).toBe('Do the thing');
  });

  it('handles null/undefined', () => {
    expect(stripTaskTitlePrefixes(null)).toBe('');
    expect(stripTaskTitlePrefixes(undefined)).toBe('');
  });
});

describe('reviewerTitle / reviewerRetryTitle — no stacking', () => {
  it('reviewerTitle wraps a plain title with exactly one prefix', () => {
    expect(reviewerTitle(1469, 'Narrow the rule')).toBe('[reviewer] PR #1469: Narrow the rule');
  });

  it('reviewerTitle does NOT stack on an already-prefixed title', () => {
    expect(reviewerTitle(1469, '[reviewer retry #1] Narrow the rule')).toBe('[reviewer] PR #1469: Narrow the rule');
  });

  it('reviewerRetryTitle does NOT stack on an already-reviewer title', () => {
    expect(reviewerRetryTitle(1, '[reviewer] PR #1469: Narrow the rule')).toBe('[reviewer retry #1] Narrow the rule');
  });

  it('round-trips without growth across repeated wraps', () => {
    let t = 'Narrow the rule';
    t = reviewerTitle(1469, t);
    t = reviewerRetryTitle(1, t);
    t = reviewerTitle(1470, t);
    expect(t).toBe('[reviewer] PR #1470: Narrow the rule');
  });
});
