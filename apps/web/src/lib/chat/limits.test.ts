import { describe, it, expect, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));
const { evaluateLimits, startOfLocalDay, CHAT_RATE_LIMIT } = await import('./limits');

const now = new Date('2026-09-26T21:30:00.000Z');

describe('startOfLocalDay', () => {
  it('is local midnight in the team zone, not UTC midnight', () => {
    expect(startOfLocalDay(now, 'UTC').toISOString()).toBe('2026-09-26T00:00:00.000Z');
    expect(startOfLocalDay(now, 'America/New_York').toISOString()).toBe('2026-09-26T04:00:00.000Z');
  });
});

describe('evaluateLimits', () => {
  const base = { now, timeZone: 'UTC', turnsInWindow: 0, spentTodayUsd: 0, dailyBudgetUsd: null };

  it('no cap, few turns ⇒ ok, no warning', () => {
    expect(evaluateLimits(base)).toEqual({ ok: true, budgetWarning: false });
  });

  it('rate limit at 30 turns per 10 minutes', () => {
    expect(evaluateLimits({ ...base, turnsInWindow: CHAT_RATE_LIMIT - 1 }).ok).toBe(true);
    expect(evaluateLimits({ ...base, turnsInWindow: CHAT_RATE_LIMIT })).toMatchObject({ ok: false, reason: 'rate_limited' });
  });

  it('warns at 80% of the daily cap and stops at 100% until local midnight', () => {
    expect(evaluateLimits({ ...base, dailyBudgetUsd: 10, spentTodayUsd: 7.9 })).toEqual({ ok: true, budgetWarning: false });
    expect(evaluateLimits({ ...base, dailyBudgetUsd: 10, spentTodayUsd: 8 })).toEqual({ ok: true, budgetWarning: true });
    const stop = evaluateLimits({ ...base, dailyBudgetUsd: 10, spentTodayUsd: 10 });
    expect(stop).toMatchObject({ ok: false, reason: 'budget_exhausted' });
    // 21:30 UTC → 2.5h to the next UTC midnight
    expect((stop as any).retryAfterSeconds).toBe(2.5 * 3600);
  });
});
