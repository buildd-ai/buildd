/**
 * The effect timer (effect-timer.ts): an outbox row whose not_before is reached is drained within a
 * tick of it, not at the next unrelated drain or the hourly floor. Redis is a stub; the SQL is read
 * on Postgres by tests/db.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const due = new Map<string, number>();
mock.module('@/lib/redis', () => ({
  markDueEarliest: async (_job: string, member: string, at: number) => { const p = due.get(member); if (p === undefined || at < p) due.set(member, at); },
  clearDue: async (_job: string, members: string | string[]) => { for (const m of [members].flat()) due.delete(m); },
  countDue: async (_job: string, now: number) => [...due.values()].filter((t) => t <= now).length,
  listDue: async (_job: string, now: number, limit: number) => [...due.entries()].filter(([, t]) => t <= now).sort((a, b) => a[1] - b[1]).slice(0, limit).map(([m]) => m),
}));

const { scheduleEffectDrain, runDueEffectDrains, EFFECT_TICK_MS } = await import('./effect-timer');

const T0 = 1_800_000_000_000;
beforeEach(() => due.clear());

const earliest = (ms: number | null) => async () => ({ rows: ms === null ? [] : [{ due_ms: String(ms) }] });

describe('scheduling a delivery\'s next drain', () => {
  test('a pending effect due at T is queued for T', async () => {
    await scheduleEffectDrain('d1', earliest(T0 + 600_000), T0);
    expect(due.get('d1')).toBe(T0 + 600_000);
  });

  test('an effect already due is queued for now, and nothing pending queues nothing', async () => {
    await scheduleEffectDrain('d1', earliest(T0 - 5_000), T0);
    expect(due.get('d1')).toBe(T0);
    await scheduleEffectDrain('d2', earliest(null), T0);
    expect(due.has('d2')).toBe(false);
  });

  test('a failed read never throws: the floor is the backstop', async () => {
    await scheduleEffectDrain('d1', async () => { throw new Error('db down'); }, T0);
    expect(due.has('d1')).toBe(false);
  });
});

describe('the tick', () => {
  test('an effect due at T is drained by the first tick at or after T, and not before', async () => {
    await scheduleEffectDrain('d1', earliest(T0 + 600_000), T0);
    const drained: string[] = [];
    const drain = async (id: string) => { drained.push(id); return null; };
    expect(await runDueEffectDrains({ drain, now: () => T0 + 599_000 })).toMatchObject({ due: 0, drained: 0 });
    expect(drained).toEqual([]);
    // A tick lands within EFFECT_TICK_MS of any due time.
    expect(EFFECT_TICK_MS).toBeLessThanOrEqual(60_000);
    expect(await runDueEffectDrains({ drain, now: () => T0 + 600_000 + EFFECT_TICK_MS })).toMatchObject({ due: 1, drained: 1 });
    expect(drained).toEqual(['d1']);
    expect(due.has('d1')).toBe(false);
  });

  test('a landing completing wakes the next refresh: the woken delivery is queued now and drained by the next tick', async () => {
    // settleLanes made the parked refresh due now; the drain that woke it publishes it.
    await scheduleEffectDrain('waiter', earliest(T0), T0);
    const drained: string[] = [];
    await runDueEffectDrains({ drain: async (id) => { drained.push(id); return null; }, now: () => T0 });
    expect(drained).toEqual(['waiter']);
  });

  test('a delivery not reached before the budget stays queued for the next tick', async () => {
    await scheduleEffectDrain('a', earliest(T0), T0);
    await scheduleEffectDrain('b', earliest(T0), T0);
    let t = T0;
    const r = await runDueEffectDrains({ drain: async () => { t += 20_000; return null; }, now: () => T0, clock: () => t, budgetMs: 10_000 });
    expect(r).toMatchObject({ due: 2, drained: 1, deferred: 1 });
    expect(due.size).toBe(1);
  });

  test('a drain that throws is queued again soon, not lost', async () => {
    await scheduleEffectDrain('a', earliest(T0), T0);
    const r = await runDueEffectDrains({ drain: async () => { throw new Error('boom'); }, now: () => T0 });
    expect(r).toMatchObject({ drained: 0, failed: 1 });
    expect(due.get('a')).toBe(T0 + EFFECT_TICK_MS);
  });
});
