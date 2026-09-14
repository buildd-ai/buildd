import { describe, it, expect } from 'bun:test';
import { stripTaskTitlePrefixes, reviewerTitle, applyRecommendationTitle, formatAttemptTitle } from './task-title';

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

describe('reviewerTitle / formatAttemptTitle(reviewer) — no stacking', () => {
  it('reviewerTitle wraps a plain title with exactly one prefix', () => {
    expect(reviewerTitle(1469, 'Narrow the rule')).toBe('[reviewer] PR #1469: Narrow the rule');
  });

  it('reviewerTitle does NOT stack on an already-prefixed title', () => {
    expect(reviewerTitle(1469, '[reviewer retry #1] Narrow the rule')).toBe('[reviewer] PR #1469: Narrow the rule');
  });

  it('formatAttemptTitle(reviewer) does NOT stack on an already-reviewer title', () => {
    expect(formatAttemptTitle('reviewer', '[reviewer] PR #1469: Narrow the rule', { iteration: 1 })).toBe('[reviewer #1] Narrow the rule');
  });

  it('round-trips without growth across repeated wraps', () => {
    let t = 'Narrow the rule';
    t = reviewerTitle(1469, t); // [reviewer] PR #1469: Narrow the rule
    t = formatAttemptTitle('reviewer', t, { iteration: 1 }); // [reviewer #1] Narrow the rule
    t = reviewerTitle(1470, t); // [reviewer] PR #1470: Narrow the rule
    expect(t).toBe('[reviewer] PR #1470: Narrow the rule');
  });
});

describe('applyRecommendationTitle — no stacking', () => {
  it('wraps a plain title with exactly one prefix', () => {
    expect(applyRecommendationTitle('Narrow the rule')).toBe('[apply recommendation] Narrow the rule');
  });

  it('does NOT stack on an already-reviewer title', () => {
    expect(applyRecommendationTitle('[reviewer] PR #1469: Narrow the rule')).toBe('[apply recommendation] Narrow the rule');
  });

  it('is stripped back to the plain title by stripTaskTitlePrefixes', () => {
    expect(stripTaskTitlePrefixes('[apply recommendation] Narrow the rule')).toBe('Narrow the rule');
  });

  it('does not stack when applied twice', () => {
    let t = applyRecommendationTitle('Narrow the rule');
    t = applyRecommendationTitle(t);
    expect(t).toBe('[apply recommendation] Narrow the rule');
  });
});

