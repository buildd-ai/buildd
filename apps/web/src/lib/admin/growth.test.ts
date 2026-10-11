import { describe, it, expect, mock, beforeEach } from 'bun:test';

const executed: unknown[] = [];
let nextRows: Record<string, unknown>[][] = [];
mock.module('@buildd/core/db', () => ({
  db: {
    execute: async (q: unknown) => { executed.push(q); return { rows: nextRows.shift() ?? [] }; },
  },
}));

const { recordActiveDay, resetActiveDayCache, loadGrowth, utcDay, SERIES_DAYS } = await import('./growth');

const USER = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  resetActiveDayCache();
  executed.length = 0;
  nextRows = [];
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

describe('loadGrowth', () => {
  it('shapes counts, surfaces and the daily series', async () => {
    nextRows = [
      [{
        total_users: '12', new_users_7d: '2', dau_today: '3', dau_web: '2', dau_mcp: '1',
        wau: '5', mau: '8', mau_web: '6', mau_mcp: '3', avg_dau_30d: 2, active_since: '2031-02-01',
      }],
      [
        { day: '2031-03-14', signups: '1', dau: '2', web: '2', mcp: '0' },
        { day: '2031-03-15', signups: '0', dau: '3', web: '2', mcp: '1' },
      ],
    ];
    const g = await loadGrowth({ now: new Date('2031-03-15T12:00:00Z') });
    expect(executed).toHaveLength(2);
    expect(g).toEqual({
      asOf: '2031-03-15',
      totalUsers: 12,
      newUsers7d: 2,
      dauToday: 3,
      wau: 5,
      mau: 8,
      dauMauRatio: 0.25,
      bySurface: { web: { dau: 2, mau: 6 }, mcp: { dau: 1, mau: 3 } },
      activeSince: '2031-02-01',
      days: [
        { day: '2031-03-14', signups: 1, dau: 2, dauWeb: 2, dauMcp: 0 },
        { day: '2031-03-15', signups: 0, dau: 3, dauWeb: 2, dauMcp: 1 },
      ],
    });
  });

  it('has no ratio and no activeSince before anyone is recorded', async () => {
    nextRows = [[{ total_users: '4', mau: '0', avg_dau_30d: 0, active_since: null }], []];
    const g = await loadGrowth();
    expect(g.dauMauRatio).toBeNull();
    expect(g.activeSince).toBeNull();
    expect(g.totalUsers).toBe(4);
    expect(g.days).toEqual([]);
  });

  it('covers a 90-day series', () => {
    expect(SERIES_DAYS).toBe(90);
  });
});
