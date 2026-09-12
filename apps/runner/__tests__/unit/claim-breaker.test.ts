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
import {
  authContextOf,
  classifyClaimError,
  ContextBreaker,
  nextContextWake,
  parseResetDelay,
  pausedContextFor,
} from '../../src/claim-breaker';

describe('authContextOf', () => {
  test('returns the account scope when task has no tenant context', () => {
    expect(authContextOf({ context: null } as any)).toBe('account:claude');
    expect(authContextOf({ context: {} } as any)).toBe('account:claude');
    expect(authContextOf({} as any)).toBe('account:claude');
    expect(authContextOf(null)).toBe('account:claude');
    expect(authContextOf(undefined)).toBe('account:claude');
  });

  test('returns the tenant scope when task carries a tenant context', () => {
    const task = { context: { tenantContext: { tenantId: 'tnt_abc123' } } } as any;
    expect(authContextOf(task)).toBe('tenant:tnt_abc123:claude');
  });

  test('falls back to "account" when tenantContext exists without tenantId', () => {
    const task = { context: { tenantContext: {} } } as any;
    expect(authContextOf(task)).toBe('account:claude');
  });

  test('suffixes the backend so one provider\'s wall does not pause the other', () => {
    expect(authContextOf({ backend: 'codex' } as any)).toBe('account:codex');
    expect(authContextOf({ backend: 'claude' } as any)).toBe('account:claude');
  });

  test('an absent backend defaults to claude (matches task.backend || \'claude\')', () => {
    expect(authContextOf({} as any)).toBe('account:claude');
    expect(authContextOf({ backend: undefined } as any)).toBe('account:claude');
    expect(authContextOf(null)).toBe('account:claude');
  });

  test('tenant id still leads, with the backend appended', () => {
    const task = { context: { tenantContext: { tenantId: 'tnt_abc123' } }, backend: 'codex' } as any;
    expect(authContextOf(task)).toBe('tenant:tnt_abc123:codex');
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

  // Regression: 2026-06-25 session-limit storm (3 workers in 10s for one task).
  // classifyClaimError returned null for 'session limit', falling through to the
  // generic rapid-failure path (3 failures → 5-min pause). That allowed workers
  // 2 and 3 to be spawned serially via Pusher TASK_ASSIGNED events before the
  // circuit breaker tripped. Fixed by returning a context-scoped pause immediately.
  describe('OAuth seat session limit (2026-06-25 regression)', () => {
    test('classifies "session limit" as context-scoped', () => {
      const res = classifyClaimError("you've hit your session limit · resets 8:40pm (utc)");
      expect(res).not.toBeNull();
      expect(res!.scope).toBe('context');
      expect(res!.label).toContain('Session limit hit');
    });

    test('parses the reset time from the error string', () => {
      // parseResetDelay uses noon UTC as "now" so "8pm" is always 8 hours away —
      // deterministic regardless of when CI runs.
      const noonUtc = new Date('2026-01-01T12:00:00.000Z');
      const delay = parseResetDelay('8pm', noonUtc);
      expect(delay).toBeGreaterThan(5 * 60 * 1000);

      const res = classifyClaimError("you've hit your session limit · resets 8pm (utc)");
      expect(res).not.toBeNull();
      expect(res!.pauseMs).toBeGreaterThan(0);
    });

    test('"hit your session" variant is also caught', () => {
      const res = classifyClaimError('claude code returned an error result: you hit your session limit');
      expect(res).not.toBeNull();
      expect(res!.scope).toBe('context');
    });

    test('uses 5h default when no reset time is parseable', () => {
      const res = classifyClaimError('hit your session limit');
      expect(res).not.toBeNull();
      expect(res!.pauseMs).toBe(5 * 60 * 60 * 1000);
    });

    test('is detected before generic rate-limit patterns', () => {
      // Ensure session limit is not accidentally caught by a different branch
      // (e.g. 'rate limit') — the specific session-limit case must win so the
      // scope is 'context' (account-only) not 'global' (all claims paused).
      const res = classifyClaimError("you've hit your session limit · resets 3am (utc)");
      expect(res!.scope).toBe('context');
    });
  });

  test('unknown errors return null (no breaker action)', () => {
    expect(classifyClaimError('some weird worker-specific bug')).toBeNull();
    expect(classifyClaimError('econnreset')).toBeNull();
  });

  // Regression: Codex-backed workers hard-failed instead of tripping the
  // breaker, because this function only recognised Claude's session-limit
  // wording. Codex's own quota wall ("You've hit your usage limit ... try
  // again at <time>.") matched none of the existing branches.
  describe('Codex usage/quota wall', () => {
    test('classifies "hit your usage limit" as context-scoped', () => {
      const res = classifyClaimError(
        "you've hit your usage limit. upgrade to pro or try again at 3:45pm.",
      );
      expect(res).not.toBeNull();
      expect(res!.scope).toBe('context');
      expect(res!.label).toContain('Usage limit hit');
    });

    test('parses the "try again at" reset time', () => {
      const res = classifyClaimError(
        "you've hit your usage limit. or try again at 8pm.",
      );
      expect(res).not.toBeNull();
      expect(res!.pauseMs).toBeGreaterThan(0);
    });

    test('uses the 5h default when no reset time is parseable', () => {
      const res = classifyClaimError("you've hit your usage limit.");
      expect(res).not.toBeNull();
      expect(res!.pauseMs).toBe(5 * 60 * 60 * 1000);
    });

    test('is detected before generic rate-limit patterns', () => {
      const res = classifyClaimError(
        "you've hit your usage limit. or try again at 3am.",
      );
      expect(res!.scope).toBe('context');
    });

    test('does not fire on prose that merely mentions a usage limit', () => {
      // Anchored on "hit your usage limit", not the bare noun phrase.
      expect(classifyClaimError('the api enforces a usage limit of 100 req/min')).toBeNull();
    });
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

/**
 * Regression: a Codex worker hit its quota wall with the meridiem spaced off
 * the digits ("try again at 10:58 pm."). The runner's own copy of the reset
 * regex required the meridiem flush against the digits, so it captured
 * "10:58", then stripped the minutes to "10", then resolved a bare hour 10 to
 * 10:00 the next morning — pausing every claim for the auth context for most
 * of a day when the correct answer was the 5-minute floor, because the stated
 * reset had already gone by.
 *
 * These cases assert `pauseMs` exactly. Asserting only that it is positive is
 * how the bug shipped.
 */
describe('reset-time parsing — spaced meridiem', () => {
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  /** Callers lowercase the error before classifying, so these inputs are lowercased too. */
  const codexWall = (resetAt: string) =>
    "you've hit your usage limit. upgrade to pro (https://example.invalid/upgrade) " +
    `and get 3x more usage, or try again at ${resetAt}`;

  test('the incident: a reset that already passed pauses for the floor, not a day', () => {
    // Reset quoted at 22:58 UTC, observed 12 minutes later.
    const res = classifyClaimError(codexWall('10:58 pm.'), new Date('2026-01-14T23:10:00.000Z'));
    expect(res).not.toBeNull();
    expect(res!.scope).toBe('context');
    expect(res!.pauseMs).toBe(5 * MIN);
  });

  test('a reset still ahead pauses exactly until it, minutes included', () => {
    const res = classifyClaimError(codexWall('10:58 pm.'), new Date('2026-01-14T22:00:00.000Z'));
    expect(res!.pauseMs).toBe(58 * MIN);
    expect(res!.label).toContain('10:58 pm');
  });

  test('minutes are not stripped off the Codex wording', () => {
    const res = classifyClaimError(codexWall('3:45 pm.'), new Date('2026-01-14T12:00:00.000Z'));
    expect(res!.pauseMs).toBe(3 * HOUR + 45 * MIN);
  });

  test('spaced session-limit form parses and keeps the reset time in the label', () => {
    const res = classifyClaimError(
      "you've hit your session limit · resets 8:20 pm (utc)",
      new Date('2026-01-14T12:00:00.000Z'),
    );
    expect(res).not.toBeNull();
    expect(res!.scope).toBe('context');
    expect(res!.pauseMs).toBe(8 * HOUR + 20 * MIN);
    expect(res!.label).toContain('8:20 pm');
  });

  test('unspaced session-limit form does not regress', () => {
    const res = classifyClaimError(
      "you've hit your session limit · resets 8:20pm (utc)",
      new Date('2026-01-14T12:00:00.000Z'),
    );
    expect(res!.pauseMs).toBe(8 * HOUR + 20 * MIN);
  });

  test('extra-usage wording with minutes trips a context breaker', () => {
    // Failure shape unique to this branch: the old regex demanded an
    // hours-only clause, so a reset carrying minutes matched nothing and
    // classifyClaimError returned null — no breaker at all, the opposite
    // failure from the over-pausing branches above.
    const res = classifyClaimError(
      "you're out of extra usage · resets 11:20am (utc)",
      new Date('2026-01-14T09:00:00.000Z'),
    );
    expect(res).not.toBeNull();
    expect(res!.scope).toBe('context');
    expect(res!.pauseMs).toBe(2 * HOUR + 20 * MIN);
  });

  test('extra-usage wording reported just after its reset pauses for the floor', () => {
    const res = classifyClaimError(
      "you're out of extra usage · resets 11:20am (utc)",
      new Date('2026-01-14T11:25:00.000Z'),
    );
    expect(res!.pauseMs).toBe(5 * MIN);
  });

  test('session limit reported just after its reset pauses for the floor', () => {
    for (const wording of ['resets 8:20pm (utc)', 'resets 8:20 pm (utc)']) {
      const res = classifyClaimError(
        `you've hit your session limit · ${wording}`,
        new Date('2026-01-14T20:25:00.000Z'),
      );
      expect(res!.pauseMs).toBe(5 * MIN);
    }
  });

  test('stripping the minutes is what made an unspaced reset look past', () => {
    // 8:20pm at 20:05 is 15 min away. Dropping ":20" made it 20:00 — already
    // gone — which then rolled forward to the next day: a ~24h pause.
    const res = classifyClaimError(
      "you've hit your session limit · resets 8:20pm (utc)",
      new Date('2026-01-14T20:05:00.000Z'),
    );
    expect(res!.pauseMs).toBe(15 * MIN);
  });

  test('a timezone we will not guess at falls back to the branch default', () => {
    const res = classifyClaimError(
      "you've hit your session limit · resets 3am (pst)",
      new Date('2026-01-14T12:00:00.000Z'),
    );
    expect(res!.pauseMs).toBe(5 * HOUR);
  });

  test('prose that merely mentions a limit still classifies as null', () => {
    expect(
      classifyClaimError(
        'the docs say the api enforces a usage limit; try again at 10:58 pm if throttled',
        new Date('2026-01-14T12:00:00.000Z'),
      ),
    ).toBeNull();
  });

  // The invariant: whatever branch produces the pause, it may not outlast the
  // reset instant the provider's own text quoted. Branches that never consult
  // the reset clause (billing, auth, rate limit) are bounded by it too.
  test('a flat branch default cannot outlast the reset the text quoted', () => {
    const res = classifyClaimError(
      'insufficient credits — try again at 10:58 pm.',
      new Date('2026-01-14T22:30:00.000Z'),
    );
    expect(res!.label).toBe('Billing error');
    expect(res!.pauseMs).toBe(28 * MIN); // not the branch's flat 1h
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

  test('a Codex wall leaves the same account\'s Claude context claimable', () => {
    const b = new ContextBreaker();
    const now = 1_000_000;
    b.pause('account:codex', now + 11 * 60 * 60 * 1000);
    expect(b.isPaused('account:codex', now)).toBe(true);
    expect(b.isPaused('account:claude', now)).toBe(false);
  });

  test('snapshot() prunes expired entries so a debug view cannot show a phantom pause', () => {
    const b = new ContextBreaker();
    const now = 1_000_000;
    b.pause('account:codex', now - 1);       // already expired
    b.pause('account:claude', now + 60_000); // still in force
    expect(b.snapshot(now)).toEqual({ 'account:claude': now + 60_000 });
    // Pruned from the underlying map, not just filtered from the returned copy.
    expect(b.pausedUntil('account:codex')).toBeNull();
  });
});

describe('nextContextWake', () => {
  test('returns null for an empty snapshot', () => {
    expect(nextContextWake({}, 1_000_000)).toBeNull();
  });

  test('returns null when every pause has already expired', () => {
    const now = 1_000_000;
    expect(nextContextWake({ 'account:claude': now - 1, 'account:codex': now }, now)).toBeNull();
  });

  test('returns the earliest future expiry', () => {
    const now = 1_000_000;
    const soon = now + 60_000;
    const later = now + 11 * 60 * 60 * 1000;
    expect(nextContextWake({ 'account:codex': later, 'tenant:x:claude': soon }, now)).toBe(soon);
    expect(nextContextWake({ 'tenant:x:claude': soon, 'account:codex': later }, now)).toBe(soon);
  });

  test('ignores expired entries when picking the earliest', () => {
    const now = 1_000_000;
    const future = now + 60_000;
    expect(nextContextWake({ 'account:claude': now - 5_000, 'account:codex': future }, now)).toBe(future);
  });
});

describe('pausedContextFor (nudge path)', () => {
  const now = 1_000_000;

  test('skips the nudge when the task\'s own backend key is paused', () => {
    const b = new ContextBreaker();
    b.pause('account:codex', now + 60_000);
    const hit = pausedContextFor(b, { backend: 'codex' } as any, now);
    expect(hit).not.toBeNull();
    expect(hit!.key).toBe('account:codex');
    expect(hit!.until).toBe(now + 60_000);
  });

  test('claims when a sibling backend is paused but the task\'s is not', () => {
    const b = new ContextBreaker();
    b.pause('account:codex', now + 60_000);
    expect(pausedContextFor(b, { backend: 'claude' } as any, now)).toBeNull();
  });

  test('unknown backend fails TOWARD claiming when only one backend is walled', () => {
    const b = new ContextBreaker();
    b.pause('account:codex', now + 60_000);
    // No `backend` on the payload — an older server that does not send it.
    expect(pausedContextFor(b, { id: 't1' } as any, now)).toBeNull();
  });

  test('unknown backend skips only when EVERY backend for the scope is walled', () => {
    const b = new ContextBreaker();
    b.pause('account:codex', now + 120_000);
    b.pause('account:claude', now + 60_000);
    const hit = pausedContextFor(b, { id: 't1' } as any, now);
    expect(hit).not.toBeNull();
    // Reports the soonest recovery of the walled set.
    expect(hit!.until).toBe(now + 60_000);
  });

  test('tenant scope is checked, not the account scope', () => {
    const b = new ContextBreaker();
    b.pause('account:codex', now + 60_000);
    const task = { context: { tenantContext: { tenantId: 'tnt_x' } }, backend: 'codex' } as any;
    expect(pausedContextFor(b, task, now)).toBeNull();
    b.pause('tenant:tnt_x:codex', now + 60_000);
    expect(pausedContextFor(b, task, now)!.key).toBe('tenant:tnt_x:codex');
  });
});
