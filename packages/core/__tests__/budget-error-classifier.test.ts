import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  isBudgetExhaustionError,
  CODEX_USAGE_LIMIT_PATTERN,
  CLAUDE_SESSION_LIMIT_PATTERN,
} from '../budget-error-classifier';

describe('isBudgetExhaustionError', () => {
  it('detects API-key dollar-budget exhaustion', () => {
    expect(isBudgetExhaustionError('Budget limit exceeded (maxBudgetUsd)')).toBe(true);
    expect(isBudgetExhaustionError('error_max_budget_usd')).toBe(true);
    expect(isBudgetExhaustionError('You are out of extra usage')).toBe(true);
    expect(isBudgetExhaustionError('hit max budget')).toBe(true);
  });

  it('detects OAuth session-limit exhaustion', () => {
    expect(
      isBudgetExhaustionError(
        "Claude Code returned an error result: You've hit your session limit · resets 3am (UTC)",
      ),
    ).toBe(true);
    expect(isBudgetExhaustionError('session limit reached')).toBe(true);
  });

  // Regression: Codex-backed workers hard-failed instead of pausing, because
  // this detector only knew Claude's wording. Codex has no redundant signal
  // (no account/tenant budget columns), so a detector miss here means no
  // backend_pauses row is ever written for Codex — a silent, permanent gap,
  // not just a slow one.
  it('detects the Codex usage/quota wall', () => {
    expect(
      isBudgetExhaustionError(
        "You've hit your usage limit. Upgrade to Pro (https://openai.com/pro) visit " +
        'https://openai.com/pro to purchase more credits or try again at 3:45pm.',
      ),
    ).toBe(true);
  });

  it('does not flag prose that merely discusses usage limits', () => {
    // The anchor is "hit your usage limit", not the bare noun phrase — a
    // worker reading docs or a changelog that mentions usage limits must not
    // trip this detector. Mirrors the prior false-positive incident where a
    // `rate.?limit` scan matched SDK changelog prose inside a read file.
    expect(isBudgetExhaustionError('The API enforces a usage limit of 100 req/min.')).toBe(false);
    expect(isBudgetExhaustionError('See docs/usage-limit-policy.md for details.')).toBe(false);
  });

  it('does not flag unrelated failures', () => {
    expect(isBudgetExhaustionError('Not logged in · Please run /login')).toBe(false);
    expect(isBudgetExhaustionError('git fatal: not a repository')).toBe(false);
    expect(isBudgetExhaustionError('')).toBe(false);
    expect(isBudgetExhaustionError(undefined)).toBe(false);
    expect(isBudgetExhaustionError(null)).toBe(false);
  });
});

// Anti-drift guard: the runner's claim-breaker imports CODEX_USAGE_LIMIT_PATTERN
// directly (rather than re-typing the phrase) so its Codex-quota branch cannot
// silently diverge from what this module treats as exhaustion. If a future
// edit inlines a new literal there instead of importing the constant, this
// test fails.
describe('detector sync across runner call sites', () => {
  it('claim-breaker.ts keys its Codex-quota branch off the shared constant', () => {
    const src = readFileSync('apps/runner/src/claim-breaker.ts', 'utf8');
    expect(src).toContain("from '@buildd/core/budget-error-classifier'");
    expect(src).toContain('CODEX_USAGE_LIMIT_PATTERN');
  });

  it('workers.ts delegates to the shared predicate instead of a hand-rolled list', () => {
    const src = readFileSync('apps/runner/src/workers.ts', 'utf8');
    expect(src).toContain("from '@buildd/core/budget-error-classifier'");
    expect(src).not.toMatch(/errLower\.includes\(['"]budget['"]\)/);
  });

  it('exported pattern constants match what the runner actually keys off', () => {
    expect(CODEX_USAGE_LIMIT_PATTERN).toBe('hit your usage limit');
    expect(CLAUDE_SESSION_LIMIT_PATTERN).toBe('hit your session');
  });
});
