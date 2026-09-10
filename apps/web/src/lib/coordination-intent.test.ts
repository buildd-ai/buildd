import { describe, it, expect } from 'bun:test';
import { classifyCoordinationIntent, extractPrNumbers, coordinationDedupeKey } from './coordination-intent';

describe('classifyCoordinationIntent', () => {
  // The exact nine titles observed across one mission's blocked heartbeat cycles.
  // All nine describe the same three underlying holding patterns: keep checking
  // (wait/monitor), close the loop out (aggregate), and land it (merge).
  const CASES: Array<[string, ReturnType<typeof classifyCoordinationIntent>]> = [
    ['Wait for token budget reset', 'wait'],
    ['Wait for Claude session budget reset', 'wait'],
    ['Monitor PR review completion', 'wait'],
    ['Monitor review completion and merge PRs', 'merge'],
    ['Aggregate results and evaluate mission completion', 'aggregate'],
    ['Aggregate results & evaluate mission completion', 'aggregate'],
    ['Aggregate results and close mission', 'aggregate'],
    ['Merge approved PRs to dev', 'merge'],
    ['Merge reviewed PRs to dev', 'merge'],
  ];

  for (const [title, expected] of CASES) {
    it(`classifies "${title}" as ${expected}`, () => {
      expect(classifyCoordinationIntent(title)).toBe(expected);
    });
  }

  it('collapses the nine titles into exactly three distinct intents', () => {
    const intents = new Set(CASES.map(([title]) => classifyCoordinationIntent(title)));
    expect(intents.size).toBe(3);
    expect(intents).toEqual(new Set(['wait', 'merge', 'aggregate']));
  });

  it('returns null for a title naming real work', () => {
    expect(classifyCoordinationIntent('Fix login redirect bug')).toBeNull();
    expect(classifyCoordinationIntent('Add schema migration')).toBeNull();
  });

  it('matches verify phrasing', () => {
    expect(classifyCoordinationIntent('Verify the release deployed cleanly')).toBe('verify');
  });
});

describe('extractPrNumbers', () => {
  it('returns an empty array when no PR is named', () => {
    expect(extractPrNumbers('Merge approved PRs to dev')).toEqual([]);
  });

  it('extracts a single PR number', () => {
    expect(extractPrNumbers('Merge PR #2243 to dev')).toEqual([2243]);
  });

  it('extracts and sorts multiple distinct PR numbers', () => {
    expect(extractPrNumbers('Merge #10 and #2 once #10 is green')).toEqual([2, 10]);
  });
});

describe('coordinationDedupeKey', () => {
  it('is identical for two generic steps with the same intent and no named PRs', () => {
    expect(coordinationDedupeKey('wait', [])).toBe(coordinationDedupeKey('wait', []));
  });

  it('differs when a specific PR is named', () => {
    expect(coordinationDedupeKey('merge', [1])).not.toBe(coordinationDedupeKey('merge', [2]));
  });
});