describe('formatAttemptTitle — builder and reviewer retries with structured role/reason', () => {
  describe('builder attempts', () => {
    it('formats builder after-review retry #1', () => {
      expect(formatAttemptTitle('builder', 'fix(timeline): duplicate day header', { reason: 'after review', iteration: 1 }))
        .toBe('[builder · after review #1] fix(timeline): duplicate day header');
    });

    it('formats builder after-conflict retry #1', () => {
      expect(formatAttemptTitle('builder', 'fix(timeline): duplicate day header', { reason: 'after conflict', iteration: 1 }))
        .toBe('[builder · after conflict #1] fix(timeline): duplicate day header');
    });

    it('formats builder after-CI retry #1', () => {
      expect(formatAttemptTitle('builder', 'fix(timeline): duplicate day header', { reason: 'after CI', iteration: 1 }))
        .toBe('[builder · after CI #1] fix(timeline): duplicate day header');
    });

    it('increments iteration correctly', () => {
      expect(formatAttemptTitle('builder', 'fix(timeline)', { reason: 'after review', iteration: 2 }))
        .toBe('[builder · after review #2] fix(timeline)');
    });

    it('strips existing builder prefix before recomposing', () => {
      expect(formatAttemptTitle('builder', '[builder · after review #1] fix(timeline)', { reason: 'after conflict', iteration: 2 }))
        .toBe('[builder · after conflict #2] fix(timeline)');
    });

    it('defaults iteration to 1 when omitted', () => {
      expect(formatAttemptTitle('builder', 'fix(timeline)', { reason: 'after review' }))
        .toBe('[builder · after review #1] fix(timeline)');
    });
  });

  describe('reviewer attempts', () => {
    it('formats reviewer #1 for initial review', () => {
      expect(formatAttemptTitle('reviewer', 'fix(timeline)', { iteration: 1 }))
        .toBe('[reviewer #1] fix(timeline)');
    });

    it('formats reviewer #2 for re-review (iteration N)', () => {
      expect(formatAttemptTitle('reviewer', 'fix(timeline)', { iteration: 2 }))
        .toBe('[reviewer #2] fix(timeline)');
    });

    it('ignores reason parameter (reviewer has no reason)', () => {
      expect(formatAttemptTitle('reviewer', 'fix(timeline)', { reason: 'after review', iteration: 2 }))
        .toBe('[reviewer #2] fix(timeline)');
    });

    it('strips existing reviewer prefix before recomposing', () => {
      expect(formatAttemptTitle('reviewer', '[reviewer #1] fix(timeline)', { iteration: 2 }))
        .toBe('[reviewer #2] fix(timeline)');
    });

    it('strips old [reviewer retry #N] format', () => {
      expect(formatAttemptTitle('reviewer', '[reviewer retry #1] fix(timeline)', { iteration: 2 }))
        .toBe('[reviewer #2] fix(timeline)');
    });

    it('defaults iteration to 1 when omitted', () => {
      expect(formatAttemptTitle('reviewer', 'fix(timeline)'))
        .toBe('[reviewer #1] fix(timeline)');
    });
  });

  describe('prefix stripping compatibility', () => {
    it('new builder format is stripped by stripTaskTitlePrefixes', () => {
      expect(stripTaskTitlePrefixes('[builder · after review #1] fix(timeline)'))
        .toBe('fix(timeline)');
    });

    it('new reviewer format is stripped by stripTaskTitlePrefixes', () => {
      expect(stripTaskTitlePrefixes('[reviewer #2] fix(timeline)'))
        .toBe('fix(timeline)');
    });

    it('stacked prefix from multi-iteration review is stripped', () => {
      let t = 'fix(timeline)';
      t = formatAttemptTitle('builder', t, { reason: 'after review', iteration: 1 });
      t = formatAttemptTitle('reviewer', t, { iteration: 1 });
      t = formatAttemptTitle('builder', t, { reason: 'after review', iteration: 2 });
      expect(stripTaskTitlePrefixes(t)).toBe('fix(timeline)');
      expect(t).toBe('[builder · after review #2] fix(timeline)');
    });
  });

  describe('mobile truncation — role visibility at 24 chars', () => {
    it('[builder · after review #1] is 27 chars; role "builder" remains visible when truncated to 24', () => {
      const prefix = '[builder · after review #1]';
      expect(prefix.length).toBeGreaterThan(24);
      expect(prefix.substring(0, 24)).toContain('builder');
    });

    it('[builder · after conflict #1] is 27 chars; role remains visible', () => {
      const prefix = '[builder · after conflict #1]';
      expect(prefix.length).toBeGreaterThan(24);
      expect(prefix.substring(0, 24)).toContain('builder');
    });

    it('[builder · after CI #1] is 21 chars, always fully visible', () => {
      const prefix = '[builder · after CI #1]';
      expect(prefix.length).toBeLessThanOrEqual(24);
    });

    it('[reviewer #2] is 13 chars, always fully visible', () => {
      const prefix = '[reviewer #2]';
      expect(prefix.length).toBeLessThanOrEqual(24);
    });
  });

  describe('old format still works', () => {
    it('stripTaskTitlePrefixes still handles old [CI Retry #N] format', () => {
      expect(stripTaskTitlePrefixes('[CI Retry #1] fix(timeline)'))
        .toBe('fix(timeline)');
    });

    it('stripTaskTitlePrefixes still handles old [Conflict Retry #N] format', () => {
      expect(stripTaskTitlePrefixes('[Conflict Retry #1] fix(timeline)'))
        .toBe('fix(timeline)');
    });

    it('stripTaskTitlePrefixes still handles old [reviewer retry #N] format', () => {
      expect(stripTaskTitlePrefixes('[reviewer retry #1] fix(timeline)'))
        .toBe('fix(timeline)');
    });
  });
});
