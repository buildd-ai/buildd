/**
 * recordEvent publishes each new ledger row to the away-delivery due-queue, so
 * the gated cron tick knows there is something to look at without asking
 * Postgres (lib/away-delivery.ts).
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));
const marked: Array<[string, string, number]> = [];
let redisThrows = false;
mock.module('./redis', () => ({
  markDue: async (job: string, member: string, dueAt: number) => {
    if (redisThrows) throw new Error('redis down');
    marked.push([job, member, dueAt]);
  },
}));

const { recordEvent, taskCompletedEvent } = await import('./subscriptions');
const { AWAY_QUEUE, COALESCE_MS } = await import('./notify-away-queue');

const now = new Date('2026-09-27T12:00:00.000Z');
const TASK = '11111111-1111-4111-8111-111111111111';

beforeEach(() => { marked.length = 0; redisThrows = false; });

describe('recordEvent -> away due-queue', () => {
  it('marks every newly recorded row due one coalesce window from now', async () => {
    const exec = async () => ({ rows: [{ id: 'd-1', subscription_id: 's-1' }, { id: 'd-2', subscription_id: 's-2' }] });
    const r = await recordEvent(taskCompletedEvent({ taskId: TASK }), { exec, now: () => now });
    expect(r.recorded).toBe(2);
    expect(marked).toEqual([
      [AWAY_QUEUE, 'd-1', now.getTime() + COALESCE_MS],
      [AWAY_QUEUE, 'd-2', now.getTime() + COALESCE_MS],
    ]);
  });

  it('an urgent event is due immediately', async () => {
    const exec = async () => ({ rows: [{ id: 'd-1', subscription_id: 's-1' }] });
    await recordEvent({ ...taskCompletedEvent({ taskId: TASK }), urgency: 'urgent' }, { exec, now: () => now });
    expect(marked[0][2]).toBe(now.getTime());
  });

  it('a duplicate (no new rows) publishes nothing', async () => {
    await recordEvent(taskCompletedEvent({ taskId: TASK }), { exec: async () => ({ rows: [] }), now: () => now });
    expect(marked).toEqual([]);
  });

  it('a Redis failure does not fail the record', async () => {
    redisThrows = true;
    const r = await recordEvent(taskCompletedEvent({ taskId: TASK }), { exec: async () => ({ rows: [{ id: 'd-1' }] }), now: () => now });
    expect(r).toEqual({ recorded: 1 });
  });
});
