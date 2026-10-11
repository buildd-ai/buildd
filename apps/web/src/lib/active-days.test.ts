import { describe, it, expect, mock, beforeEach } from 'bun:test';

const executed: unknown[] = [];
mock.module('@buildd/core/db', () => ({
  db: {
    execute: async (q: unknown) => { executed.push(q); return { rows: [] }; },
  },
}));

const { recordActiveDay, resetActiveDayCache, utcDay } = await import('./active-days');

const USER = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  resetActiveDayCache();
  executed.length = 0;
});

describe('utcDay', () => {
  it('is the UTC calendar day, not the local one', () => {
    expect(utcDay(new Date('2031-03-15T23:30:00-05:00'))).toBe('2031-03-16');
    expect(utcDay(new Date('2031-03-15T00:00:00Z'))).toBe('2031-03-15');
  });
});

describe('recordActiveDay', () => {
  it('writes once per person per UTC day', async () => {
    const calls: unknown[] = [];
    const exec = async (q: unknown) => { calls.push(q); };
    const now = new Date('2031-03-15T09:00:00Z');
    expect(await recordActiveDay(USER, 'web', { now, exec })).toBe(true);
    expect(await recordActiveDay(USER, 'mcp', { now: new Date('2031-03-15T20:00:00Z'), exec })).toBe(false);
    expect(await recordActiveDay(OTHER, 'web', { now, exec })).toBe(true);
    expect(await recordActiveDay(USER, 'web', { now: new Date('2031-03-16T00:01:00Z'), exec })).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('records nothing without a person, or for an id that cannot name one', async () => {
    const exec = mock(async () => {});
    expect(await recordActiveDay(null, 'web', { exec })).toBe(false);
    expect(await recordActiveDay(undefined, 'mcp', { exec })).toBe(false);
    expect(await recordActiveDay('', 'web', { exec })).toBe(false);
    expect(await recordActiveDay('not-a-user-id', 'web', { exec })).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('never throws, and retries the day on the next call after a failed write', async () => {
    let fail = true;
    const calls: unknown[] = [];
    const exec = async (q: unknown) => { calls.push(q); if (fail) throw new Error('db down'); };
    const now = new Date('2031-03-15T09:00:00Z');
    expect(await recordActiveDay(USER, 'web', { now, exec })).toBe(false);
    fail = false;
    expect(await recordActiveDay(USER, 'web', { now, exec })).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

