/**
 * The fast heal's due-queue (kernel-heal.ts, S4a review item 1c): a delivery whose merge was seen
 * but not applied is reconciled on the next per-minute tick, not on the hourly floor. Redis is a
 * stub here; the reconcile it calls is the floor pass (its SQL: reconcile.test.ts, its behaviour on
 * Postgres: tests/db/kernel-pr-projection.test.ts).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const due = new Map<string, number>();
let redisDown = false;
mock.module('@/lib/redis', () => ({
  markDue: async (_job: string, member: string, at: number) => { due.set(member, at); },
  clearDue: async (_job: string, members: string | string[]) => { for (const m of [members].flat()) due.delete(m); },
  countDue: async (_job: string, now: number) => (redisDown ? null : [...due.values()].filter((t) => t <= now).length),
  listDue: async (_job: string, now: number, limit: number) => [...due.entries()].filter(([, t]) => t <= now).sort((a, b) => a[1] - b[1]).slice(0, limit).map(([m]) => m),
}));

const { runDueKernelHeals, scheduleKernelHeal, stillOwedHeal, KERNEL_HEAL_DELAY_MS, KERNEL_HEAL_RETRY_MS } = await import('./kernel-heal');
const render = (q: SQL) => new PgDialect().sqlToQuery(q);

const T0 = 1_800_000_000_000;
beforeEach(() => { due.clear(); redisDown = false; });

describe('the fast heal', () => {
  test('a scheduled delivery is reconciled on the first tick after its delay, with no quiet window, and then cleared', async () => {
    await scheduleKernelHeal('d1', KERNEL_HEAL_DELAY_MS, T0);
    const calls: string[][] = [];
    const reconcile = async (only: string[]) => { calls.push(only); return { checked: only.length, imported: 1, enqueued: 0, errors: 0 }; };
    const none = async () => ({ rows: [] });
    // Too early: nothing is taken.
    expect(await runDueKernelHeals({ reconcile, exec: none, now: () => T0 + 30_000 })).toEqual({ due: 0, healed: null, rescheduled: 0 });
    expect(calls).toEqual([]);
    // Within minutes, not an hour.
    const r = await runDueKernelHeals({ reconcile, exec: none, now: () => T0 + KERNEL_HEAL_DELAY_MS });
    expect(r).toMatchObject({ due: 1, rescheduled: 0 });
    expect(calls).toEqual([['d1']]);
    expect(due.has('d1')).toBe(false);
  });

  test('a delivery that still owes the heal (GitHub failed again) is looked at again, later', async () => {
    await scheduleKernelHeal('d1', 0, T0);
    const owed = async () => ({ rows: [{ id: 'd1' }] });
    const r = await runDueKernelHeals({ reconcile: async () => ({ checked: 1, imported: 0, enqueued: 0, errors: 1 }), exec: owed, now: () => T0 });
    expect(r).toMatchObject({ due: 1, rescheduled: 1 });
    expect(due.get('d1')).toBe(T0 + KERNEL_HEAL_RETRY_MS);
  });

  test('Redis unavailable: nothing is taken (the floor is the backstop), never a throw', async () => {
    redisDown = true;
    expect(await runDueKernelHeals({ reconcile: async () => { throw new Error('must not run'); } })).toBeNull();
  });

  test('stillOwedHeal reads only unapplied merge/close facts newer than the delivery\'s last move, from the last hour', async () => {
    let q: SQL | null = null;
    await stillOwedHeal(['d1'], async (s) => { q = s; return { rows: [] }; }, T0);
    const { sql, params } = render(q!);
    expect(sql).toContain("f.kind = 'pr_closed' AND f.applied_transition_id IS NULL");
    expect(sql).toContain('f.observed_at > COALESCE(d.last_transition_at, d.created_at)');
    expect(sql).toContain("d.authority = 'kernel'");
    expect(params).toContain(new Date(T0 - 60 * 60_000).toISOString());
  });
});
