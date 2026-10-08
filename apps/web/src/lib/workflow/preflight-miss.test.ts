import { describe, expect, test } from 'bun:test';
import { preflightMissOf } from './preflight-miss';
import { failingNames } from './github-facts';

describe('preflightMissOf (§6.10 tier 3, S31)', () => {
  test('a failing No Production Data run is a preflight miss by default', () => {
    expect(preflightMissOf(['Build', 'No Production Data'])).toBe('No Production Data');
  });
  test('a product failure is not', () => {
    expect(preflightMissOf(['Build', 'Unit tests'])).toBeNull();
  });
  test('unknown or empty failures are never a miss', () => {
    expect(preflightMissOf(null)).toBeNull();
    expect(preflightMissOf([])).toBeNull();
  });
  test('a workspace names its own preflight classes (case-insensitive substrings), replacing the default', () => {
    expect(preflightMissOf(['Lint ratchet', 'No Production Data'], ['lint'])).toBe('Lint ratchet');
    expect(preflightMissOf(['No Production Data'], ['lint'])).toBeNull();
    expect(preflightMissOf(['Lint'], [' ', 7])).toBeNull();
  });
});

describe('failingNames', () => {
  test('distinct names of failed or timed-out runs; passing, pending and unnamed rows dropped', () => {
    expect(failingNames([
      { name: 'No Production Data', conclusion: 'failure' },
      { name: 'check', conclusion: 'failure' },
      { name: 'No Production Data', conclusion: 'failure' },
      { name: 'Build', conclusion: 'success' },
      { name: 'Slow', conclusion: 'timed_out' },
      { name: 'Pending', conclusion: null },
      { name: null, conclusion: 'failure' },
    ])).toEqual(['No Production Data', 'check', 'Slow']);
  });
});
