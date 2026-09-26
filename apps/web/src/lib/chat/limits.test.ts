import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

mock.module('@buildd/core/db', () => ({ db: {} }));
const {
  evaluateBudget,
  resolveChatBudgets,
  startOfLocalDay,
  admitTurnSql,
  admitTurn,
  checkChatLimits,
  CHAT_RATE_LIMIT,
  CHAT_RATE_WINDOW_MS,
  DEFAULT_CHAT_DAILY_BUDGET_USD,
  DEFAULT_CHAT_USER_SHARE,
} = await import('./limits');

const now = new Date('2026-09-26T21:30:00.000Z');

describe('startOfLocalDay', () => {
  it('is local midnight in the team zone, not UTC midnight', () => {
    expect(startOfLocalDay(now, 'UTC').toISOString()).toBe('2026-09-26T00:00:00.000Z');
    expect(startOfLocalDay(now, 'America/New_York').toISOString()).toBe('2026-09-26T04:00:00.000Z');
  });
});

describe('resolveChatBudgets', () => {
  it('a team with no budget set gets the default, not unlimited', () => {
    const b = resolveChatBudgets({ dailyBudgetUsd: null, userDailyBudgetUsd: null });
    expect(DEFAULT_CHAT_DAILY_BUDGET_USD).toBeGreaterThan(0);
    expect(b.teamUsd).toBe(DEFAULT_CHAT_DAILY_BUDGET_USD);
    expect(b.teamIsDefault).toBe(true);
  });

  it('each person gets a default share of the team budget', () => {
    expect(DEFAULT_CHAT_USER_SHARE).toBeGreaterThan(0);
    expect(DEFAULT_CHAT_USER_SHARE).toBeLessThan(1);
    expect(resolveChatBudgets({ dailyBudgetUsd: 40, userDailyBudgetUsd: null }).userUsd).toBe(40 * DEFAULT_CHAT_USER_SHARE);
  });

  it('an explicit per-person cap applies, clamped to the team budget', () => {
    expect(resolveChatBudgets({ dailyBudgetUsd: 40, userDailyBudgetUsd: 5 }).userUsd).toBe(5);
    expect(resolveChatBudgets({ dailyBudgetUsd: 40, userDailyBudgetUsd: 100 }).userUsd).toBe(40);
  });

  it('a raised team budget is honoured; an invalid one falls back to the default', () => {
    expect(resolveChatBudgets({ dailyBudgetUsd: 250, userDailyBudgetUsd: null })).toMatchObject({ teamUsd: 250, teamIsDefault: false });
    expect(resolveChatBudgets({ dailyBudgetUsd: -1, userDailyBudgetUsd: null }).teamUsd).toBe(DEFAULT_CHAT_DAILY_BUDGET_USD);
    expect(resolveChatBudgets({ dailyBudgetUsd: Number.NaN, userDailyBudgetUsd: null }).teamUsd).toBe(DEFAULT_CHAT_DAILY_BUDGET_USD);
  });

  it('zero means chat is paused for the day, not unlimited', () => {
    expect(resolveChatBudgets({ dailyBudgetUsd: 0, userDailyBudgetUsd: null })).toMatchObject({ teamUsd: 0, userUsd: 0 });
  });
});

describe('evaluateBudget', () => {
  const budgets = { teamUsd: 10, userUsd: 5, teamIsDefault: false };
  const base = { now, timeZone: 'UTC', teamSpentUsd: 0, userSpentUsd: 0, budgets };

  it('under both caps ⇒ ok, no warning', () => {
    expect(evaluateBudget(base)).toEqual({ ok: true, budgetWarning: false });
  });

  it('warns at 80% of either cap', () => {
    expect(evaluateBudget({ ...base, teamSpentUsd: 8 })).toEqual({ ok: true, budgetWarning: true });
    expect(evaluateBudget({ ...base, userSpentUsd: 4 })).toEqual({ ok: true, budgetWarning: true });
  });

  it('stops at the team cap until local midnight, and says who can raise it', () => {
    const v = evaluateBudget({ ...base, teamSpentUsd: 10, userSpentUsd: 1 });
    expect(v).toMatchObject({ ok: false, reason: 'budget_exhausted', scope: 'team' });
    // 21:30 UTC → 2.5h to the next UTC midnight
    expect((v as any).retryAfterSeconds).toBe(2.5 * 3600);
    expect((v as any).message).toContain('$10.00');
    expect((v as any).message).toMatch(/owner or admin/);
    expect((v as any).message).toMatch(/midnight/);
  });

  it('stops one person at their share while the team still has budget', () => {
    const v = evaluateBudget({ ...base, teamSpentUsd: 6, userSpentUsd: 5 });
    expect(v).toMatchObject({ ok: false, reason: 'budget_exhausted', scope: 'user' });
    expect((v as any).message).toContain('$5.00');
    expect((v as any).message).toMatch(/owner or admin/);
  });

  it('the default budget is named as a default in the message', () => {
    const v = evaluateBudget({ ...base, budgets: { ...budgets, teamIsDefault: true }, teamSpentUsd: 10 });
    expect((v as any).message).toMatch(/default/);
  });
});

