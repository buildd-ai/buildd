import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

mock.module('@buildd/core/db', () => ({ db: {} }));
const store = new Map<string, unknown>();
let redisUp = true;
mock.module('./redis', () => ({
  setWithTtl: async (k: string, v: unknown) => { if (!redisUp) return false; store.set(k, v); return true; },
  getKey: async (k: string) => (redisUp ? (store.has(k) ? store.get(k) : null) : undefined),
  delKey: async (k: string) => { store.delete(k); },
  markDue: async () => {},
}));

const { recordEvent, taskCompletedEvent } = await import('./subscriptions');
const { clearWatchPending, watchPendingKey, watchPendingState } = await import('./watch-pending');

const USER = '44444444-4444-4444-8444-444444444444';
const TASK = '11111111-1111-4111-8111-111111111111';
const text = (q: SQL) => new PgDialect().sqlToQuery(q).sql.replace(/\s+/g, ' ');

beforeEach(() => { store.clear(); redisUp = true; });

describe('the watch-pending flag', () => {
  it('recordEvent flags the conversation owners of the rows it just wrote', async () => {
    const seen: string[] = [];
    const exec = async (q: SQL) => {
      const s = text(q);
      seen.push(s);
      if (s.startsWith(' insert') || s.includes('insert into "notification_deliveries"')) return { rows: [{ id: 'd-1', subscription_id: 's-1' }] };
      return { rows: [{ userId: USER }] };
    };
    const r = await recordEvent(taskCompletedEvent({ taskId: TASK }), { exec });
    expect(r.recorded).toBe(1);
    expect(seen.some(s => s.includes('s."conversation_id" is not null'))).toBe(true);
    expect(await watchPendingState(USER)).toBe('set');
  });

  it('a duplicate event (no new rows) flags nobody and costs no owner query', async () => {
    const seen: string[] = [];
    await recordEvent(taskCompletedEvent({ taskId: TASK }), { exec: async (q: SQL) => { seen.push(text(q)); return { rows: [] }; } });
    expect(seen).toHaveLength(1);
    expect(await watchPendingState(USER)).toBe('clear');
  });

  it('clear, set, and unknown when Redis is not there', async () => {
    expect(await watchPendingState(USER)).toBe('clear');
    store.set(watchPendingKey(USER), 1);
    expect(await watchPendingState(USER)).toBe('set');
    await clearWatchPending(USER);
    expect(await watchPendingState(USER)).toBe('clear');
    redisUp = false;
    expect(await watchPendingState(USER)).toBe('unknown');
  });
});
