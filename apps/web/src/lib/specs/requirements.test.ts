import { describe, expect, it } from 'bun:test';
import { requirementIds, specCriteria } from './requirements';

describe('requirementIds', () => {
  it('finds ids in the forms specs use, first definition wins, fenced code ignored', () => {
    const body = [
      '# Checkout',
      'R-1: Totals are shown in the shopper\'s currency.',
      '- **AC-1** Given EUR, the total reads €.',
      '### D-2 Rates are cached for 15 minutes',
      '1. I-1. A rate is never older than an hour.',
      'R-1: a duplicate, ignored',
      '```', 'R-9: inside code', '```',
      'This mentions R-3 mid-sentence and is not a definition.',
    ].join('\n');
    expect(requirementIds(body).map((r) => [r.id, r.kind, r.line])).toEqual([
      ['R-1', 'requirement', 2], ['AC-1', 'acceptance', 3], ['D-2', 'decision', 4], ['I-1', 'invariant', 5],
    ]);
    expect(requirementIds(body)[1].text).toBe('Given EUR, the total reads €.');
  });
});

describe('specCriteria', () => {
  it('is the requirements and acceptance criteria only: decisions and invariants are context', () => {
    const body = ['R-1: a', '- AC-2: b', '### D-1 c', 'I-1: d', 'R-2: e'].join('\n');
    expect(specCriteria(body).map((r) => r.id)).toEqual(['R-1', 'AC-2', 'R-2']);
    expect(specCriteria('# No ids here\nJust prose.')).toEqual([]);
  });
});
