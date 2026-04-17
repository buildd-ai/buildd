/**
 * Unit tests for the scoped claim circuit breaker.
 *
 * Covers the helpers that decide:
 *   1. Which auth context (account vs tenant:xxx) a task runs under.
 *   2. Which errors should trip a breaker, and whether the scope is global
 *      (affects every claim) or per-context (affects only the failing
 *      account/tenant).
 *   3. The ContextBreaker pause/expiry state machine.
 *
 * The regression this guards against: on 2026-04-16 an OAuth budget
 * exhaustion caused a Pusher → claim loop that burned through the budget
 * in ~20 min because the runner lacked a per-context gate on the
 * Pusher-driven claimAndStart path.
 */

import { describe, test, expect } from 'bun:test';
import { authContextOf, classifyClaimError, ContextBreaker, parseResetDelay } from '../../src/claim-breaker';

describe('authContextOf', () => {
  test('returns "account" when task has no tenant context', () => {
    expect(authContextOf({ context: null } as any)).toBe('account');
    expect(authContextOf({ context: {} } as any)).toBe('account');
    expect(authContextOf({} as any)).toBe('account');
    expect(authContextOf(null)).toBe('account');
    expect(authContextOf(undefined)).toBe('account');
  });

  test('returns "tenant:<id>" when task carries a tenant context', () => {
    const task = { context: { tenantContext: { tenantId: 'tnt_abc123' } } } as any;
    expect(authContextOf(task)).toBe('tenant:tnt_abc123');
  });

  test('falls back to "account" when tenantContext exists without tenantId', () => {
    const task = { context: { tenantContext: {} } } as any;
    expect(authContextOf(task)).toBe('account');
  });
});

describe('classifyClaimError', () => {
  test('Claude quota exhaustion is context-scoped', () => {
    const res = classifyClaimError("you're out of extra usage · resets 2am (utc)");
    expect(res).not.toBeNull();
    expect(res!.scope).toBe('context');
    expect(res!.label).toContain('Quota exhausted');
    expect(res!.pauseMs).toBeGreaterThan(0);
  });

  test('server 429 budget exhausted is context-scoped', () => {
    const res = classifyClaimError('api error: 429 - oauth budget exhausted');
    expect(res).not.toBeNull();
    expect(res!.scope).toBe('context');
    expect(res!.label).toBe('OAuth budget exhausted');
  });

  test('rate limit is global-scoped (API-level, affects everyone)', () => {
    const res = classifyClaimError('rate limit reached');
    expect(res!.scope).toBe('global');
  });

  test('API overload is global-scoped', () => {
    const res = classifyClaimError('529 service unavailable');
    expect(res!.scope).toBe('global');
  });

  test('auth failure is context-scoped (one account/tenant has a bad key)', () => {
    const res = classifyClaimError('invalid api key');
    expect(res!.scope).toBe('context');
    expect(res!.label).toBe('Auth failure');
  });

  test('billing errors are context-scoped', () => {
    const res = classifyClaimError('insufficient credits');
    expect(res!.scope).toBe('context');
  });

  test('SDK max budget is context-scoped', () => {
    const res = classifyClaimError('max budget exceeded');
    expect(res!.scope).toBe('context');
  });

  test('unknown errors return null (no breaker action)', () => {
    expect(classifyClaimError('some weird worker-specific bug')).toBeNull();
    expect(classifyClaimError('econnreset')).toBeNull();
  });
});

describe('parseResetDelay', () => {
  test('returns a bounded, positive duration for a valid time', () => {
    const delay = parseResetDelay('2am');
    expect(delay).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(delay).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  test('handles 12-hour edge cases (12am → 00, 12pm → 12)', () => {
    // Both should return sane bounded delays without throwing
    expect(parseResetDelay('12am')).toBeGreaterThan(0);
    expect(parseResetDelay('12pm')).toBeGreaterThan(0);
  });

  test('returns 1h fallback on unparseable input', () => {
    expect(parseResetDelay('garbage')).toBe(60 * 60 * 1000);
  });
});

describe('ContextBreaker', () => {
  test('is not paused by default', () => {
    const b = new ContextBreaker();
    expect(b.isPaused('account')).toBe(false);
    expect(b.isPaused('tenant:abc')).toBe(false);
  });

  test('pauses only the named context', () => {
    const b = new ContextBreaker();
    const until = Date.now() + 60_000;
    b.pause('account', until);
    expect(b.isPaused('account')).toBe(true);
    expect(b.isPaused('tenant:abc')).toBe(false);
  });

  test('auto-expires once past the deadline', () => {
    const b = new ContextBreaker();
    const start = 1_000_000;
    b.pause('account', start + 60_000);
    expect(b.isPaused('account', start + 30_000)).toBe(true);
    expect(b.isPaused('account', start + 60_000)).toBe(false); // at-deadline = expired
    expect(b.isPaused('account', start + 120_000)).toBe(false);
  });

  test('never shortens an existing longer pause', () => {
    const b = new ContextBreaker();
    const longUntil = Date.now() + 60 * 60 * 1000;
    const shortUntil = Date.now() + 60_000;
    b.pause('account', longUntil);
    b.pause('account', shortUntil); // attempt to shorten
    expect(b.pausedUntil('account')).toBe(longUntil);
  });

  test('extends an existing pause when the new deadline is later', () => {
    const b = new ContextBreaker();
    const shortUntil = Date.now() + 60_000;
    const longUntil = Date.now() + 60 * 60 * 1000;
    b.pause('account', shortUntil);
    b.pause('account', longUntil);
    expect(b.pausedUntil('account')).toBe(longUntil);
  });

  test('clear() removes a pause immediately', () => {
    const b = new ContextBreaker();
    b.pause('account', Date.now() + 60_000);
    b.clear('account');
    expect(b.isPaused('account')).toBe(false);
    expect(b.pausedUntil('account')).toBeNull();
  });

  test('snapshot reflects current paused contexts', () => {
    const b = new ContextBreaker();
    const until = Date.now() + 60_000;
    b.pause('account', until);
    b.pause('tenant:abc', until + 1000);
    expect(b.snapshot()).toEqual({ 'account': until, 'tenant:abc': until + 1000 });
  });
});
