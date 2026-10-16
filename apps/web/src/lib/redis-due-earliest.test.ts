/**
 * `markDueEarliest` (S4a review): a due time is never pushed back by a later write, so a page
 * re-rendered more often than the queue's delay cannot postpone a kernel heal forever. The
 * Upstash client is a fake that keeps a sorted set with Redis's ZADD LT semantics.
 */
import { describe, expect, mock, test } from 'bun:test';

const sets = new Map<string, Map<string, number>>();
const calls: unknown[][] = [];
mock.module('@upstash/redis', () => ({
  Redis: class {
    async zadd(key: string, ...args: unknown[]) {
      calls.push([key, ...args]);
      const opts = (args[0] && typeof args[0] === 'object' && !('member' in (args[0] as object)) ? args.shift() : {}) as { lt?: boolean };
      const set = sets.get(key) ?? sets.set(key, new Map()).get(key)!;
      for (const { score, member } of args as Array<{ score: number; member: string }>) {
        const prev = set.get(member);
        if (opts.lt && prev !== undefined && score >= prev) continue;
        set.set(member, score);
      }
      return 1;
    }
  },
}));
process.env.UPSTASH_REDIS_REST_URL = 'https://fake-due.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
const { markDue, markDueEarliest } = await import('./redis');

describe('markDueEarliest', () => {
  test('sends ZADD LT, so the earliest due time wins and a new member is still added', async () => {
    await markDueEarliest('kernel-heal', 'd1', 1_000);
    await markDueEarliest('kernel-heal', 'd1', 5_000); // a re-render a few seconds later
    await markDueEarliest('kernel-heal', 'd1', 9_000);
    expect(sets.get('buildd:due:kernel-heal')!.get('d1')).toBe(1_000);
    expect(calls.at(-1)).toEqual(['buildd:due:kernel-heal', { lt: true }, { score: 9_000, member: 'd1' }]);
    await markDueEarliest('kernel-heal', 'd1', 500);
    expect(sets.get('buildd:due:kernel-heal')!.get('d1')).toBe(500);
  });

  test('a plain markDue still overwrites (the behaviour the heal queue must not use)', async () => {
    await markDue('other', 'm', 1_000);
    await markDue('other', 'm', 5_000);
    expect(sets.get('buildd:due:other')!.get('m')).toBe(5_000);
  });
});
