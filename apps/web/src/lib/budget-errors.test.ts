import { describe, it, expect } from 'bun:test';
import { isBudgetExhaustionError, parseResetTime } from './budget-errors';

describe('isBudgetExhaustionError', () => {
  it('detects API-key dollar-budget exhaustion', () => {
    expect(isBudgetExhaustionError('Budget limit exceeded (maxBudgetUsd)')).toBe(true);
    expect(isBudgetExhaustionError('error_max_budget_usd')).toBe(true);
    expect(isBudgetExhaustionError('You are out of extra usage')).toBe(true);
    expect(isBudgetExhaustionError('hit max budget')).toBe(true);
  });

  // Regression: the OAuth seat session cap that stalled a mission mid-run.
  // Previously unmatched, so the account budget was never flagged and the claim
  // route kept handing out Claude tasks that died with "Not logged in".
  it('detects OAuth session-limit exhaustion', () => {
    expect(
      isBudgetExhaustionError(
        "Claude Code returned an error result: You've hit your session limit · resets 3am (UTC)",
      ),
    ).toBe(true);
    expect(isBudgetExhaustionError('session limit reached')).toBe(true);
  });

  it('does not flag unrelated failures', () => {
    expect(isBudgetExhaustionError('Not logged in · Please run /login')).toBe(false);
    expect(isBudgetExhaustionError('git fatal: not a repository')).toBe(false);
    expect(isBudgetExhaustionError('')).toBe(false);
    expect(isBudgetExhaustionError(undefined)).toBe(false);
    expect(isBudgetExhaustionError(null)).toBe(false);
  });
});

describe('parseResetTime', () => {
  it('parses 12-hour reset times into a future UTC Date', () => {
    const reset = parseResetTime('3am');
    expect(reset).toBeInstanceOf(Date);
    expect(reset!.getUTCHours()).toBe(3);
    expect(reset!.getTime()).toBeGreaterThan(Date.now());
  });

  it('returns null for unparseable input', () => {
    expect(parseResetTime('later')).toBeNull();
  });
});