describe('admitTurnSql', () => {
  it('is one conditional upsert that returns a row only under the limit', () => {
    const q = new PgDialect().sqlToQuery(admitTurnSql({ userId: 'u-1', now }));
    const text = q.sql.replace(/\s+/g, ' ');
    expect(text).toMatch(/insert into "chat_turn_windows"/i);
    expect(text).toMatch(/on conflict \("user_id"\) do update set/i);
    // The limit check sits in the DO UPDATE's WHERE, evaluated under the row lock.
    expect(text).toMatch(/do update set .* where \(select count\(\*\) from unnest\("chat_turn_windows"\."turn_at"\)/i);
    expect(text).toMatch(/returning/i);
    expect(q.params).toContain('u-1');
    expect(q.params).toContain(CHAT_RATE_LIMIT);
    expect(q.params).toContain(new Date(now.getTime() - CHAT_RATE_WINDOW_MS).toISOString());
  });
});

describe('admitTurn', () => {
  it('admits when the upsert returns a row', async () => {
    const exec = async () => ({ rows: [{ turns: 3 }] });
    expect(await admitTurn({ userId: 'u', now }, { exec })).toEqual({ ok: true });
  });

  it('refuses when no row comes back, with retry-after from the oldest turn in the window', async () => {
    const oldest = new Date(now.getTime() - CHAT_RATE_WINDOW_MS + 90_000);
    let call = 0;
    const exec = async () => (++call === 1 ? { rows: [] } : { rows: [{ oldest: oldest.toISOString() }] });
    expect(await admitTurn({ userId: 'u', now }, { exec })).toEqual({ ok: false, retryAfterSeconds: 90 });
  });

  it('parallel requests: exactly CHAT_RATE_LIMIT are admitted', async () => {
    // Simulates the row lock: each statement sees the previous one's write.
    const turns: number[] = [];
    const exec = async (q: unknown) => {
      if (new PgDialect().sqlToQuery(q as any).sql.includes('min(')) return { rows: [{ oldest: now.toISOString() }] };
      if (turns.length >= CHAT_RATE_LIMIT) return { rows: [] };
      turns.push(1);
      return { rows: [{ turns: turns.length }] };
    };
    const results = await Promise.all(Array.from({ length: 50 }, () => admitTurn({ userId: 'u', now }, { exec })));
    expect(results.filter(r => r.ok)).toHaveLength(CHAT_RATE_LIMIT);
  });
});

describe('checkChatLimits', () => {
  const settings = { dailyBudgetUsd: null, userDailyBudgetUsd: null, timezone: null };

  it('over budget ⇒ refused without consuming a turn', async () => {
    let admitted = 0;
    const v = await checkChatLimits({ teamId: 't', userId: 'u', now, settings }, {
      loadSpend: async () => ({ teamUsd: DEFAULT_CHAT_DAILY_BUDGET_USD, userUsd: 0 }),
      admit: async () => { admitted++; return { ok: true }; },
    });
    expect(v).toMatchObject({ ok: false, reason: 'budget_exhausted', scope: 'team' });
    expect(admitted).toBe(0);
  });

  it('under budget ⇒ admits the turn', async () => {
    let admitted = 0;
    const v = await checkChatLimits({ teamId: 't', userId: 'u', now, settings }, {
      loadSpend: async () => ({ teamUsd: 0, userUsd: 0 }),
      admit: async () => { admitted++; return { ok: true }; },
    });
    expect(v).toEqual({ ok: true, budgetWarning: false });
    expect(admitted).toBe(1);
  });

  it('admission refused ⇒ rate_limited with a message and retry-after', async () => {
    const v = await checkChatLimits({ teamId: 't', userId: 'u', now, settings }, {
      loadSpend: async () => ({ teamUsd: 0, userUsd: 0 }),
      admit: async () => ({ ok: false, retryAfterSeconds: 120 }),
    });
    expect(v).toMatchObject({ ok: false, reason: 'rate_limited', retryAfterSeconds: 120 });
    expect((v as any).message).toContain(String(CHAT_RATE_LIMIT));
    expect((v as any).message).toMatch(/2 minutes/);
  });

  it('the budget day follows the team timezone', async () => {
    let dayStart: Date | null = null;
    await checkChatLimits({ teamId: 't', userId: 'u', now, settings: { ...settings, timezone: 'America/New_York' } }, {
      loadSpend: async (a) => { dayStart = a.dayStart; return { teamUsd: 0, userUsd: 0 }; },
      admit: async () => ({ ok: true }),
    });
    expect(dayStart!.toISOString()).toBe('2026-09-26T04:00:00.000Z');
  });
});
